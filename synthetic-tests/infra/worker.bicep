targetScope = 'resourceGroup'

param appName string
param location string
param tags object
param environmentId string
param registryServer string
param identityResourceId string
param identityClientId string
param tenantId string
param tenantAlias string
param service string
param workerImage string
param projectConfig object
@secure()
param m365CertificatePem string = ''
param enableLiveProbes bool
param enableBetaServiceActivity bool = false
@secure()
param applicationInsightsConnectionString string = ''

var selection = first(filter(projectConfig.tenants, tenant => tenant.id == tenantAlias)).services[service]
var execution = selection.execution
var workerSettings = selection.worker
var access = selection.?access ?? {}
var useAzureMonitor = (projectConfig.?otel.?enabled ?? false) && (projectConfig.?otel.?destination ?? 'console') == 'azure-monitor'
var hasTeamsMessages = service == 'teams' && (selection.scenarios[?'channel-conversation'] ?? false)
var useTeamsBot = service == 'teams' && execution.mode == 'live' && hasTeamsMessages
var needsTeamsPeer = service == 'teams' && execution.mode == 'live' && (selection.scenarios[?'scheduled-meeting'] ?? false)
var useTeamsCallback = needsTeamsPeer
var useBotIdentity = useTeamsBot || needsTeamsPeer
var useProviderContext = (projectConfig.?serviceHealth.?enabled ?? false) && ((execution.?serviceHealth ?? false) || (execution.?serviceActivity.?enabled ?? false))
var needsApplicationGraph = service != 'teams' || useTeamsBot || useProviderContext
var useM365Certificate = execution.mode == 'live' && needsApplicationGraph && execution.graphAuthentication == 'certificate'
var credentialSecrets = useM365Certificate ? [
  (access.?m365CertificateSource ?? 'key-vault') == 'container-app'
    ? { name: 'm365-certificate', value: m365CertificatePem }
    : { name: 'm365-certificate', keyVaultUrl: access.m365CertificateSecretUri, identity: identityResourceId }
] : []
var credentialFiles = useM365Certificate ? [{ secretRef: 'm365-certificate', path: 'm365.pem' }] : []

resource app 'Microsoft.App/containerApps@2026-07-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: union(
      { '${identityResourceId}': {} },
      needsTeamsPeer ? { '${access.botPeerManagedIdentityResourceId}': {} } : {}
    )
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: useTeamsCallback ? {
        external: true
        targetPort: execution.?teamsCallingPort ?? 8080
        transport: 'http'
        allowInsecure: false
      } : null
      registries: [{ server: registryServer, identity: identityResourceId }]
      secrets: concat(
        [{ name: 'monitoring-config', value: string(projectConfig) }],
        useAzureMonitor ? [{ name: 'applicationinsights-connection-string', value: applicationInsightsConnectionString }] : [],
        credentialSecrets
      )
    }
    template: {
      terminationGracePeriodSeconds: 60
      containers: [{
        name: '${service}-synthetic'
        image: workerImage
        command: ['node']
        args: ['dist/${service}/src/worker.js', '--config', '/etc/probe/monitoring.config.json', '--tenant', tenantAlias]
        env: concat(
          [
            { name: 'SYNTHETIC_CONFIG_REVISION', value: uniqueString(string(projectConfig)) }
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'AZURE_TENANT_ID', value: tenantId }
            { name: 'ENABLE_LIVE_M365', value: enableLiveProbes ? 'true' : 'false' }
            { name: 'ENABLE_BETA_SERVICE_ACTIVITY', value: enableBetaServiceActivity ? 'true' : 'false' }
          ],
          useM365Certificate ? [
            { name: 'M365_TENANT_ID', value: access.m365TenantId }
            { name: 'M365_CLIENT_ID', value: access.m365ClientId }
            { name: 'M365_CLIENT_CERTIFICATE_PATH', value: '/etc/credentials/m365.pem' }
          ] : [{ name: 'M365_TENANT_ID', value: tenantId }],
          useBotIdentity ? [
            { name: 'BOT_TENANT_ID', value: tenantId }
            { name: 'BOT_CLIENT_ID', value: identityClientId }
          ] : [],
          needsTeamsPeer ? [{ name: 'TEAMS_CALLING_PEER_CLIENT_ID', value: access.botPeerClientId }] : [],
          useAzureMonitor ? [{ name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'applicationinsights-connection-string' }] : []
        )
        resources: { cpu: workerSettings.cpu, memory: workerSettings.memory }
        probes: useTeamsCallback ? [
          { type: 'Readiness', httpGet: { path: '/healthz', port: execution.teamsCallingPort }, periodSeconds: 10, timeoutSeconds: 2 }
          { type: 'Liveness', httpGet: { path: '/healthz', port: execution.teamsCallingPort }, initialDelaySeconds: 30, periodSeconds: 30, timeoutSeconds: 2 }
        ] : []
        volumeMounts: concat(
          [{ volumeName: 'probe-config', mountPath: '/etc/probe' }],
          !empty(credentialFiles) ? [{ volumeName: 'credentials', mountPath: '/etc/credentials' }] : []
        )
      }]
      scale: { minReplicas: 1, maxReplicas: 1 }
      volumes: concat([{
        name: 'probe-config'
        storageType: 'Secret'
        secrets: [{ secretRef: 'monitoring-config', path: 'monitoring.config.json' }]
      }], !empty(credentialFiles) ? [{
        name: 'credentials'
        storageType: 'Secret'
        secrets: credentialFiles
      }] : [])
    }
  }
}

output appId string = app.id
