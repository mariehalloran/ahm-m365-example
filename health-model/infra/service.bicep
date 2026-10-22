targetScope = 'resourceGroup'

import { ServiceDefinition } from './service-catalog.bicep'

@minLength(3)
@maxLength(44)
param modelName string
param location string
param service ServiceDefinition
param policy object
param enableOtel bool = false
param workspaceName string
param applicationInsightsResourceId string

func bindTelemetryQuery(queryText string, service string, journey string, step string, applicationId string, aggregation string) string =>
  replace(
    replace(
      replace(
        replace(
          replace(
            replace(queryText, '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationId),
            '__MESSAGE__',
            empty(step) ? 'synthetic-result' : 'synthetic-step'
          ),
          '__SERVICE__',
          service
        ),
        '__JOURNEY__',
        journey
      ),
      '__STEP__',
      step
    ),
    '__AGGREGATION__',
    aggregation
  )

func sourceGroup(name string, displayName string, members string[]) object => {
  name: name
  displayName: displayName
  aggregationType: 'WorstOf'
  ignoreUnknown: false
  members: members
}

var contextName = '${service.service}-service-health'
var telemetryQuery = loadTextContent('../queries/synthetic.kql')
var telemetryMetrics = [
  {
    name: 'otel-success-percentage'
    displayName: 'OTEL success percentage'
    dataUnit: 'Percent'
    aggregation: 'avg(100.0 * Success)'
    evaluationRules: {
      degradedRule: { operator: 'LessThan', threshold: policy.successDegradedPercent }
      unhealthyRule: { operator: 'LessThan', threshold: policy.successUnhealthyPercent }
    }
  }
  {
    name: 'otel-mean-duration'
    displayName: 'OTEL mean duration'
    dataUnit: 'Milliseconds'
    aggregation: 'avg(Duration)'
    evaluationRules: {
      degradedRule: { operator: 'GreaterThan', threshold: policy.latencyDegradedMilliseconds }
      unhealthyRule: { operator: 'GreaterThan', threshold: policy.latencyUnhealthyMilliseconds }
    }
  }
]
var nodes = concat(
  [
    {
      name: modelName
      displayName: service.displayName
      kind: 'root'
      journey: ''
      step: ''
      rollup: true
      impact: 'Standard'
      x: 300
      y: 0
    }
    {
      name: contextName
      displayName: 'Service Health'
      kind: 'context'
      journey: ''
      step: ''
      rollup: false
      impact: 'Suppressed'
      x: 0
      y: 240
    }
  ],
  map(service.journeys, journey => {
    name: journey.entityName
    displayName: journey.displayName
    kind: 'journey'
    journey: journey.name
    step: ''
    rollup: true
    impact: 'Standard'
    x: 400 + indexOf(service.journeys, journey) * 500
    y: 240
  }),
  flatten(map(
    service.journeys,
    journey =>
      map(journey.steps, step => {
        name: '${journey.entityName}-${step.name}'
        displayName: step.displayName
        kind: 'step'
        journey: journey.name
        step: step.name
        rollup: false
        impact: 'Standard'
        x: 400 + indexOf(service.journeys, journey) * 500
        y: 440 + indexOf(journey.steps, step) * 170
      })
  ))
)
var relationships = concat(
  [{ parent: modelName, child: contextName }],
  map(service.journeys, journey => { parent: modelName, child: journey.entityName }),
  flatten(map(
    service.journeys,
    journey =>
      map(journey.steps, step => {
        parent: journey.entityName
        child: '${journey.entityName}-${step.name}'
      })
  ))
)
resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' = {
  name: modelName
  location: location
  identity: { type: 'SystemAssigned' }
  tags: { purpose: 'Microsoft 365 synthetic monitoring', service: service.service }
  properties: {}
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  name: workspaceName
}
resource workspaceAuthentication 'Microsoft.CloudHealth/healthmodels/authenticationsettings@2026-05-01-preview' = if (enableOtel) {
  parent: model
  name: 'workspace-query'
  properties: {
    displayName: 'Service-model identity for optional OTEL queries'
    authenticationKind: 'ManagedIdentity'
    managedIdentityName: 'SystemAssigned'
  }
}
resource workspaceReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableOtel) {
  name: guid(workspace.id, model.id, 'log-analytics-reader')
  scope: workspace
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '73c42c96-874c-492b-b04d-ab87d138a893'
    )
    principalId: model.identity.principalId
    principalType: 'ServicePrincipal'
  }
}
resource entities 'Microsoft.CloudHealth/healthmodels/entities@2026-10-01-preview' = [
  for node in nodes: {
    parent: model
    name: node.name
    properties: union(
      {
        displayName: node.displayName
        impact: node.impact
        canvasPosition: { x: node.x, y: node.y }
        signalGroups: union(
          node.rollup ? { dependencies: { aggregationType: 'WorstOf', ignoreUnknown: false } } : {},
          enableOtel && (node.kind == 'journey' || node.kind == 'step')
            ? {
                azureLogAnalytics: {
                  authenticationSetting: 'workspace-query'
                  logAnalyticsWorkspaceResourceId: workspace.id
                  signals: map(telemetryMetrics, metric => {
                    name: metric.name
                    displayName: metric.displayName
                    signalKind: 'LogAnalyticsQuery'
                    queryText: bindTelemetryQuery(
                      telemetryQuery, service.service, node.journey, node.step,
                      applicationInsightsResourceId, metric.aggregation
                    )
                    valueColumnName: 'Value'
                    dataUnit: metric.dataUnit
                    refreshInterval: 'PT1M'
                    timeGrain: 'PT15M'
                    evaluationRules: metric.evaluationRules
                  })
                }
              }
            : {}
        )
      },
      node.kind == 'root'
        ? {}
        : {
            signalAggregationGroups: concat(
              [
                sourceGroup(
                  'external-reports',
                  'External Reports',
                  node.kind == 'context'
                    ? ['microsoft-reported-service-status']
                    : ['synthetic-success-percentage', 'synthetic-mean-duration']
                )
              ],
              enableOtel && node.kind != 'context'
                ? [sourceGroup('otel', 'OpenTelemetry', ['otel-success-percentage', 'otel-mean-duration'])]
                : []
            )
          }
    )
    dependsOn: [workspaceReader, workspaceAuthentication]
  }
]
resource modelRelationships 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = [
  for relationship in relationships: {
    parent: model
    name: '${relationship.parent}-to-${relationship.child}'
    properties: { parentEntityName: relationship.parent, childEntityName: relationship.child }
    dependsOn: [entities]
  }
]

output modelId string = model.id
output rootEntityName string = model.name
output entityNames array = [for node in nodes: node.name]
