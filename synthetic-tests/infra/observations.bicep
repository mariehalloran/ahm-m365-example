targetScope = 'resourceGroup'

param projectConfig object = loadJsonContent('../../monitoring.config.json')
param location string = projectConfig.deployment.location
param workspaceName string = 'law-${projectConfig.healthModel.name}'
param applicationInsightsName string = 'appi-${projectConfig.healthModel.name}'
param deploymentPrincipalId string
@allowed(['User', 'ServicePrincipal'])
param deploymentPrincipalType string = 'User'

var settings = projectConfig.logAnalytics
var tags = { workload: projectConfig.healthModel.name, purpose: 'synthetic-observations' }
var blobContributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var blobOwner = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
var metricsPublisher = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
var columns = [
  { name: 'TimeGenerated', type: 'datetime' }
  { name: 'Timestamp', type: 'datetime' }
  { name: 'EventId', type: 'string' }
  { name: 'Category', type: 'string' }
  { name: 'Subject', type: 'string' }
  { name: 'Period', type: 'string' }
  { name: 'Unit', type: 'string' }
  { name: 'Version', type: 'string' }
  { name: 'Value', type: 'real' }
  { name: 'Service', type: 'string' }
  { name: 'Journey', type: 'string' }
  { name: 'Step', type: 'string' }
  { name: 'Kind', type: 'string' }
  { name: 'Mode', type: 'string' }
  { name: 'Region', type: 'string' }
  { name: 'ExecutionRegion', type: 'string' }
  { name: 'M365TenantId', type: 'string' }
  { name: 'TenantAlias', type: 'string' }
  { name: 'TestAccountId', type: 'string' }
  { name: 'SyntheticUser', type: 'string' }
  { name: 'GroupIds', type: 'dynamic' }
  { name: 'GroupNames', type: 'dynamic' }
  { name: 'DurationMs', type: 'real' }
  { name: 'FailureCategory', type: 'string' }
  { name: 'ErrorMessage', type: 'string' }
  { name: 'HttpStatus', type: 'int' }
  { name: 'RunId', type: 'string' }
  { name: 'CorrelationId', type: 'string' }
  { name: 'Dimensions', type: 'dynamic' }
]

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: { disableLocalAuth: true, enableLogAccessUsingOnlyResourcePermissions: false }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}
resource table 'Microsoft.OperationalInsights/workspaces/tables@2025-02-01' = {
  parent: workspace
  name: 'M365Synthetic_CL'
  properties: {
    plan: 'Analytics'
    retentionInDays: 30
    totalRetentionInDays: 30
    schema: { name: 'M365Synthetic_CL', columns: columns }
  }
}
resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: applicationInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    SamplingPercentage: 100
    DisableLocalAuth: true
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}
resource archive 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: projectConfig.deployment.configurationStorageAccount
}
resource archiveService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: archive
  name: 'default'
}
resource captureContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: archiveService
  name: 'capture'
  properties: { publicAccess: 'None' }
}
resource quarantineContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: archiveService
  name: 'quarantine'
  properties: { publicAccess: 'None' }
}
resource archiveLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: archive
  name: 'default'
  properties: {
    policy: {
      rules: [{
        name: 'raw-observation-retention'
        enabled: true
        type: 'Lifecycle'
        definition: {
          filters: { blobTypes: ['blockBlob'], prefixMatch: ['capture/'] }
          actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: settings.archiveRetentionDays } } }
        }
      }]
    }
  }
}
resource hostStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: settings.functionStorageAccount
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  tags: tags
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
  }
}
resource hostBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: hostStorage
  name: 'default'
  properties: {}
}
resource packages 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: hostBlobService
  name: 'function-packages'
  properties: { publicAccess: 'None' }
}
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: settings.ingestionIdentityName
  location: location
  tags: tags
}
resource namespace 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: settings.eventHubNamespace
  location: location
  sku: { name: 'Standard', tier: 'Standard', capacity: 1 }
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    minimumTlsVersion: '1.2'
    disableLocalAuth: true
    isAutoInflateEnabled: false
    kafkaEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}
