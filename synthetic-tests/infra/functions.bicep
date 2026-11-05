targetScope = 'resourceGroup'

param projectConfig object
param location string
param hostIdentityId string
param hostClientId string
param hostPrincipalId string
param executionIdentityIds array
param coordinatorClientId string
param configBlobUrl string
param configSha256 string
param deploymentPrincipalId string
@allowed(['User', 'ServicePrincipal'])
param deploymentPrincipalType string

var settings = projectConfig.deployment.functions
var tags = { workload: projectConfig.healthModel.name, purpose: 'function-execution' }
var logAnalyticsEnabled = projectConfig.logAnalytics.enabled
var serviceSuffix = {
  exchange: 'ex'
  teams: 'tm'
  onedrive: 'od'
  sharepoint: 'sp'
}
var selected = flatten(map(projectConfig.tenants, tenant => map(
  filter(['exchange', 'teams', 'onedrive', 'sharepoint'], service =>
    (tenant.services[service].?enabled ?? true) && !empty(filter(items(tenant.services[service].scenarios), scenario => scenario.value))),
  service => { service: service, selection: tenant.services[service] }
)))
var selectedServices = union(map(selected, item => item.service), [])
var serviceExecutionIdentityIds = {
  exchange: union(map(filter(selected, item => item.service == 'exchange'), item => item.selection.identityResourceId), [])
  teams: union(map(filter(selected, item => item.service == 'teams'), item => item.selection.identityResourceId), [])
  onedrive: union(map(filter(selected, item => item.service == 'onedrive'), item => item.selection.identityResourceId), [])
  sharepoint: union(map(filter(selected, item => item.service == 'sharepoint'), item => item.selection.identityResourceId), [])
}
var teamsBotIdentityIds = union(flatten(map(filter(selected, item => item.service == 'teams'), item =>
  flatten(map(item.selection.botPairs, pair => [pair.identityResourceId, pair.botPeerManagedIdentityResourceId])))), [])
var serviceAssignedIdentityIds = {
  exchange: serviceExecutionIdentityIds.exchange
  teams: union(serviceExecutionIdentityIds.teams, teamsBotIdentityIds)
  onedrive: serviceExecutionIdentityIds.onedrive
  sharepoint: serviceExecutionIdentityIds.sharepoint
}
var selections = map(selected, item => item.selection.execution)
var intervals = flatten(map(selections, execution => concat(
  [execution.intervalSeconds, execution.providerIntervalSeconds],
  map(execution.?executionLanes ?? [], lane => lane.intervalSeconds))))
