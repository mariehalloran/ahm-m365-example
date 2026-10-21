targetScope = 'resourceGroup'

import { serviceDefinitions } from './service-catalog.bicep'

@description('The same project-root configuration consumed by the workers. Supply a private file with projectConfig=@<path>.')
param projectConfig object = loadJsonContent('../../monitoring.config.json')

@description('A region supporting Microsoft.CloudHealth.')
param location string = resourceGroup().location

@description('Optional telemetry workspace name; created only for enabled OTEL services.')
param workspaceName string = 'law-${projectConfig.healthModel.name}'

@description('Optional workspace-backed Application Insights name.')
param applicationInsightsName string = 'appi-${projectConfig.healthModel.name}'

var modelName = projectConfig.healthModel.name
var enabledServices = filter(
  serviceDefinitions,
  service =>
    projectConfig.services[service.service].enabled && projectConfig.services[service.service].scenarios[service.journey]
)
var useOtel = projectConfig.otel.enabled && !empty(enabledServices)
var stepCount = length(flatten(map(enabledServices, service => service.steps)))

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = if (useOtel) {
  name: workspaceName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: -1 }
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
      enableOtel: useOtel
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
output entityCount int = 1 + length(enabledServices) * 4 + stepCount
output relationshipCount int = length(enabledServices) * 3 + stepCount
output journeyCount int = length(enabledServices)
output stepCount int = stepCount
output querySignalCount int = useOtel ? length(enabledServices) * 3 + stepCount * 2 : 0
output workspaceResourceId string = useOtel ? workspace!.id : ''
output workspaceCustomerId string = useOtel ? workspace!.properties.customerId : ''
output applicationInsightsResourceId string = useOtel ? applicationInsights!.id : ''