resource captureWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(archive.id, namespace.id, 'capture-writer')
  scope: captureContainer
  properties: {
    roleDefinitionId: blobContributor
    principalId: namespace.identity.principalId
    principalType: 'ServicePrincipal'
  }
}
resource hub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: namespace
  name: settings.eventHubName
  properties: {
    partitionCount: 4
    messageRetentionInDays: 7
    captureDescription: settings.captureEnabled ? {
      enabled: true
      encoding: 'Avro'
      intervalInSeconds: 300
      sizeLimitInBytes: 10485760
      skipEmptyArchives: true
      destination: {
        name: 'EventHubArchive.AzureBlockBlob'
        identity: { type: 'SystemAssigned' }
        properties: {
          storageAccountResourceId: archive.id
          blobContainer: 'capture'
          archiveNameFormat: '{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}.avro'
        }
      }
    } : { enabled: false }
  }
  dependsOn: [captureWriter]
}
module consumer './observation-consumer.bicep' = {
  name: 'observation-consumer'
  params: {
    namespaceName: namespace.name
    eventHubName: settings.eventHubName
    namespacePrincipalId: namespace.identity.principalId
  }
  dependsOn: [hub]
}
resource receiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hub.id, identity.id, 'observation-receiver')
  scope: hub
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource hostStorageOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, identity.id, 'function-host-storage')
  scope: hostStorage
  properties: { roleDefinitionId: blobOwner, principalId: identity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource hostDiagnosticWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, identity.id, 'function-host-diagnostics')
  scope: hostStorage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
resource quarantineWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(archive.id, identity.id, 'quarantine-writer')
  scope: quarantineContainer
  properties: { roleDefinitionId: blobContributor, principalId: identity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource captureReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(archive.id, deploymentPrincipalId, 'capture', 'diagnostic-reader')
  scope: captureContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
    principalId: deploymentPrincipalId
    principalType: deploymentPrincipalType
  }
}
resource quarantineReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(archive.id, deploymentPrincipalId, 'quarantine', 'diagnostic-reader')
  scope: quarantineContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
    principalId: deploymentPrincipalId
    principalType: deploymentPrincipalType
  }
}
resource endpoint 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' = {
  name: settings.dataCollectionEndpointName
  location: location
  properties: { networkAcls: { publicNetworkAccess: 'Enabled' } }
}
resource rule 'Microsoft.Insights/dataCollectionRules@2024-03-11' = {
  name: settings.dataCollectionRuleName
  location: location
  kind: 'Direct'
  properties: {
    dataCollectionEndpointId: endpoint.id
    streamDeclarations: {
      'Custom-M365Synthetic': { columns: [{ name: 'RawData', type: 'string' }] }
    }
    destinations: { logAnalytics: [{ name: 'workspace', workspaceResourceId: workspace.id }] }
    dataFlows: [{
      streams: ['Custom-M365Synthetic']
      destinations: ['workspace']
      outputStream: 'Custom-M365Synthetic_CL'
      transformKql: loadTextContent('./observations-transform.kql')
    }]
  }
  dependsOn: [table]
}
resource ingestionWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(rule.id, identity.id, 'observation-ingestion')
  scope: rule
  properties: { roleDefinitionId: metricsPublisher, principalId: identity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource functionDiagnosticWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(insights.id, identity.id, 'function-diagnostics')
  scope: insights
  properties: { roleDefinitionId: metricsPublisher, principalId: identity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: settings.functionPlanName
  location: location
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}
resource function 'Microsoft.Web/sites@2024-04-01' = {
  name: settings.functionAppName
  location: location
  kind: 'functionapp,linux'
  tags: tags
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
          value: '${hostStorage.properties.primaryEndpoints.blob}function-packages'
          authentication: { type: 'UserAssignedIdentity', userAssignedIdentityResourceId: identity.id }
        }
      }
      scaleAndConcurrency: { instanceMemoryMB: 512, maximumInstanceCount: 40 }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: hostStorage.name }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'AzureWebJobsStorage__clientId', value: identity.properties.clientId }
        { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
        { name: 'ObservationEvents__fullyQualifiedNamespace', value: '${namespace.name}.servicebus.windows.net' }
        { name: 'ObservationEvents__credential', value: 'managedidentity' }
        { name: 'ObservationEvents__clientId', value: identity.properties.clientId }
        { name: 'OBSERVATION_EVENT_HUB', value: settings.eventHubName }
        { name: 'OBSERVATION_CONSUMER_GROUP', value: consumer.outputs.consumerGroupName }
        { name: 'OBSERVATION_INGESTION_ENDPOINT', value: endpoint.properties.logsIngestion.endpoint }
        { name: 'OBSERVATION_RULE_ID', value: rule.properties.immutableId }
        { name: 'OBSERVATION_QUARANTINE_URL', value: 'https://${archive.name}.blob.${environment().suffixes.storage}/quarantine' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
        { name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING', value: 'ClientId=${identity.properties.clientId};Authorization=AAD' }
      ]
    }
  }
  dependsOn: [receiver, hostStorageOwner, hostDiagnosticWriter, ingestionWriter, quarantineWriter, packages, functionDiagnosticWriter]
}
resource scmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: function
  name: 'scm'
  properties: { allow: false }
}
resource ftpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: function
  name: 'ftp'
  properties: { allow: false }
}

output functionName string = function.name
output workspaceId string = workspace.id
output eventHubId string = hub.id
