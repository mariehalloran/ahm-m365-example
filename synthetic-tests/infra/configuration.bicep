targetScope = 'resourceGroup'

param projectConfig object = loadJsonContent('../../monitoring.config.json')
param location string = projectConfig.deployment.location
param workspaceName string = 'law-${projectConfig.healthModel.name}'
param applicationInsightsName string = 'appi-${projectConfig.healthModel.name}'
param deploymentPrincipalId string
@allowed(['User', 'ServicePrincipal'])
param deploymentPrincipalType string = 'User'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: projectConfig.deployment.configurationStorageAccount
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  tags: { workload: projectConfig.healthModel.name, purpose: 'worker-configuration' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
  }
}
resource service 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {}
}
resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: service
  name: 'worker-config'
  properties: { publicAccess: 'None' }
}
resource uploader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, deploymentPrincipalId, 'configuration-uploader')
  scope: container
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: deploymentPrincipalId
    principalType: deploymentPrincipalType
  }
}
module pipeline './observations.bicep' = if (projectConfig.logAnalytics.enabled) {
  name: 'observation-pipeline'
  params: {
    projectConfig: projectConfig
    location: location
    workspaceName: workspaceName
    applicationInsightsName: applicationInsightsName
    deploymentPrincipalId: deploymentPrincipalId
    deploymentPrincipalType: deploymentPrincipalType
  }
  dependsOn: [container, uploader]
}

output configContainerUrl string = 'https://${storage.name}.blob.${environment().suffixes.storage}/worker-config'
