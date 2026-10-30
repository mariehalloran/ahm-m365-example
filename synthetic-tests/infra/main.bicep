targetScope = 'resourceGroup'

@description('The single root monitoring configuration. Secrets are references, never values.')
param projectConfig object = loadJsonContent('../../monitoring.config.json')
@secure()
@description('Internal secure input: native certificate PEMs keyed by tenant alias and service.')
param serviceCertificates object = {}
param location string = projectConfig.deployment.location
param deployWorkers bool = false
param workerServices array = ['exchange', 'teams', 'onedrive']
param workerImage string = ''
param workerConfigBlobUrl string = ''
param workerConfigSha256 string = ''

// A tenant service gets one worker when it is enabled with at least one scenario.
func hostsWorker(selection object) bool =>
  selection.enabled && !empty(filter(items(selection.scenarios), scenario => scenario.value))

func workerIdentityId(worker object, healthModel object) string =>
  worker.?identityResourceId ?? '/subscriptions/${healthModel.subscriptionId}/resourceGroups/${healthModel.resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${worker.?identityName ?? ''}'

var modelName = projectConfig.healthModel.name
var settings = projectConfig.deployment
var workers = flatten(map(
  projectConfig.tenants,
  tenant => map(
    filter(['exchange', 'teams', 'onedrive'], service => hostsWorker(tenant.services[service])),
    service => {
      tenant: tenant.id
      service: service
      selection: tenant.services[service]
      identityId: workerIdentityId(tenant.services[service].worker, projectConfig.healthModel)
    }
  )
))
var tags = { workload: modelName, purpose: 'synthetic-worker' }
var createFoundation = settings.foundation.mode == 'create'
var registryId = createFoundation
  ? resourceId('Microsoft.ContainerRegistry/registries', settings.foundation.registryName)
  : settings.foundation.registryResourceId
var environmentId = createFoundation
  ? resourceId('Microsoft.App/managedEnvironments', settings.foundation.environmentName)
  : settings.foundation.environmentResourceId
var identityIds = union(map(workers, worker => worker.identityId), [])
var newIdentityNames = union(map(
  filter(workers, worker => empty(worker.selection.worker.?identityResourceId ?? '')),
  worker => worker.selection.worker.identityName
), [])
var reportGrants = union(
  map(workers, worker => { service: worker.service, identityId: worker.identityId }),
  []
)
var annotationWorkers = (projectConfig.?serviceHealth.?enabled ?? false)
  ? filter(workers, worker => worker.selection.execution.mode == 'live' && ((worker.selection.execution.?serviceHealth ?? false) || (worker.selection.execution.?serviceMessages ?? false)))
  : []
