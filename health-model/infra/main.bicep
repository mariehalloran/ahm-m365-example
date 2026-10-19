targetScope = 'resourceGroup'

@description('Name of the isolated proof-of-concept health model.')
@minLength(3)
@maxLength(44)
param modelName string = 'm365-experience-poc'

@description('A region supporting Microsoft.CloudHealth, normally the resource group location.')
param location string = resourceGroup().location

@description('Dedicated pay-as-you-go Log Analytics workspace for live synthetic telemetry.')
param workspaceName string = 'law-${modelName}'

@description('Workspace-backed Application Insights component for the embedded OpenTelemetry exporters.')
param applicationInsightsName string = 'appi-${modelName}'

@description('Provisional PoC thresholds, not service-level objectives.')
param successDegradedPercent int = 99
param successUnhealthyPercent int = 95
param latencyDegradedMilliseconds int = 15000
param latencyUnhealthyMilliseconds int = 60000

var serviceSignals = [
  {
    service: 'exchange'
    journey: 'send-receive-mail'
    entityName: 'exchange-global'
    timeGrain: 'PT5M'
    successQuery: loadTextContent('../../exchange/queries/health-model/success-percentage.kql')
    latencyQuery: loadTextContent('../../exchange/queries/health-model/mean-latency.kql')
    stepSuccessQuery: loadTextContent('../../exchange/queries/health-model/step-success.kql')
    stepDurationQuery: loadTextContent('../../exchange/queries/health-model/step-duration.kql')
    serviceHealthQuery: loadTextContent('../../exchange/queries/health-model/service-health-status.kql')
    steps: [
      { name: 'authenticate', displayName: 'Authenticate' }
      { name: 'create-draft', displayName: 'Create email' }
      { name: 'send', displayName: 'Send email' }
      { name: 'confirm-delivery', displayName: 'Confirm delivery' }
      { name: 'cleanup', displayName: 'Cleanup' }
    ]
  }
  {
    service: 'teams'
    journey: 'publish-channel-message'
    entityName: 'teams-global'
    timeGrain: 'PT5M'
    successQuery: loadTextContent('../../teams/queries/health-model/success-percentage.kql')
    latencyQuery: loadTextContent('../../teams/queries/health-model/mean-latency.kql')
    stepSuccessQuery: loadTextContent('../../teams/queries/health-model/step-success.kql')
    stepDurationQuery: loadTextContent('../../teams/queries/health-model/step-duration.kql')
    serviceHealthQuery: loadTextContent('../../teams/queries/health-model/service-health-status.kql')
    steps: [
      { name: 'authenticate', displayName: 'Authenticate' }
      { name: 'post-message', displayName: 'Post message' }
      { name: 'confirm-publication', displayName: 'Confirm publication' }
      { name: 'cleanup', displayName: 'Cleanup' }
    ]
  }
  {
    service: 'sharepoint'
    journey: 'save-reopen-file'
    entityName: 'sharepoint-global'
    timeGrain: 'PT15M'
    successQuery: loadTextContent('../../sharepoint/queries/health-model/success-percentage.kql')
    latencyQuery: loadTextContent('../../sharepoint/queries/health-model/mean-latency.kql')
    stepSuccessQuery: loadTextContent('../../sharepoint/queries/health-model/step-success.kql')
    stepDurationQuery: loadTextContent('../../sharepoint/queries/health-model/step-duration.kql')
    serviceHealthQuery: loadTextContent('../../sharepoint/queries/health-model/service-health-status.kql')
    steps: [
      { name: 'authenticate', displayName: 'Authenticate' }
      { name: 'verify-drive', displayName: 'Verify library' }
      { name: 'upload-file', displayName: 'Upload file' }
      { name: 'read-file', displayName: 'Read file' }
      { name: 'cleanup', displayName: 'Cleanup' }
    ]
  }
]
var journeySignalGroups = toObject(serviceSignals, service => service.entityName, service => {
  azureLogAnalytics: {
    authenticationSetting: workspaceAuthentication.name
    logAnalyticsWorkspaceResourceId: workspace.id
    signals: concat([
      {
        name: 'live-success-percentage'
        displayName: 'Whole journey - success percentage'
        signalKind: 'LogAnalyticsQuery'
        queryText: replace(service.successQuery, '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsights.id)
        valueColumnName: 'Value'
        refreshInterval: 'PT1M'
        timeGrain: service.timeGrain
        evaluationRules: {
          degradedRule: { operator: 'LessThan', threshold: successDegradedPercent }
          unhealthyRule: { operator: 'LessThan', threshold: successUnhealthyPercent }
        }
      }
      {
        name: 'live-mean-latency'
        displayName: service.service == 'exchange' ? 'Confirmed delivery - mean duration (ms)' : service.service == 'teams' ? 'Confirmed publication - mean duration (ms)' : 'Whole journey - mean duration (ms)'
        signalKind: 'LogAnalyticsQuery'
        queryText: replace(service.latencyQuery, '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsights.id)
        valueColumnName: 'Value'
        refreshInterval: 'PT1M'
        timeGrain: service.timeGrain
        evaluationRules: {
          degradedRule: { operator: 'GreaterThan', threshold: latencyDegradedMilliseconds }
          unhealthyRule: { operator: 'GreaterThan', threshold: latencyUnhealthyMilliseconds }
        }
      }
    ], flatten(map(service.steps, step => [
      {
        name: '${step.name}-success-percentage'
        displayName: '${step.displayName} - success percentage'
        signalKind: 'LogAnalyticsQuery'
        queryText: replace(replace(service.stepSuccessQuery, '__STEP__', step.name), '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsights.id)
        valueColumnName: 'Value'
        refreshInterval: 'PT1M'
        timeGrain: service.timeGrain
        evaluationRules: {
          degradedRule: { operator: 'LessThan', threshold: successDegradedPercent }
          unhealthyRule: { operator: 'LessThan', threshold: successUnhealthyPercent }
        }
      }
      {
        name: '${step.name}-mean-duration'
        displayName: '${step.displayName} - mean duration (ms)'
        signalKind: 'LogAnalyticsQuery'
        queryText: replace(replace(service.stepDurationQuery, '__STEP__', step.name), '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsights.id)
        valueColumnName: 'Value'
        refreshInterval: 'PT1M'
        timeGrain: service.timeGrain
        evaluationRules: {
          degradedRule: { operator: 'GreaterThan', threshold: latencyDegradedMilliseconds }
          unhealthyRule: { operator: 'GreaterThan', threshold: latencyUnhealthyMilliseconds }
        }
      }
    ])))
  }
})

var serviceHealthSignalGroups = toObject(serviceSignals, service => '${service.service}-service-health', service => {
  azureLogAnalytics: {
    authenticationSetting: workspaceAuthentication.name
    logAnalyticsWorkspaceResourceId: workspace.id
    signals: [
      {
        name: 'microsoft-reported-service-status'
        displayName: 'Microsoft-reported service status - supporting context'
        signalKind: 'LogAnalyticsQuery'
        queryText: replace(service.serviceHealthQuery, '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsights.id)
        valueColumnName: 'Value'
        dataUnit: 'Provider status score'
        refreshInterval: 'PT5M'
        timeGrain: 'PT15M'
        evaluationRules: {
          degradedRule: { operator: 'LessThan', threshold: 100 }
          unhealthyRule: { operator: 'LessThan', threshold: 1 }
        }
      }
    ]
  }
})

var entities = [
  // The service creates this root automatically; manage its rollup rather than leave it disconnected.
  { name: modelName, displayName: 'Microsoft 365 Synthetic Health Model (PoC)', x: 600, y: 0, rollup: true, impact: 'Standard' }
  { name: 'm365-tenant', displayName: 'Microsoft 365 and Azure Experience', x: 600, y: 180, rollup: true, impact: 'Standard' }
  { name: 'azure-resources', displayName: 'Azure Resource Health - not connected', x: 0, y: 400, rollup: false, impact: 'Standard' }
  { name: 'exchange-experience', displayName: 'Exchange Experience', x: 300, y: 400, rollup: true, impact: 'Standard' }
  { name: 'exchange-global', displayName: 'User Journey', x: 300, y: 620, rollup: false, impact: 'Standard' }
  { name: 'exchange-service-health', displayName: 'Service Health', x: 50, y: 620, rollup: false, impact: 'Suppressed' }
  { name: 'teams-experience', displayName: 'Teams Experience', x: 600, y: 400, rollup: true, impact: 'Standard' }
  { name: 'teams-global', displayName: 'User Journey', x: 650, y: 620, rollup: false, impact: 'Standard' }
  { name: 'teams-service-health', displayName: 'Service Health', x: 500, y: 820, rollup: false, impact: 'Suppressed' }
  { name: 'sharepoint-experience', displayName: 'SharePoint Experience', x: 900, y: 400, rollup: true, impact: 'Standard' }
  { name: 'sharepoint-global', displayName: 'User Journey', x: 1050, y: 620, rollup: false, impact: 'Standard' }
  { name: 'sharepoint-service-health', displayName: 'Service Health', x: 1200, y: 820, rollup: false, impact: 'Suppressed' }
]

var relationships = [
  { parent: modelName, child: 'm365-tenant' }
  { parent: 'm365-tenant', child: 'azure-resources' }
  { parent: 'm365-tenant', child: 'exchange-experience' }
  { parent: 'm365-tenant', child: 'teams-experience' }
  { parent: 'm365-tenant', child: 'sharepoint-experience' }
  { parent: 'exchange-experience', child: 'exchange-global' }
  { parent: 'teams-experience', child: 'teams-global' }
  { parent: 'sharepoint-experience', child: 'sharepoint-global' }
  { parent: 'exchange-experience', child: 'exchange-service-health' }
  { parent: 'teams-experience', child: 'teams-service-health' }
  { parent: 'sharepoint-experience', child: 'sharepoint-service-health' }
]
var stepCount = length(flatten(map(serviceSignals, service => service.steps)))

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: -1 }
    features: {
      disableLocalAuth: true
      enableLogAccessUsingOnlyResourcePermissions: false
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: applicationInsightsName
  location: location
  kind: 'web'
  properties: {
    // The workspace cap is unlimited, but the separate currentbillingfeatures API defaults
    // this component to 100 GB/day. This component schema cannot disable that separate cap.
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    SamplingPercentage: 100
    // The installed OTel exporter requires connection-string ingestion; do not output its secret.
    DisableLocalAuth: false
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' = {
  name: modelName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  tags: {
    purpose: 'Microsoft 365 synthetic monitoring proof of concept'
    deploymentStage: 'user-journey-queries-service-health-stubs'
    intendedRunnerHost: 'Azure Container Apps'
  }
  properties: {}
}

resource workspaceAuthentication 'Microsoft.CloudHealth/healthmodels/authenticationsettings@2026-05-01-preview' = {
  parent: model
  name: 'workspace-query'
  properties: {
    displayName: 'System-assigned model identity for live workspace queries'
    authenticationKind: 'ManagedIdentity'
    managedIdentityName: 'SystemAssigned'
  }
}

resource workspaceQueryReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(workspace.id, model.id, 'log-analytics-reader')
  scope: workspace
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '73c42c96-874c-492b-b04d-ab87d138a893')
    principalId: model.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource modelEntities 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = [for entity in entities: {
  parent: model
  name: entity.name
  properties: {
    displayName: entity.displayName
    impact: entity.impact
    canvasPosition: {
      x: entity.x
      y: entity.y
    }
    signalGroups: union(entity.rollup ? {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    } : {}, journeySignalGroups[?entity.name] ?? {}, serviceHealthSignalGroups[?entity.name] ?? {})
  }
  dependsOn: [
    workspaceQueryReader
  ]
}]

resource modelRelationships 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = [for relationship in relationships: {
  parent: model
  name: '${relationship.parent}-to-${relationship.child}'
  properties: {
    parentEntityName: relationship.parent
    childEntityName: relationship.child
  }
  dependsOn: [
    modelEntities
  ]
}]

output modelId string = model.id
output modelName string = model.name
output rootEntityName string = modelName
output apiVersion string = '2026-05-01-preview'
output entityNames array = [for entity in entities: entity.name]
output entityCount int = length(entities)
output relationshipCount int = length(relationships)
output journeyCount int = length(serviceSignals)
output stepCount int = stepCount
output querySignalCount int = length(serviceSignals) * 3 + stepCount * 2
output workspaceResourceId string = workspace.id
output workspaceCustomerId string = workspace.properties.customerId
output applicationInsightsResourceId string = applicationInsights.id
output authenticationSettingName string = workspaceAuthentication.name
