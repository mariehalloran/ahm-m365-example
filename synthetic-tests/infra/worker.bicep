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
param serviceAccess object = {}
param teamsCacheAccountUrl string = ''
@secure()
param m365CertificatePem string = ''
param enableLiveProbes bool
@secure()
param applicationInsightsConnectionString string = ''

var useAzureMonitor = (projectConfig.?otel.?enabled ?? false) && (projectConfig.?otel.?destination ?? 'console') == 'azure-monitor'
var hasTeamsMessages = (projectConfig.services.teams.scenarios[?'publish-channel-message'] ?? true) || (projectConfig.services.teams.scenarios[?'reply-channel-message'] ?? true)
var useTeamsUser = serviceConfig.type == 'teams' && serviceConfig.mode == 'live' && hasTeamsMessages && (serviceConfig.?teamsAuthentication ?? 'bot') == 'user-delegated'
var useTeamsBot = serviceConfig.type == 'teams' && serviceConfig.mode == 'live' && hasTeamsMessages && !useTeamsUser
var useTeamsCalling = serviceConfig.type == 'teams' && serviceConfig.mode == 'live' && (projectConfig.services.teams.scenarios[?'call-test-user'] ?? true)
var useBotIdentity = useTeamsBot || useTeamsCalling
var needsApplicationGraph = serviceConfig.type != 'teams' || useTeamsBot || (serviceConfig.?serviceHealth ?? false) || (serviceConfig.?serviceActivity.?enabled ?? false)
var useM365Certificate = serviceConfig.mode == 'live' && needsApplicationGraph && serviceConfig.graphAuthentication == 'certificate'
var useBotCertificate = useBotIdentity && (serviceConfig.?botAuthentication ?? 'managed-identity') == 'certificate'
var credentialSecrets = concat(
  useM365Certificate ? [
    (serviceAccess.?m365CertificateSource ?? 'key-vault') == 'container-app'
      ? { name: 'm365-certificate', value: m365CertificatePem }
      : { name: 'm365-certificate', keyVaultUrl: serviceAccess.m365CertificateSecretUri, identity: identityResourceId }
  ] : [],
  useBotCertificate ? [
    { name: 'bot-certificate', keyVaultUrl: serviceAccess.botCertificateSecretUri, identity: identityResourceId }
  ] : []
)
var credentialFiles = concat(
  useM365Certificate ? [{ secretRef: 'm365-certificate', path: 'm365.pem' }] : [],
  useBotCertificate ? [{ secretRef: 'bot-certificate', path: 'bot.pem' }] : []
)

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
      ingress: useTeamsCalling ? {
        external: true
        targetPort: serviceConfig.?teamsCallingPort ?? 8080
        transport: 'http'
        allowInsecure: false
      } : null
      registries: [{ server: registryServer, identity: identityResourceId }]
      secrets: concat(
        [
          { name: 'monitoring-config', value: string(projectConfig) }
          { name: 'service-config', value: string(serviceConfig) }
        ],
        useAzureMonitor ? [{ name: 'applicationinsights-connection-string', value: applicationInsightsConnectionString }] : [],
        credentialSecrets
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
              { name: 'SYNTHETIC_CONFIG_REVISION', value: uniqueString(string(projectConfig), string(serviceConfig), string(serviceAccess), teamsCacheAccountUrl) }
              { name: 'AZURE_CLIENT_ID', value: identityClientId }
              { name: 'AZURE_TENANT_ID', value: tenantId }
              { name: 'ENABLE_LIVE_M365', value: enableLiveProbes ? 'true' : 'false' }
            ],
            useM365Certificate ? [
              { name: 'M365_TENANT_ID', value: serviceAccess.m365TenantId }
              { name: 'M365_CLIENT_ID', value: serviceAccess.m365ClientId }
              { name: 'M365_CLIENT_CERTIFICATE_PATH', value: '/etc/credentials/m365.pem' }
            ] : [
              { name: 'M365_TENANT_ID', value: tenantId }
            ],
            useBotIdentity ? [
              { name: 'BOT_TENANT_ID', value: useBotCertificate ? serviceAccess.botTenantId : tenantId }
              { name: 'BOT_CLIENT_ID', value: useBotCertificate ? serviceAccess.botClientId : identityClientId }
            ] : [],
            useBotCertificate ? [
              { name: 'BOT_CLIENT_CERTIFICATE_PATH', value: '/etc/credentials/bot.pem' }
            ] : [],
            useTeamsUser ? [
              { name: 'TEAMS_PUBLIC_CLIENT_ID', value: serviceAccess.teamsPublicClientId }
              { name: 'TEAMS_CACHE_ACCOUNT_URL', value: teamsCacheAccountUrl }
              { name: 'TEAMS_CACHE_CONTAINER', value: 'teams-auth' }
              { name: 'TEAMS_CACHE_BLOB', value: 'teams-user.msal.json' }
            ] : [],
            useAzureMonitor
              ? [{ name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'applicationinsights-connection-string' }]
              : []
          )
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          probes: useTeamsCalling ? [
              {
                type: 'Readiness'
                httpGet: { path: '/healthz', port: serviceConfig.?teamsCallingPort ?? 8080 }
                periodSeconds: 10
                timeoutSeconds: 2
              }
              {
                type: 'Liveness'
                httpGet: { path: '/healthz', port: serviceConfig.?teamsCallingPort ?? 8080 }
                initialDelaySeconds: 30
                periodSeconds: 30
                timeoutSeconds: 2
              }
          ] : []
          volumeMounts: concat(
            [{ volumeName: 'probe-config', mountPath: '/etc/probe' }],
            !empty(credentialFiles) ? [{ volumeName: 'credentials', mountPath: '/etc/credentials' }] : []
          )
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
      volumes: concat([
        {
          name: 'probe-config'
          storageType: 'Secret'
          secrets: [
            { secretRef: 'monitoring-config', path: 'monitoring.config.json' }
            { secretRef: 'service-config', path: 'service.json' }
          ]
        }
      ], !empty(credentialFiles) ? [{
        name: 'credentials'
        storageType: 'Secret'
        secrets: credentialFiles
      }] : [])
    }
  }
}

output appId string = app.id
