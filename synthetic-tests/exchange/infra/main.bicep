targetScope = 'resourceGroup'

@description('Azure region for the Exchange synthetic identity and optional worker.')
param location string = resourceGroup().location

@description('Stable Exchange-specific identity name. Use a different identity for each environment; do not tie its lifecycle to app replacement.')
@minLength(3)
@maxLength(128)
param identityName string = 'uami-exchange-synthetic-mock'

@description('Name of the optional, dedicated Container Apps environment.')
@minLength(2)
@maxLength(60)
param environmentName string = 'cae-exchange-synthetic-mock'

@description('Name of the optional Exchange synthetic Container App.')
@minLength(2)
@maxLength(32)
param appName string = 'ca-exchange-synthetic-mock'

@description('False creates only the identity in a future deployment. This mock has not been deployed.')
param deployWorker bool = false

@description('Independent live-execution gate. Leave false until tenant authorization and the mailbox are approved.')
param enableLiveProbe bool = false

@description('Required approved, already-published image built from this repository. No image is built or published by this template.')
@minLength(1)
param workerImage string

@description('Compiled Exchange worker path relative to the approved image working directory.')
@minLength(1)
param workerEntrypoint string = 'dist/exchange/src/worker.js'

@description('Optional existing Azure Container Registry hostname. Its scoped image-pull authorization must already be granted to this identity.')
param registryServer string = ''

@description('Project-root settings, including approved targets and health-model destination. Supply a reviewed private configuration for live use.')
param projectConfig object = loadJsonContent('../../../monitoring.config.json')
@secure()
@description('Required for this legacy host only when root OTEL destination is azure-monitor.')
param applicationInsightsConnectionString string = ''

@description('Independent Exchange probe cadence in seconds.')
@minValue(1)
@maxValue(86400)
param intervalSeconds int = 60

@description('Exchange journey timeout in seconds.')
@minValue(1)
@maxValue(120)
param timeoutSeconds int = 45

var runtimeProjectConfig = union(projectConfig, {
  services: union(projectConfig.services, {
    exchange: union(projectConfig.services.exchange, {
      enabled: enableLiveProbe && projectConfig.services.exchange.enabled
    })
  })
})
var exchangeConfig = {
  type: 'exchange'
  intervalSeconds: intervalSeconds
  timeoutSeconds: timeoutSeconds
  mode: 'live'
  graphAuthentication: 'managed-identity'
  healthReportAuthentication: 'managed-identity'
  cohort: 'exchange-global'
}
var useAzureMonitor = (projectConfig.?otel.?enabled ?? false) && (projectConfig.?otel.?destination ?? 'console') == 'azure-monitor'

resource exchangeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: identityName
  location: location
}

resource workerEnvironment 'Microsoft.App/managedEnvironments@2025-07-01' = if (deployWorker) {
  name: environmentName
  location: location
  properties: {
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource exchangeWorker 'Microsoft.App/containerApps@2025-07-01' = if (deployWorker) {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${exchangeIdentity.id}': {}
    }
  }
  properties: {
    environmentId: workerEnvironment!.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: concat([
        {
          name: 'exchange-config'
          value: string(exchangeConfig)
        }
        {
          name: 'monitoring-config'
          value: string(runtimeProjectConfig)
        }
      ], useAzureMonitor ? [{ name: 'applicationinsights-connection-string', value: applicationInsightsConnectionString }] : [])
      registries: empty(registryServer) ? [] : [
        {
          server: registryServer
          identity: exchangeIdentity.id
        }
      ]
    }
    template: {
      terminationGracePeriodSeconds: 60
      containers: [
        {
          name: 'exchange-synthetic'
          image: workerImage
          command: [
            'node'
          ]
          args: [
            workerEntrypoint
            '--project-config'
            '/etc/probe/monitoring.config.json'
            '--config'
            '/etc/probe/exchange.json'
          ]
          env: concat([
            {
              name: 'AZURE_CLIENT_ID'
              value: exchangeIdentity.properties.clientId
            }
            {
              name: 'AZURE_TENANT_ID'
              value: subscription().tenantId
            }
            {
              name: 'ENABLE_LIVE_M365'
              value: enableLiveProbe ? 'true' : 'false'
            }
          ], useAzureMonitor ? [{ name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'applicationinsights-connection-string' }] : [])
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          volumeMounts: [
            {
              volumeName: 'exchange-config'
              mountPath: '/etc/probe'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'exchange-config'
          storageType: 'Secret'
          secrets: [
            {
              secretRef: 'exchange-config'
              path: 'exchange.json'
            }
            {
              secretRef: 'monitoring-config'
              path: 'monitoring.config.json'
            }
          ]
        }
      ]
    }
  }
}

output identityResourceId string = exchangeIdentity.id
output clientId string = exchangeIdentity.properties.clientId
output principalId string = exchangeIdentity.properties.principalId
output tenantId string = subscription().tenantId
output appId string = deployWorker ? exchangeWorker!.id : ''
