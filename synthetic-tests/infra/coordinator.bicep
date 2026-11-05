targetScope = 'resourceGroup'

param appName string
param location string
param tags object
param environmentId string
param registryServer string
param identityResourceId string
param identityClientId string
param tenantId string
param image string
param configBlobUrl string
param configSha256 string
param functionStartUrls object
param functionApiClientId string
param resources object

resource app 'Microsoft.App/containerApps@2026-07-01' = {
  name: appName
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityResourceId}': {} } }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registryServer, identity: identityResourceId }]
    }
    template: {
      terminationGracePeriodSeconds: 30
      containers: [{
        name: 'schedule-dispatcher'
        image: image
        command: ['node']
        args: ['dist/coordinator/src/index.js']
        env: [
          { name: 'MONITORING_CONFIG_BLOB_URL', value: configBlobUrl }
          { name: 'MONITORING_CONFIG_SHA256', value: configSha256 }
          { name: 'AZURE_CLIENT_ID', value: identityClientId }
          { name: 'AZURE_TENANT_ID', value: tenantId }
          { name: 'FUNCTION_START_URLS', value: string(functionStartUrls) }
          { name: 'FUNCTION_API_CLIENT_ID', value: functionApiClientId }
        ]
        resources: resources
      }]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}
