targetScope = 'resourceGroup'

import { serviceDefinitions, ServiceDefinition, getJourneyGroups } from './service-catalog.bicep'

@description('The root monitoring.config.json as normalized by `npm run deploy`, which also supplies reportingGroups.')
param projectConfig object = loadJsonContent('../../monitoring.config.json')

@description('Reporting groups from `npm run deploy`: [{ id, displayName, scopes: [{ tenant, service, journeys }] }].')
param reportingGroups array = []

@description('A region supporting Microsoft.CloudHealth.')
param location string = resourceGroup().location

@description('Created only when OTEL exports to Azure Monitor.')
param workspaceName string = 'law-${projectConfig.healthModel.name}'
param applicationInsightsName string = 'appi-${projectConfig.healthModel.name}'

// A tenant runs a journey when it enables the service and the scenario.
func runsJourney(tenant object, service string, journey string) bool =>
  (tenant.services[?service].?enabled ?? false) && (tenant.services[?service].?scenarios[?journey] ?? false)

// A journey is modeled when any tenant runs it.
func isJourneySelected(tenants array, service string, journey string) bool =>
  !empty(filter(tenants, tenant => runsJourney(tenant, service, journey)))

var modelName = projectConfig.healthModel.name
var enableServiceHealth = projectConfig.?serviceHealth.?enabled ?? false
var selectedServices ServiceDefinition[] = map(
  serviceDefinitions,
  service =>
    union(service, {
      journeys: filter(
        service.journeys,
        journey => isJourneySelected(projectConfig.tenants, service.service, journey.name)
      )
    })
)
var enabledServices = filter(selectedServices, service => !empty(service.journeys))
var journeys = flatten(map(enabledServices, service => service.journeys))
var journeyGroupCount = length(getJourneyGroups(journeys))
var stepCount = length(flatten(map(journeys, journey => journey.steps)))
var serviceHealthCount = enableServiceHealth ? length(enabledServices) : 0
var useOtel = (projectConfig.?otel.?enabled ?? false) && (projectConfig.?otel.?destination ?? 'console') == 'azure-monitor' && !empty(enabledServices)

