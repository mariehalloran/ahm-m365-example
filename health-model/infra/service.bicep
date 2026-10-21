targetScope = 'resourceGroup'

@minLength(3)
@maxLength(44)
param modelName string
param location string
param service object
param policy object
param enableOtel bool
param workspaceName string
param applicationInsightsResourceId string

var journeyName = '${service.service}-global'
var contextName = '${service.service}-service-health'
var nodes = concat([
  { name: modelName, displayName: service.displayName, kind: 'root', step: '', rollup: true, impact: 'Standard', x: 300, y: 0 }
  { name: journeyName, displayName: 'User Journey', kind: 'journey', step: '', rollup: true, impact: 'Standard', x: 450, y: 200 }
  { name: contextName, displayName: 'Service Health', kind: 'context', step: '', rollup: false, impact: 'Suppressed', x: 0, y: 200 }
], map(service.steps, step => {
  name: '${service.service}-${step.name}'
  displayName: step.displayName
  kind: 'action'
  step: step.name
  rollup: false
  impact: 'Standard'
  x: 450
  y: 400 + indexOf(service.steps, step) * 180
}))
var relationships = concat([
  { parent: modelName, child: journeyName }
  { parent: modelName, child: contextName }
], map(service.steps, step => { parent: journeyName, child: '${service.service}-${step.name}' }))
var successRules = {
  degradedRule: { operator: 'LessThan', threshold: policy.successDegradedPercent }
  unhealthyRule: { operator: 'LessThan', threshold: policy.successUnhealthyPercent }
}
var durationRules = {
  degradedRule: { operator: 'GreaterThan', threshold: policy.latencyDegradedMilliseconds }
  unhealthyRule: { operator: 'GreaterThan', threshold: policy.latencyUnhealthyMilliseconds }
}
var queryGroups = toObject(filter(nodes, node => node.kind != 'root'), node => node.name, node => {
  azureLogAnalytics: {
    authenticationSetting: 'workspace-query'
    logAnalyticsWorkspaceResourceId: workspace.id
    signals: node.kind == 'context' ? [
      {
        name: 'microsoft-reported-service-status'
        displayName: 'Microsoft-reported service status - supporting context'
        signalKind: 'LogAnalyticsQuery'
        queryText: replace(service.serviceHealthQuery, '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsightsResourceId)
        valueColumnName: 'Value'
        dataUnit: 'Provider status score'
        refreshInterval: 'PT5M'
        timeGrain: 'PT15M'
        evaluationRules: {
          degradedRule: { operator: 'LessThan', threshold: 100 }
          unhealthyRule: { operator: 'LessThan', threshold: 1 }
        }
      }
    ] : [
      {
        name: 'live-success-percentage'
        displayName: '${node.displayName} - success percentage'
        signalKind: 'LogAnalyticsQuery'
        queryText: replace(
          node.kind == 'journey' ? service.successQuery : replace(service.stepSuccessQuery, '__STEP__', node.step),
          '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsightsResourceId)
        valueColumnName: 'Value'
        refreshInterval: 'PT1M'
        timeGrain: service.timeGrain
        evaluationRules: successRules
      }
      {
        name: 'live-mean-duration'
        displayName: node.kind == 'journey'
          ? (service.service == 'exchange' ? 'Confirmed delivery - mean duration (ms)' : service.service == 'teams' ? 'Confirmed publication - mean duration (ms)' : 'Whole journey - mean duration (ms)')
          : '${node.displayName} - mean duration (ms)'
        signalKind: 'LogAnalyticsQuery'
        queryText: replace(
          node.kind == 'journey' ? service.latencyQuery : replace(service.stepDurationQuery, '__STEP__', node.step),
          '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsightsResourceId)
        valueColumnName: 'Value'
        refreshInterval: 'PT1M'
        timeGrain: service.timeGrain
        evaluationRules: durationRules
      }
    ]
  }
})

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  name: workspaceName
}

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' = {
  name: modelName
  location: location
  identity: { type: 'SystemAssigned' }
  tags: { purpose: 'Microsoft 365 synthetic monitoring', service: service.service }
  properties: {}
}

resource workspaceAuthentication 'Microsoft.CloudHealth/healthmodels/authenticationsettings@2026-05-01-preview' = if (enableOtel) {
  parent: model
  name: 'workspace-query'
  properties: {
    displayName: 'Service-model identity for optional workspace queries'
    authenticationKind: 'ManagedIdentity'
    managedIdentityName: 'SystemAssigned'
  }
}

resource workspaceQueryReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableOtel) {
  name: guid(workspace.id, model.id, 'log-analytics-reader')
  scope: workspace
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '73c42c96-874c-492b-b04d-ab87d138a893')
    principalId: model.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource entities 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = [for node in nodes: {
  parent: model
  name: node.name
  properties: {
    displayName: node.displayName
    impact: node.impact
    canvasPosition: { x: node.x, y: node.y }
    signalGroups: union(
      node.rollup ? { dependencies: { aggregationType: 'WorstOf', ignoreUnknown: false } } : {},
      enableOtel ? (queryGroups[?node.name] ?? {}) : {})
  }
  dependsOn: [workspaceAuthentication, workspaceQueryReader]
}]

resource modelRelationships 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = [for relationship in relationships: {
  parent: model
  name: '${relationship.parent}-to-${relationship.child}'
  properties: {
    parentEntityName: relationship.parent
    childEntityName: relationship.child
  }
  dependsOn: [entities]
}]

output modelId string = model.id
output rootEntityName string = model.name
output entityNames array = [for node in nodes: node.name]
