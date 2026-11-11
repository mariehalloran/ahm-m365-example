targetScope = 'resourceGroup'

@description('The normalized repository-root monitoring configuration, including generated identity bindings.')
param projectConfig object = loadJsonContent('../../monitoring.config.json')
param location string = projectConfig.deployment.location
param deployCoordinator bool = false
param coordinatorImage string = ''
param configBlobUrl string = ''
param configSha256 string = ''
param deploymentPrincipalId string
@allowed(['User', 'ServicePrincipal'])
param deploymentPrincipalType string = 'User'

var settings = projectConfig.deployment
var modelName = projectConfig.healthModel.name
var tags = { workload: modelName, purpose: 'function-execution' }
var createsFoundation = settings.foundation.mode == 'create'
var coordinator = settings.coordinator
var coordinatorIdentityId = coordinator.?identityResourceId ?? resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', coordinator.identityName)
var registryId = createsFoundation
  ? resourceId('Microsoft.ContainerRegistry/registries', settings.foundation.?registryName ?? '')
  : settings.foundation.registryResourceId
var registryName = last(split(registryId, '/'))
var environmentId = createsFoundation
  ? resourceId('Microsoft.App/managedEnvironments', settings.foundation.?environmentName ?? '')
  : settings.foundation.environmentResourceId
var selected = flatten(map(projectConfig.tenants, tenant => map(
  filter(['exchange', 'teams', 'onedrive', 'sharepoint'], service =>
    (tenant.services[service].?enabled ?? true) && !empty(filter(items(tenant.services[service].scenarios), scenario => scenario.value))),
  service => { tenant: tenant.id, service: service, selection: tenant.services[service] }
)))
var executionIdentityIds = union(map(selected, item => item.selection.identityResourceId), [])
var serviceGrants = union(map(selected, item => { service: item.service, identityId: item.selection.identityResourceId }), [])
var modelServices = union(map(selected, item => item.service), [])
var blobReader = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = if (createsFoundation) {
  name: settings.foundation.?registryName ?? 'unusedregistry'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false, anonymousPullEnabled: false, publicNetworkAccess: 'Enabled' }
}
resource environment 'Microsoft.App/managedEnvironments@2026-07-01' = if (createsFoundation) {
  name: settings.foundation.?environmentName ?? 'unused-environment'
  location: location
  tags: tags
  properties: { workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }] }
}
resource newCoordinatorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = if (empty(coordinator.?identityResourceId ?? '')) {
  name: coordinator.?identityName ?? 'unused'
  location: location
  tags: { workload: modelName, purpose: 'schedule-dispatch' }
}
resource coordinatorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = if (!empty(coordinator.?identityResourceId ?? '')) {
  scope: resourceGroup(split(coordinatorIdentityId, '/')[2], split(coordinatorIdentityId, '/')[4])
  name: last(split(coordinatorIdentityId, '/'))
}
var coordinatorPrincipalId = empty(coordinator.?identityResourceId ?? '') ? newCoordinatorIdentity!.properties.principalId : coordinatorIdentity!.properties.principalId
var coordinatorClientId = empty(coordinator.?identityResourceId ?? '') ? newCoordinatorIdentity!.properties.clientId : coordinatorIdentity!.properties.clientId

resource hostIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: settings.functions.hostIdentityName
  location: location
  tags: tags
}
resource executionIdentities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = [
  for id in executionIdentityIds: {
    scope: resourceGroup(split(id, '/')[2], split(id, '/')[4])
    name: last(split(id, '/'))
  }
]
resource configStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: settings.configurationStorageAccount
}
resource configBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: configStorage
  name: 'default'
}
resource configContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: configBlobService
  name: 'configuration'
}
resource hostConfigReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(configContainer.id, hostIdentity.id, 'configuration-reader')
  scope: configContainer
  properties: { roleDefinitionId: blobReader, principalId: hostIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource coordinatorConfigReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(configContainer.id, coordinatorIdentityId, 'configuration-reader')
  scope: configContainer
  properties: { roleDefinitionId: blobReader, principalId: coordinatorPrincipalId, principalType: 'ServicePrincipal' }
}
resource reportWriter 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, modelName, 'health-report-writer')
  properties: {
    roleName: '${modelName} health report writer'
    description: 'Publish Azure Monitor Health Models reports without administering models or Microsoft 365.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{ actions: ['Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action'], notActions: [], dataActions: [], notDataActions: [] }]
  }
}
resource models 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = [
  for service in modelServices: { name: '${modelName}-${service}' }
]
resource reportAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for grant in serviceGrants: {
    name: guid(models[indexOf(modelServices, grant.service)].id, grant.identityId, reportWriter.id)
    scope: models[indexOf(modelServices, grant.service)]
    properties: {
      roleDefinitionId: reportWriter.id
      principalId: executionIdentities[indexOf(executionIdentityIds, grant.identityId)].properties.principalId
      principalType: 'ServicePrincipal'
    }
  }
]
var annotationGrants = (projectConfig.serviceHealth.enabled) ? union(map(filter(selected, item =>
  (item.selection.execution.?serviceHealth ?? false) || (item.selection.execution.?serviceMessages ?? false)),
  item => { service: item.service, identityId: item.selection.identityResourceId }), []) : []
