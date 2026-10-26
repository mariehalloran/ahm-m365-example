targetScope = 'resourceGroup'

@description('The approved root configuration. Keep credentials out of this object.')
param projectConfig object = loadJsonContent('../../monitoring.config.json')
@description('Resolved service-owned files, prepared from root configFile paths by deployment:prepare.')
param serviceConfigs object = {
  exchange: loadJsonContent('../exchange/config.json')
  teams: loadJsonContent('../teams/config.json')
  sharepoint: loadJsonContent('../sharepoint/config.json')
  onedrive: loadJsonContent('../onedrive/config.json')
}
@description('Nonsecret M365/bot/public-client access metadata and Key Vault secret URIs; never private keys, tokens or user caches.')
param serviceAccess object = {}
@secure()
@description('Approved Container Apps native certificate PEMs keyed by service. Supply separately as a protected secure parameter, never in ordinary config/parameter files.')
param serviceCertificates object = {}
param location string = resourceGroup().location
@description('Reuse the already-approved registry/environment without issuing foundation PUTs. They must already exist with this model naming.')
param reuseExistingFoundation bool = false
@description('First deploy false to establish the private registry and identities; then deploy the built image.')
param deployWorkers bool = false
param workerImage string = ''
@description('Separate Microsoft 365 mutation gate; simulation deployments leave this false.')
param enableLiveProbes bool = false
param enableBetaServiceActivity bool = false
@description('The optional Application Insights component created by the health-model deployment.')
param applicationInsightsName string = 'appi-${projectConfig.healthModel.name}'

var modelName = projectConfig.healthModel.name
var services = filter(
  ['exchange', 'teams', 'sharepoint', 'onedrive'],
  service =>
    (projectConfig.services[?service].?enabled ?? false) && !empty(filter(
      items(projectConfig.services[?service].?scenarios ?? {}),
      scenario => scenario.value
    ))
)
var resourceToken = uniqueString(resourceGroup().id, modelName)
var registryName = 'crm365${resourceToken}'
var tags = { workload: modelName, purpose: 'synthetic-worker' }
var useAzureMonitor = (projectConfig.?otel.?enabled ?? false) && (projectConfig.?otel.?destination ?? 'console') == 'azure-monitor'
var useTeamsUser = contains(services, 'teams') && serviceConfigs.teams.mode == 'live' && (serviceConfigs.teams.?teamsAuthentication ?? 'bot') == 'user-delegated' && ((projectConfig.services.teams.scenarios[?'publish-channel-message'] ?? true) || (projectConfig.services.teams.scenarios[?'reply-channel-message'] ?? true))
var teamsCacheContainerName = 'teams-auth'
var teamsCacheBlobName = 'teams-user.msal.json'

resource teamsCache 'Microsoft.Storage/storageAccounts@2025-01-01' = if (useTeamsUser) {
  name: 'stm365${resourceToken}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: { blob: { enabled: true, keyType: 'Account' } }
    }
  }
}

resource teamsBlobService 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = if (useTeamsUser) {
  parent: teamsCache
  name: 'default'
}

resource teamsAuthContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = if (useTeamsUser) {
  parent: teamsBlobService
  name: teamsCacheContainerName
  properties: { publicAccess: 'None' }
}

resource teamsCacheAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (useTeamsUser) {
  name: guid(teamsAuthContainer!.id, identities[indexOf(services, 'teams')].id, 'teams-token-cache')
  scope: teamsAuthContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: identities[indexOf(services, 'teams')].properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' existing = if (useAzureMonitor && !empty(services)) {
  name: applicationInsightsName
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = if (!reuseExistingFoundation) {
  name: registryName
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

resource environment 'Microsoft.App/managedEnvironments@2026-07-01' = if (!reuseExistingFoundation) {
  name: 'cae-${modelName}'
  location: location
  tags: tags
  properties: {
    // Console streaming works without configuring workspace log forwarding.
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

resource reportWriter 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, modelName, 'health-report-writer')
  properties: {
    roleName: '${modelName} health report writer'
    description: 'Publish health reports only; no model administration or Microsoft 365 access.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: ['Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action']
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = [
  for service in services: {
    name: 'uami-${modelName}-${service}'
    location: location
    tags: tags
  }
]

resource models 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = [
  for service in services: {
    name: '${modelName}-${service}'
  }
]

resource reportAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (service, index) in services: {
    name: guid(models[index].id, identities[index].id, reportWriter.id)
    scope: models[index]
    properties: {
      roleDefinitionId: reportWriter.id
      principalId: identities[index].properties.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

resource imagePullAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (service, index) in services: {
    name: guid(registry.id, identities[index].id, 'acr-pull')
    scope: registry
    properties: {
      roleDefinitionId: subscriptionResourceId(
        'Microsoft.Authorization/roleDefinitions',
        '7f951dda-4ed3-4680-a7ca-43fe172d538d'
      )
      principalId: identities[index].properties.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

module workers './worker.bicep' = [
  for (service, index) in services: if (deployWorkers) {
    name: '${service}-worker'
    params: {
      appName: 'm365-${take(resourceToken, 6)}-${service}'
      location: location
      tags: tags
      environmentId: environment.id
      registryServer: registry!.properties.loginServer
      identityResourceId: identities[index].id
      identityClientId: identities[index].properties.clientId
      tenantId: subscription().tenantId
      workerImage: workerImage
      projectConfig: projectConfig
      serviceConfig: serviceConfigs[service]
      serviceAccess: serviceAccess[?service] ?? {}
      teamsCacheAccountUrl: useTeamsUser && service == 'teams' ? teamsCache!.properties.primaryEndpoints.blob : ''
      m365CertificatePem: (serviceAccess[?service].?m365CertificateSource ?? 'key-vault') == 'container-app'
        ? serviceCertificates[service]
        : ''
      enableLiveProbes: enableLiveProbes
      enableBetaServiceActivity: enableBetaServiceActivity
      applicationInsightsConnectionString: useAzureMonitor ? applicationInsights!.properties.ConnectionString : ''
    }
    dependsOn: [reportAssignments, imagePullAssignments, teamsCacheAssignment]
  }
]

output registryName string = registry.name
output registryServer string = registry!.properties.loginServer
output environmentId string = environment.id
output appNames array = [for service in services: 'm365-${take(resourceToken, 6)}-${service}']
output identityIds array = [for (service, index) in services: identities[index].id]
output teamsCacheAccountUrl string = useTeamsUser ? teamsCache!.properties.primaryEndpoints.blob : ''
output teamsCacheContainer string = useTeamsUser ? teamsCacheContainerName : ''
output teamsCacheBlob string = useTeamsUser ? teamsCacheBlobName : ''
output teamsCacheContainerId string = useTeamsUser ? teamsAuthContainer!.id : ''
