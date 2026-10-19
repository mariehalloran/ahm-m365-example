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
  { service: 'exchange', entityName: 'exchange-global', lookback: '5m', timeGrain: 'PT5M', durationMetric: 'mailflow.delivery.duration' }
  { service: 'sharepoint', entityName: 'sharepoint-global', lookback: '15m', timeGrain: 'PT15M', durationMetric: 'synthetic.probe.duration' }
]
var successQuery = replace(loadTextContent('../queries/success-percentage.kql'), '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsights.id)
var latencyQuery = replace(loadTextContent('../queries/mean-latency.kql'), '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsights.id)
var journeySignalGroups = toObject(serviceSignals, service => service.entityName, service => {
  azureLogAnalytics: {
    authenticationSetting: workspaceAuthentication.name
    logAnalyticsWorkspaceResourceId: workspace.id
    signals: [
      {
        name: 'live-success-percentage'
        displayName: 'Live attempt success percentage (including unexecutable)'
        signalKind: 'LogAnalyticsQuery'
        queryText: replace(replace(successQuery, '__SERVICE__', service.service), '__LOOKBACK__', service.lookback)
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
        displayName: service.service == 'exchange' ? 'Live mean confirmed delivery latency (ms)' : 'Live mean attempt latency including cleanup (ms)'
        signalKind: 'LogAnalyticsQuery'
        queryText: replace(replace(replace(latencyQuery, '__SERVICE__', service.service), '__LOOKBACK__', service.lookback), '__DURATION_METRIC__', service.durationMetric)
        valueColumnName: 'Value'
        refreshInterval: 'PT1M'
        timeGrain: service.timeGrain
        evaluationRules: {
          degradedRule: { operator: 'GreaterThan', threshold: latencyDegradedMilliseconds }
          unhealthyRule: { operator: 'GreaterThan', threshold: latencyUnhealthyMilliseconds }
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
  { name: 'exchange-global', displayName: 'Exchange Mail-flow - live service metrics', x: 300, y: 620, rollup: false, impact: 'Standard' }
  { name: 'teams-experience', displayName: 'Teams Experience', x: 600, y: 400, rollup: true, impact: 'Standard' }
  { name: 'teams-global', displayName: 'Teams Cohort - not implemented', x: 600, y: 620, rollup: false, impact: 'Standard' }
  { name: 'sharepoint-experience', displayName: 'SharePoint Experience', x: 900, y: 400, rollup: true, impact: 'Standard' }
  { name: 'sharepoint-global', displayName: 'SharePoint File Experience - live service metrics', x: 900, y: 620, rollup: false, impact: 'Standard' }
  { name: 'monitoring-pipeline', displayName: 'Monitoring Pipeline', x: 1200, y: 400, rollup: true, impact: 'Standard' }
  { name: 'runner-heartbeat', displayName: 'Live Service Metrics - not a worker heartbeat', x: 1100, y: 620, rollup: false, impact: 'Standard' }
  { name: 'graph-availability', displayName: 'Graph Query Availability - not connected', x: 1350, y: 620, rollup: false, impact: 'Standard' }
  { name: 'provider-context', displayName: 'Microsoft 365 Service Health - supporting context', x: 1550, y: 400, rollup: false, impact: 'Suppressed' }
]

var relationships = [
  { parent: modelName, child: 'm365-tenant' }
  { parent: 'm365-tenant', child: 'azure-resources' }
  { parent: 'm365-tenant', child: 'exchange-experience' }
  { parent: 'm365-tenant', child: 'teams-experience' }
  { parent: 'm365-tenant', child: 'sharepoint-experience' }
  { parent: 'm365-tenant', child: 'monitoring-pipeline' }
  { parent: 'exchange-experience', child: 'exchange-global' }
  { parent: 'teams-experience', child: 'teams-global' }
  { parent: 'sharepoint-experience', child: 'sharepoint-global' }
  { parent: 'monitoring-pipeline', child: 'runner-heartbeat' }
  { parent: 'monitoring-pipeline', child: 'graph-availability' }
]

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
    deploymentStage: 'live-telemetry-queries'
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
    } : {}, journeySignalGroups[?entity.name] ?? {}, entity.name == 'runner-heartbeat' ? {
      azureLogAnalytics: {
        authenticationSetting: workspaceAuthentication.name
        logAnalyticsWorkspaceResourceId: workspace.id
        signals: [
          {
            name: 'missing-live-services'
            displayName: 'Services without recent live run metrics'
            signalKind: 'LogAnalyticsQuery'
            queryText: replace(loadTextContent('../queries/missing-services.kql'), '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsights.id)
            valueColumnName: 'Value'
            refreshInterval: 'PT1M'
            timeGrain: 'PT15M'
            evaluationRules: {
              unhealthyRule: { operator: 'GreaterThan', threshold: 0 }
            }
          }
          {
            name: 'unexecutable-live-attempts'
            displayName: 'Live attempts that could not execute'
            signalKind: 'LogAnalyticsQuery'
            queryText: replace(loadTextContent('../queries/unexecutable-attempts.kql'), '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsights.id)
            valueColumnName: 'Value'
            refreshInterval: 'PT1M'
            timeGrain: 'PT15M'
            evaluationRules: {
              unhealthyRule: { operator: 'GreaterThan', threshold: 0 }
            }
          }
        ]
      }
    } : {})
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
output workspaceResourceId string = workspace.id
output workspaceCustomerId string = workspace.properties.customerId
output applicationInsightsResourceId string = applicationInsights.id
output authenticationSettingName string = workspaceAuthentication.name