var maximumSlotSeconds = max(concat([60], intervals))
var hostTimeout = '${maximumSlotSeconds / 86400}.${padLeft(string(maximumSlotSeconds % 86400 / 3600), 2, '0')}:${padLeft(string(maximumSlotSeconds % 3600 / 60), 2, '0')}:${padLeft(string(maximumSlotSeconds % 60), 2, '0')}'
var blobContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var metricsPublisher = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
var serviceBaseAppName = take(settings.appName, 57)
var serviceAppNames = {
  exchange: '${serviceBaseAppName}-${serviceSuffix.exchange}'
  teams: '${serviceBaseAppName}-${serviceSuffix.teams}'
  onedrive: '${serviceBaseAppName}-${serviceSuffix.onedrive}'
  sharepoint: '${serviceBaseAppName}-${serviceSuffix.sharepoint}'
}
var serviceHubNames = {
  exchange: 'M365${take(replace('${projectConfig.healthModel.name}-exchange', '-', ''), 36)}'
  teams: 'M365${take(replace('${projectConfig.healthModel.name}-teams', '-', ''), 36)}'
  onedrive: 'M365${take(replace('${projectConfig.healthModel.name}-onedrive', '-', ''), 36)}'
  sharepoint: 'M365${take(replace('${projectConfig.healthModel.name}-sharepoint', '-', ''), 36)}'
}
var primaryService = contains(selectedServices, 'exchange') ? 'exchange'
  : contains(selectedServices, 'teams') ? 'teams'
  : contains(selectedServices, 'onedrive') ? 'onedrive'
  : 'sharepoint'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: settings.storageAccount
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
  }
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {}
}
resource packages 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'function-packages'
  properties: { publicAccess: 'None' }
}
resource state 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'execution-state'
  properties: { publicAccess: 'None' }
}
resource hostRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for role in [
    'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
    '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
    '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
  ]: {
    name: guid(storage.id, hostIdentityId, role)
    scope: storage
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role)
      principalId: hostPrincipalId
      principalType: 'ServicePrincipal'
    }
  }
]
resource executionIdentities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = [
  for id in executionIdentityIds: {
    scope: resourceGroup(split(id, '/')[2], split(id, '/')[4])
    name: last(split(id, '/'))
  }
]
resource callStateWriters 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (id, index) in executionIdentityIds: {
    name: guid(state.id, id, 'execution-state-writer')
    scope: state
    properties: { roleDefinitionId: blobContributor, principalId: executionIdentities[index].properties.principalId, principalType: 'ServicePrincipal' }
  }
]
resource deploymentStateReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(state.id, deploymentPrincipalId, 'execution-verification')
  scope: state
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
    principalId: deploymentPrincipalId
    principalType: deploymentPrincipalType
  }
}
resource endpoint 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' existing = if (logAnalyticsEnabled) {
  name: logAnalyticsEnabled ? projectConfig.logAnalytics.dataCollectionEndpointName : 'disabled'
}
resource rule 'Microsoft.Insights/dataCollectionRules@2024-03-11' existing = if (logAnalyticsEnabled) {
  name: logAnalyticsEnabled ? projectConfig.logAnalytics.dataCollectionRuleName : 'disabled'
}
resource insights 'Microsoft.Insights/components@2020-02-02' existing = if (logAnalyticsEnabled) {
  name: projectConfig.deployment.?applicationInsightsName ?? 'appi-${projectConfig.healthModel.name}'
}
resource diagnosticWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (logAnalyticsEnabled) {
  name: guid(insights!.id, hostIdentityId, 'execution-function-diagnostics')
  scope: insights!
  properties: { roleDefinitionId: metricsPublisher, principalId: hostPrincipalId, principalType: 'ServicePrincipal' }
}
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${take(settings.appName, 35)}-plan'
  location: location
  tags: tags
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}
resource serviceFunctions 'Microsoft.Web/sites@2024-04-01' = [
  for service in selectedServices: {
    name: serviceAppNames[service]
    location: location
    tags: tags
    kind: 'functionapp,linux'
    identity: {
      type: 'UserAssigned'
      userAssignedIdentities: toObject(union([hostIdentityId], serviceAssignedIdentityIds[service]), id => id, id => {})
    }
    properties: {
      serverFarmId: plan.id
      httpsOnly: true
      publicNetworkAccess: 'Enabled'
      functionAppConfig: {
        runtime: { name: 'node', version: '22' }
        deployment: {
          storage: {
            type: 'blobContainer'
            value: '${storage.properties.primaryEndpoints.blob}function-packages'
            authentication: { type: 'UserAssignedIdentity', userAssignedIdentityResourceId: hostIdentityId }
          }
        }
        scaleAndConcurrency: { instanceMemoryMB: 2048, maximumInstanceCount: 500 }
      }
      siteConfig: {
        minTlsVersion: '1.2'
        scmMinTlsVersion: '1.2'
        ftpsState: 'Disabled'
        appSettings: concat([
          { name: 'AzureWebJobsStorage__accountName', value: storage.name }
          { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
          { name: 'AzureWebJobsStorage__clientId', value: hostClientId }
          { name: 'AZURE_CLIENT_ID', value: hostClientId }
          { name: 'AZURE_TENANT_ID', value: projectConfig.deployment.azureTenantId }
          { name: 'FUNCTION_STORAGE_ACCOUNT', value: storage.name }
          { name: 'FUNCTION_APP_NAME', value: serviceAppNames[service] }
          { name: 'MONITORING_SERVICE', value: service }
          { name: 'FUNCTION_API_CLIENT_ID', value: settings.?apiClientId ?? '' }
          { name: 'COORDINATOR_CLIENT_ID', value: coordinatorClientId }
          { name: 'MONITORING_CONFIG_BLOB_URL', value: configBlobUrl }
          { name: 'MONITORING_CONFIG_SHA256', value: configSha256 }
          { name: 'ENABLE_LIVE_M365', value: projectConfig.deployment.enableLiveProbes ? 'true' : 'false' }
          { name: 'ENABLE_BETA_SERVICE_ACTIVITY', value: projectConfig.deployment.enableBetaServiceActivity ? 'true' : 'false' }
          { name: 'AzureFunctionsJobHost__functionTimeout', value: hostTimeout }
          { name: 'AzureFunctionsJobHost__extensions__durableTask__hubName', value: serviceHubNames[service] }
          { name: 'FUNCTIONS_REQUEST_BODY_SIZE_LIMIT', value: '65536' }
          { name: 'WATCHDOG_CRON', value: '0 */${settings.watchdogIntervalSeconds / 60} * * * *' }
          { name: 'AzureWebJobs.monitoringWatchdog.Disabled', value: 'true' }
          { name: 'AzureWebJobs.teamsCallingCallback.Disabled', value: service == 'teams' ? 'false' : 'true' }
        ], logAnalyticsEnabled ? [
          { name: 'LOGS_INGESTION_ENDPOINT', value: endpoint!.properties.logsIngestion.endpoint }
          { name: 'LOGS_DCR_IMMUTABLE_ID', value: rule!.properties.immutableId }
          { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights!.properties.ConnectionString }
          { name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING', value: 'Authorization=AAD;ClientId=${hostClientId}' }
        ] : [])
      }
    }
    dependsOn: [hostRoles, packages, callStateWriters]
  }
]
resource authentications 'Microsoft.Web/sites/config@2024-04-01' = [
  for (service, index) in selectedServices: {
    parent: serviceFunctions[index]
    name: 'authsettingsV2'
    properties: {
      platform: { enabled: true, runtimeVersion: '~1' }
      globalValidation: {
        requireAuthentication: true
        unauthenticatedClientAction: 'Return401'
        excludedPaths: service == 'teams' ? ['/api/calls/*', '/api/about'] : ['/api/about']
      }
      identityProviders: {
        azureActiveDirectory: {
          enabled: true
          registration: {
            clientId: settings.?apiClientId ?? ''
            openIdIssuer: '${environment().authentication.loginEndpoint}${projectConfig.deployment.azureTenantId}/v2.0'
          }
          validation: {
            allowedAudiences: [settings.?apiClientId ?? '']
            defaultAuthorizationPolicy: { allowedApplications: [coordinatorClientId] }
          }
        }
      }
      login: { tokenStore: { enabled: false } }
      httpSettings: { requireHttps: true }
    }
  }
]
resource scmBasicAuthentications 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = [
  for (service, index) in selectedServices: {
    parent: serviceFunctions[index]
    name: 'scm'
    properties: { allow: false }
  }
]
resource ftpBasicAuthentications 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = [
  for (service, index) in selectedServices: {
    parent: serviceFunctions[index]
    name: 'ftp'
    properties: { allow: false }
  }
]

var serviceOutputs = [for (service, index) in selectedServices: {
  service: service
  baseUrl: 'https://${serviceAppNames[service]}.azurewebsites.net'
  appId: serviceFunctions[index].id
  appName: serviceAppNames[service]
}]
var serviceBaseUrls = toObject(serviceOutputs, item => item.service, item => item.baseUrl)
var serviceAppIds = toObject(serviceOutputs, item => item.service, item => item.appId)

output serviceBaseUrls object = serviceBaseUrls
output serviceAppIds object = serviceAppIds
output serviceAppNames object = toObject(serviceOutputs, item => item.service, item => item.appName)
output primaryService string = primaryService
output primaryBaseUrl string = serviceBaseUrls[primaryService]
output primaryAppId string = serviceAppIds[primaryService]
output primaryAppName string = serviceAppNames[primaryService]
