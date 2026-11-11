targetScope = 'resourceGroup'

param projectConfig object
param location string
param configBlobUrl string
param configSha256 string
param executionFunctionId string
param executionFunctionName string
param coordinatorClientId string

var settings = projectConfig.deployment.functions
var appName = '${take(settings.appName, 54)}-watch'
var tags = { workload: projectConfig.healthModel.name, purpose: 'monitoring-watchdog' }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${take(settings.hostIdentityName, 122)}-watch'
  location: location
  tags: tags
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: settings.storageAccount }
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}
resource packages 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: blobs
  name: 'function-packages'
}
resource configStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: projectConfig.deployment.configurationStorageAccount }
resource configBlobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: configStorage
  name: 'default'
}
resource configContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: configBlobs
  name: 'configuration'
}
resource configReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(configContainer.id, identity.id, 'watchdog-config')
  scope: configContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource hostRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for role in ['b7e6dc6d-f1e8-4753-8033-0f276bb0955b', '974c5e8b-45b9-4653-ba55-5f855dd0fb88', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3']: {
    name: guid(storage.id, identity.id, role)
    scope: storage
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role)
      principalId: identity.properties.principalId
      principalType: 'ServicePrincipal'
    }
  }
]
resource executionFunction 'Microsoft.Web/sites@2024-04-01' existing = { name: last(split(executionFunctionId, '/')) }
resource metricsWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(executionFunction.id, identity.id, 'watchdog-metrics')
  scope: executionFunction
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource insights 'Microsoft.Insights/components@2020-02-02' existing = if (projectConfig.logAnalytics.enabled) {
  name: projectConfig.deployment.?applicationInsightsName ?? 'appi-${projectConfig.healthModel.name}'
}
resource diagnosticWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (projectConfig.logAnalytics.enabled) {
  name: guid(insights!.id, identity.id, 'watchdog-diagnostics')
  scope: insights!
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${take(appName, 28)}-watch-plan'
  location: location
  tags: tags
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}
resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: appName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
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
          authentication: { type: 'UserAssignedIdentity', userAssignedIdentityResourceId: identity.id }
        }
      }
      scaleAndConcurrency: { instanceMemoryMB: 512, maximumInstanceCount: 40 }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: concat([
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'AzureWebJobsStorage__clientId', value: identity.properties.clientId }
        { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
        { name: 'AZURE_TENANT_ID', value: projectConfig.deployment.azureTenantId }
        { name: 'MONITORING_CONFIG_BLOB_URL', value: configBlobUrl }
        { name: 'MONITORING_CONFIG_SHA256', value: configSha256 }
        { name: 'FUNCTION_APP_NAME', value: appName }
        { name: 'EXECUTION_METRICS_APP_NAME', value: executionFunctionName }
        { name: 'MONITORING_ROLE', value: 'watchdog' }
        { name: 'DURABLE_TASK_HUB', value: 'M365${take(replace('${projectConfig.healthModel.name}-watchdog', '-', ''), 36)}' }
        { name: 'WATCHDOG_CRON', value: '0 */${settings.watchdogIntervalSeconds / 60} * * * *' }
        { name: 'AzureFunctionsJobHost__functionTimeout', value: '00:${padLeft(string(settings.watchdogIntervalSeconds / 60), 2, '0')}:00' }
        { name: 'AzureWebJobs.startLane.Disabled', value: 'true' }
        { name: 'AzureWebJobs.laneOrchestrator.Disabled', value: 'true' }
        { name: 'AzureWebJobs.runLane.Disabled', value: 'true' }
        { name: 'AzureWebJobs.teamsCallingCallback.Disabled', value: 'true' }
        { name: 'AzureWebJobs.about.Disabled', value: 'true' }
      ], projectConfig.logAnalytics.enabled ? [
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights!.properties.ConnectionString }
        { name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING', value: 'Authorization=AAD;ClientId=${identity.properties.clientId}' }
      ] : [])
    }
  }
  dependsOn: [hostRoles, configReader, metricsWriter, packages]
}
resource authentication 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: app
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true, runtimeVersion: '~1' }
    globalValidation: { requireAuthentication: true, unauthenticatedClientAction: 'Return401' }
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
resource scmBasicAuthentication 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: app
  name: 'scm'
  properties: { allow: false }
}
resource ftpBasicAuthentication 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: app
  name: 'ftp'
  properties: { allow: false }
}

output appId string = app.id
