targetScope = 'resourceGroup'

@description('The single root monitoring configuration. Secrets are references, never values.')
param projectConfig object = loadJsonContent('../../monitoring.config.json')
@secure()
@description('Internal secure input: native certificate PEMs keyed by tenant alias and service.')
param serviceCertificates object = {}
param location string = projectConfig.deployment.location
param deployWorkers bool = false
param workerImage string = ''
param applicationInsightsName string = projectConfig.deployment.?applicationInsightsName ?? 'appi-${projectConfig.healthModel.name}'

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
var modelServices = union(map(workers, worker => worker.service), [])
var useAzureMonitor = (projectConfig.?otel.?enabled ?? false) && (projectConfig.?otel.?destination ?? 'console') == 'azure-monitor'

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' existing = if (useAzureMonitor && !empty(workers)) {
  name: applicationInsightsName
}
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
resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  scope: resourceGroup(split(registryId, '/')[2], split(registryId, '/')[4])
  name: last(split(registryId, '/'))
}
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
module imagePullAssignments './registry-pull.bicep' = {
  name: 'registry-pull'
  scope: resourceGroup(split(registryId, '/')[2], split(registryId, '/')[4])
  params: {
    registryName: registry.name
    assignments: [for (id, index) in identityIds: {
      identityId: id
      principalId: identities[index].properties.principalId
    }]
  }
  dependsOn: [newIdentities, newRegistry]
}
module workerApps './worker.bicep' = [
  for worker in workers: if (deployWorkers) {
    name: 'worker-${worker.tenant}-${worker.service}'
    params: {
      appName: worker.selection.worker.appName
      location: location
      tags: tags
      environmentId: environmentId
      registryServer: registry.properties.loginServer
      identityResourceId: worker.identityId
      identityClientId: identities[indexOf(identityIds, worker.identityId)].properties.clientId
      tenantId: subscription().tenantId
      tenantAlias: worker.tenant
      service: worker.service
      workerImage: workerImage
      projectConfig: projectConfig
      m365CertificatePem: (worker.selection.?access.?m365CertificateSource ?? 'key-vault') == 'container-app'
        ? (serviceCertificates[?worker.tenant][?worker.service] ?? '') : ''
      enableLiveProbes: settings.enableLiveProbes
      enableBetaServiceActivity: settings.enableBetaServiceActivity
      applicationInsightsConnectionString: useAzureMonitor ? applicationInsights!.properties.ConnectionString : ''
    }
    dependsOn: [newEnvironment, newRegistry, newIdentities, reportAssignments, imagePullAssignments]
  }
]

output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output environmentId string = environmentId
output appNames array = map(workers, worker => worker.selection.worker.appName)
output identityIds array = identityIds