var annotationGrants = union(map(annotationWorkers, worker => { service: worker.service, identityId: worker.identityId }), [])
var annotationServices = union(map(annotationGrants, grant => grant.service), [])
var modelServices = union(map(workers, worker => worker.service), [])
var logAnalyticsEnabled = projectConfig.logAnalytics.enabled
resource newRegistry 'Microsoft.ContainerRegistry/registries@2025-11-01' = if (createFoundation) {
  name: settings.foundation.registryName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
    roleAssignmentMode: 'LegacyRegistryPermissions'
  }
}
resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = if (!createFoundation) {
  scope: resourceGroup(split(registryId, '/')[2], split(registryId, '/')[4])
  name: last(split(registryId, '/'))
}
// A template that creates a registry must not also declare it as an existing one: ARM rejects the duplicate name.
var registryName = createFoundation ? settings.foundation.registryName : last(split(registryId, '/'))
var registryServer = createFoundation ? newRegistry!.properties.loginServer : registry!.properties.loginServer
resource newEnvironment 'Microsoft.App/managedEnvironments@2026-07-01' = if (createFoundation) {
  name: settings.foundation.environmentName
  location: location
  tags: tags
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}
resource newIdentities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = [
  for name in newIdentityNames: {
    name: name
    location: location
    tags: tags
  }
]
resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = [
  for id in identityIds: {
    scope: resourceGroup(split(id, '/')[2], split(id, '/')[4])
    name: last(split(id, '/'))
  }
]
resource reportWriter 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, modelName, 'health-report-writer')
  properties: {
    roleName: '${modelName} health report writer'
    description: 'Publish health reports only; no model administration or Microsoft 365 access.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{
      actions: ['Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action']
      notActions: []
      dataActions: []
      notDataActions: []
    }]
  }
}
resource models 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = [
  for service in modelServices: {
    name: '${modelName}-${service}'
  }
]
resource reportAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for grant in reportGrants: {
    name: guid(models[indexOf(modelServices, grant.service)].id, grant.identityId, reportWriter.id)
    scope: models[indexOf(modelServices, grant.service)]
    properties: {
      roleDefinitionId: reportWriter.id
      principalId: identities[indexOf(identityIds, grant.identityId)].properties.principalId
      principalType: 'ServicePrincipal'
    }
    dependsOn: [newIdentities]
  }
]
resource annotationWriter 'Microsoft.Authorization/roleDefinitions@2022-04-01' = if (!empty(annotationGrants)) {
  name: guid(resourceGroup().id, modelName, 'service-communications-annotator')
  properties: {
    roleName: '${modelName} service communications annotator'
    description: 'Read and append service communications data annotations only; no model administration or Microsoft 365 access.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{
      actions: [
        'Microsoft.CloudHealth/healthmodels/entities/addDataAnnotation/action'
        'Microsoft.CloudHealth/healthmodels/entities/getDataAnnotations/action'
      ]
      notActions: []
      dataActions: []
      notDataActions: []
    }]
  }
}
resource serviceHealthEntities 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' existing = [
  for service in annotationServices: {
    parent: models[indexOf(modelServices, service)]
    name: '${service}-service-health'
  }
]
resource annotationAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for grant in annotationGrants: {
    name: guid(serviceHealthEntities[indexOf(annotationServices, grant.service)].id, grant.identityId, annotationWriter!.id)
    scope: serviceHealthEntities[indexOf(annotationServices, grant.service)]
    properties: {
      roleDefinitionId: annotationWriter!.id
      principalId: identities[indexOf(identityIds, grant.identityId)].properties.principalId
      principalType: 'ServicePrincipal'
    }
    dependsOn: [newIdentities]
  }
]
resource observationNamespace 'Microsoft.EventHub/namespaces@2024-01-01' existing = if (logAnalyticsEnabled) {
  name: logAnalyticsEnabled ? projectConfig.logAnalytics.eventHubNamespace : 'disabled'
}
resource observationHub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' existing = if (logAnalyticsEnabled) {
  parent: observationNamespace
  name: logAnalyticsEnabled ? projectConfig.logAnalytics.eventHubName : 'disabled'
}
resource observationStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: settings.configurationStorageAccount
}
resource configurationContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  name: '${observationStorage.name}/default/worker-config'
}
resource observationSenders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (id, index) in identityIds: if (logAnalyticsEnabled) {
    name: guid(observationHub!.id, id, 'observation-sender')
    scope: observationHub!
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2b629674-e913-4c01-ae53-ef4638d8f975')
      principalId: identities[index].properties.principalId
      principalType: 'ServicePrincipal'
    }
    dependsOn: [newIdentities]
  }
]
resource configurationReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (id, index) in identityIds: {
    name: guid(configurationContainer.id, id, 'worker-configuration')
    scope: configurationContainer
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
      principalId: identities[index].properties.principalId
      principalType: 'ServicePrincipal'
    }
    dependsOn: [newIdentities]
  }
]
module imagePullAssignments './registry-pull.bicep' = {
  name: 'registry-pull'
  scope: resourceGroup(split(registryId, '/')[2], split(registryId, '/')[4])
  params: {
    registryName: registryName
    assignments: [for (id, index) in identityIds: {
      identityId: id
      principalId: identities[index].properties.principalId
    }]
  }
  dependsOn: [newIdentities, newRegistry]
}
module workerApps './worker.bicep' = [
  for worker in workers: if (deployWorkers && contains(workerServices, worker.service)) {
    name: 'worker-${worker.tenant}-${worker.service}'
    params: {
      appName: worker.selection.worker.appName
      location: location
      tags: tags
      environmentId: environmentId
      registryServer: registryServer
      identityResourceId: worker.identityId
      identityClientId: identities[indexOf(identityIds, worker.identityId)].properties.clientId
      tenantId: subscription().tenantId
      tenantAlias: worker.tenant
      service: worker.service
      workerImage: workerImage
      workerConfigBlobUrl: workerConfigBlobUrl
      workerConfigSha256: workerConfigSha256
      projectConfig: projectConfig
      m365CertificatePem: (worker.selection.?access.?m365CertificateSource ?? 'key-vault') == 'container-app'
        ? (serviceCertificates[?worker.tenant][?worker.service] ?? '') : ''
      enableLiveProbes: settings.enableLiveProbes
      enableBetaServiceActivity: settings.enableBetaServiceActivity
    }
    dependsOn: [newEnvironment, newIdentities, reportAssignments, imagePullAssignments, observationSenders, configurationReaders]
  }
]

output registryName string = registryName
output registryServer string = registryServer
output environmentId string = environmentId
output appNames array = map(workers, worker => worker.selection.worker.appName)
output identityIds array = identityIds
