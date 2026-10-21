targetScope = 'resourceGroup'

param appName string
param location string
param tags object
param environmentId string
param registryServer string
param identityResourceId string
param identityClientId string
param tenantId string
param workerImage string
param projectConfig object
param serviceConfig object
param enableLiveProbes bool
@secure()
param applicationInsightsConnectionString string

var useAzureMonitor = projectConfig.otel.enabled && projectConfig.otel.destination == 'azure-monitor'

resource app 'Microsoft.App/containerApps@2026-07-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityResourceId}': {} }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registryServer, identity: identityResourceId }]
      secrets: concat(
        [
          { name: 'monitoring-config', value: string(projectConfig) }
          { name: 'service-config', value: string(serviceConfig) }
        ],
        useAzureMonitor
          ? [{ name: 'applicationinsights-connection-string', value: applicationInsightsConnectionString }]
          : []
      )
    }
    template: {
      terminationGracePeriodSeconds: 60
      containers: [
        {
          name: '${serviceConfig.type}-synthetic'
          image: workerImage
          command: ['node']
          args: [
            'dist/${serviceConfig.type}/src/worker.js'
            '--project-config'
            '/etc/probe/monitoring.config.json'
            '--config'
            '/etc/probe/service.json'
          ]
          env: concat(
            [
              // Workers read config once, so a config change must create a new revision.
              { name: 'SYNTHETIC_CONFIG_REVISION', value: uniqueString(string(projectConfig), string(serviceConfig)) }
              { name: 'AZURE_CLIENT_ID', value: identityClientId }
              { name: 'AZURE_TENANT_ID', value: tenantId }
              { name: 'ENABLE_LIVE_M365',               value: enableLiveProbes ? 'true' : 'false' }
            ],
            useAzureMonitor
              ? [
                  {
                    name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
                    secretRef: 'applicationinsights-connection-string'
                  }
                ]
              : []
          )
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          volumeMounts: [{ volumeName: 'probe-config', mountPath: '/etc/probe' }]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
      volumes: [
        {
          name: 'probe-config'
          storageType: 'Secret'
          secrets: [
            { secretRef: 'monitoring-config', path: 'monitoring.config.json' }
            { secretRef: 'service-config', path: 'service.json' }
          ]
        }
      ]
    }
  }
}

output appId string = app.id