var annotationServices = union(map(annotationGrants, grant => grant.service), [])
resource annotationWriter 'Microsoft.Authorization/roleDefinitions@2022-04-01' = if (!empty(annotationGrants)) {
  name: guid(resourceGroup().id, modelName, 'service-communications-annotator')
  properties: {
    roleName: '${modelName} service communications annotator'
    description: 'Read supporting entities and append Microsoft 365 service-communications annotations.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{
      actions: [
        'Microsoft.CloudHealth/healthmodels/entities/read'
        'Microsoft.CloudHealth/healthmodels/entities/addDataAnnotation/action'
        'Microsoft.CloudHealth/healthmodels/entities/getDataAnnotations/action'
      ]
      notActions: []
      dataActions: []
      notDataActions: []
    }]
  }
}
resource supportingEntities 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' existing = [
  for service in annotationServices: {
    parent: models[indexOf(modelServices, service)]
    name: '${service}-service-health'
  }
]
resource annotationAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for grant in annotationGrants: {
    name: guid(supportingEntities[indexOf(annotationServices, grant.service)].id, grant.identityId, annotationWriter!.id)
    scope: supportingEntities[indexOf(annotationServices, grant.service)]
    properties: {
      roleDefinitionId: annotationWriter!.id
      principalId: executionIdentities[indexOf(executionIdentityIds, grant.identityId)].properties.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

module functions './functions.bicep' = {
  name: 'durable-lane-execution'
  params: {
    projectConfig: projectConfig
    location: location
    hostIdentityId: hostIdentity.id
    hostClientId: hostIdentity.properties.clientId
    hostPrincipalId: hostIdentity.properties.principalId
    executionIdentityIds: executionIdentityIds
    coordinatorClientId: coordinatorClientId
    configBlobUrl: configBlobUrl
    configSha256: configSha256
    deploymentPrincipalId: deploymentPrincipalId
    deploymentPrincipalType: deploymentPrincipalType
  }
  dependsOn: [hostConfigReader, coordinatorConfigReader]
}
var functionStartUrls = toObject(modelServices, service => service, service => '${functions.outputs.serviceBaseUrls[service]}/api/lanes/start')
module registryPull './registry-pull.bicep' = {
  name: 'coordinator-image-pull'
  scope: resourceGroup(split(registryId, '/')[2], split(registryId, '/')[4])
  params: { registryName: registryName, assignments: [{ identityId: coordinatorIdentityId, principalId: coordinatorPrincipalId }] }
  dependsOn: [registry]
}
module watchdog './watchdog.bicep' = {
  name: 'independent-monitoring-watchdog'
  params: {
    projectConfig: projectConfig
    location: location
    configBlobUrl: configBlobUrl
    configSha256: configSha256
    executionFunctionId: functions.outputs.primaryAppId
    executionFunctionName: functions.outputs.primaryAppName
    coordinatorClientId: coordinatorClientId
  }
}
module operationalAlerts './operational-alerts.bicep' = {
  name: 'independent-operational-alerts'
  params: {
    projectConfig: projectConfig
    executionFunctionId: functions.outputs.primaryAppId
    executionFunctionIds: map(modelServices, service => functions.outputs.serviceAppIds[service])
    watchdogFunctionId: watchdog.outputs.appId
  }
}
module dispatcher './coordinator.bicep' = if (deployCoordinator) {
  name: 'schedule-dispatcher'
  params: {
    appName: coordinator.appName
    location: location
    tags: { workload: modelName, purpose: 'schedule-dispatch' }
    environmentId: environmentId
    registryServer: '${registryName}.azurecr.io'
    identityResourceId: coordinatorIdentityId
    identityClientId: coordinatorClientId
    tenantId: settings.azureTenantId
    image: coordinatorImage
    configBlobUrl: configBlobUrl
    configSha256: configSha256
    functionStartUrls: functionStartUrls
    functionApiClientId: settings.functions.?apiClientId ?? ''
    resources: { cpu: coordinator.cpu, memory: coordinator.memory }
  }
  dependsOn: [environment, registryPull]
}

output functionBaseUrl string = functions.outputs.primaryBaseUrl
output functionBaseUrls object = functions.outputs.serviceBaseUrls
output coordinatorIdentityClientId string = coordinatorClientId
