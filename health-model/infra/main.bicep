targetScope = 'resourceGroup'

import { serviceDefinitions, providerActivityFunctions, ServiceDefinition } from './service-catalog.bicep'
import { plannedServiceDefinitions } from './planned-catalog.bicep'

@description('The same project-root configuration consumed by the workers. Supply a private file with projectConfig=@<path>.')
param projectConfig object = loadJsonContent('../../monitoring.config.json')

@description('A region supporting Microsoft.CloudHealth.')
param location string = resourceGroup().location

@description('Created only when OTEL exports to Azure Monitor.')
param workspaceName string = 'law-${projectConfig.healthModel.name}'
param applicationInsightsName string = 'appi-${projectConfig.healthModel.name}'

@description('Show the documented unimplemented catalog as suppressed Unknown coverage, without enabling runtime scenarios or reports.')
param includePlannedJourneys bool = true

var modelName = projectConfig.healthModel.name
var selectedServices ServiceDefinition[] = map(
  serviceDefinitions,
  service =>
    union(service, {
      journeys: filter(
        service.journeys,
        journey => projectConfig.services[?service.service].?scenarios[?journey.name] ?? false
      )
    })
)
var runtimeServices = filter(
  selectedServices,
  service => (projectConfig.services[?service.service].?enabled ?? false) && !empty(service.journeys)
)
var modelServices ServiceDefinition[] = map(plannedServiceDefinitions, plannedService => {
  service: plannedService.service
  displayName: plannedService.displayName
  journeys: concat(
    flatten(map(filter(runtimeServices, runtime => runtime.service == plannedService.service), runtime => runtime.journeys)),
    includePlannedJourneys ? filter(plannedService.journeys, plannedJourney =>
      empty(filter(flatten(map(runtimeServices, runtime => runtime.journeys)), activeJourney =>
        activeJourney.entityName == plannedJourney.entityName))) : []
  )
})
var enabledServices = filter(modelServices, service => !empty(service.journeys))
var journeys = flatten(map(enabledServices, service => service.journeys))
var stepCount = length(flatten(map(journeys, journey => journey.steps)))
var providerCallCount = reduce(runtimeServices, 0, (count, service) => count + (service.service == 'onedrive' ? 0 : 2 + length(providerActivityFunctions[service.service])))
var useOtel = (projectConfig.?otel.?enabled ?? false) && (projectConfig.?otel.?destination ?? 'console') == 'azure-monitor' && !empty(runtimeServices)

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
      suppressOneDriveRestore: service.service == 'onedrive' && empty(filter(
        projectConfig.services[?'onedrive'].?targets ?? [],
        target => target.?restoreVersion ?? false
      ))
      enableOtel: useOtel && !empty(filter(service.journeys, journey => !(journey.?planned ?? false)))
      workspaceName: workspaceName
      applicationInsightsResourceId: useOtel ? applicationInsights!.id : ''
    }
  }
]

resource nestedModels 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = [
  for service in enabledServices: {
    name: '${modelName}-${service.service}'
  }
]

resource nestedModelReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (service, index) in enabledServices: if (!empty(filter(service.journeys, journey => !(journey.?planned ?? false)))) {
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
      impact: empty(filter(service.journeys, journey => !(journey.?planned ?? false))) ? 'Suppressed' : 'Standard'
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
output entityCount int = 1 + length(enabledServices) * 2 + length(runtimeServices) + length(journeys) + stepCount + providerCallCount
output relationshipCount int = length(enabledServices) + length(runtimeServices) + length(journeys) + stepCount + providerCallCount
output journeyCount int = length(journeys)
output plannedJourneyCount int = length(filter(journeys, journey => journey.?planned ?? false))
output stepCount int = stepCount
output telemetryEnabled bool = useOtel
output workspaceId string = useOtel ? workspace!.id : ''
output applicationInsightsId string = useOtel ? applicationInsights!.id : ''