// Saved searches that show administrators which users, in which reporting group, hit which errors.
var adminSearches = [
  {
    name: 'failures-by-group'
    displayName: 'Synthetic failures by group and user'
    query: loadTextContent('../queries/admin/failures-by-group.kql')
  }
  {
    name: 'impacted-users-by-group'
    displayName: 'Impacted users by group'
    query: loadTextContent('../queries/admin/impacted-users-by-group.kql')
  }
  {
    name: 'success-by-group'
    displayName: 'Success rate by group and journey'
    query: loadTextContent('../queries/admin/success-by-group.kql')
  }
]

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = if (useOtel) {
  name: workspaceName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: {
      disableLocalAuth: true
      enableLogAccessUsingOnlyResourcePermissions: false
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource savedSearches 'Microsoft.OperationalInsights/workspaces/savedSearches@2020-08-01' = [
  for search in adminSearches: if (useOtel) {
    parent: workspace
    name: search.name
    properties: {
      category: 'M365 Synthetic Monitoring'
      displayName: search.displayName
      query: search.query
      version: 2
    }
  }
]

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = if (useOtel) {
  name: applicationInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace!.id
    IngestionMode: 'LogAnalytics'
    SamplingPercentage: 100
    DisableLocalAuth: false
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' = {
  name: modelName
  location: location
  identity: { type: 'SystemAssigned' }
  tags: {
    purpose: 'Microsoft 365 synthetic monitoring proof of concept'
    deploymentStage: 'federated-direct-reports-optional-otel'
    intendedRunnerHost: 'Azure Container Apps'
  }
  properties: {}
}

module serviceModels './service.bicep' = [
  for service in enabledServices: {
    name: '${service.service}-health-model'
    params: {
      modelName: '${modelName}-${service.service}'
      location: location
      service: service
      policy: projectConfig.healthModel
      enableServiceHealth: enableServiceHealth
      suppressOneDriveRestore: service.service == 'onedrive' && empty(filter(
        flatten(map(projectConfig.tenants, tenant => tenant.services.?onedrive.?targets ?? [])),
        target => target.?restoreVersion ?? false
      ))
      enableOtel: useOtel
      workspaceName: workspaceName
      applicationInsightsResourceId: useOtel ? applicationInsights!.id : ''
      reportingGroups: filter(
        reportingGroups,
        group => !empty(filter(group.scopes, scope => scope.service == service.service))
      )
    }
  }
]

resource nestedModels 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = [
  for service in enabledServices: {
    name: '${modelName}-${service.service}'
  }
]

resource nestedModelReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (service, index) in enabledServices: {
    name: guid(nestedModels[index].id, model.id, 'nested-model-reader')
    scope: nestedModels[index]
    properties: {
      roleDefinitionId: subscriptionResourceId(
        'Microsoft.Authorization/roleDefinitions',
        'acdd72a7-3385-48ef-bd42-f606fba81ae7'
      )
      principalId: model.identity.principalId
      principalType: 'ServicePrincipal'
    }
    dependsOn: [serviceModels]
  }
]

resource nestedAuthentication 'Microsoft.CloudHealth/healthmodels/authenticationsettings@2026-05-01-preview' = if (!empty(enabledServices)) {
  parent: model
  name: 'nested-models'
  properties: {
    displayName: 'Root identity reading service-model health'
    authenticationKind: 'ManagedIdentity'
    managedIdentityName: 'SystemAssigned'
  }
}

resource rootEntity 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = {
  parent: model
  name: modelName
  properties: {
    displayName: 'Microsoft 365 Experience'
    impact: 'Standard'
    canvasPosition: { x: 500, y: 0 }
    signalGroups: {
      dependencies: { aggregationType: 'WorstOf', ignoreUnknown: false }
    }
  }
}

resource serviceReferences 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = [
  for (service, index) in enabledServices: {
    parent: model
    name: '${service.service}-experience'
    properties: {
      displayName: service.displayName
      impact: 'Standard'
      canvasPosition: { x: index * 400, y: 250 }
      signalGroups: {
        azureResource: {
          azureResourceId: nestedModels[index].id
          authenticationSetting: nestedAuthentication!.name
          signals: []
        }
      }
    }
    dependsOn: [nestedModelReaders]
  }
]

resource relationships 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = [
  for service in enabledServices: {
    parent: model
    name: '${modelName}-to-${service.service}'
    properties: {
      parentEntityName: rootEntity.name
      childEntityName: '${service.service}-experience'
    }
    dependsOn: [serviceReferences]
  }
]

output modelId string = model.id
output modelName string = model.name
output rootEntityName string = rootEntity.name
output apiVersion string = '2026-05-01-preview'
output serviceModelIds array = [
  for service in enabledServices: resourceId('Microsoft.CloudHealth/healthmodels', '${modelName}-${service.service}')
]
output serviceNames array = [for service in enabledServices: service.service]
output modelCount int = 1 + length(enabledServices)
output entityCount int = 1 + length(enabledServices) * 2 + serviceHealthCount + journeyGroupCount + length(journeys) + stepCount
output relationshipCount int = length(enabledServices) + serviceHealthCount + journeyGroupCount + length(journeys) + stepCount
output journeyCount int = length(journeys)
output stepCount int = stepCount
output telemetryEnabled bool = useOtel
output workspaceId string = useOtel ? workspace!.id : ''
output applicationInsightsId string = useOtel ? applicationInsights!.id : ''
output rootEntityNames array = concat([modelName], map(enabledServices, service => '${service.service}-experience'))
output rootRelationshipNames array = [for service in enabledServices: '${modelName}-to-${service.service}']
output serviceModelInventories array = [
  for (service, index) in enabledServices: {
    service: service.service
    modelId: serviceModels[index].outputs.modelId
    entityNames: serviceModels[index].outputs.entityNames
    relationshipNames: serviceModels[index].outputs.relationshipNames
  }
]
