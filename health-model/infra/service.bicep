targetScope = 'resourceGroup'

import { ServiceDefinition, getJourneyGroups } from './service-catalog.bicep'

@minLength(3)
@maxLength(44)
param modelName string
param location string
param service ServiceDefinition
param policy object
param enableServiceHealth bool = false
param suppressOneDriveRestore bool = false
param enableOtel bool = false
param workspaceName string
param applicationInsightsResourceId string
@description('Exchange/OneDrive user groups with at least one runnable scope for this service.')
param reportingGroups array = []

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

// One aggregation group per reporting group with a scope for this journey. Members are the per-tenant
// signals (group-<id>--tenant-<alias>--<signal>) that each tenant worker publishes.
func reportingGroupEntries(groups array, service string, journey string, signals string[]) array =>
  filter(
    map(filter(groups, group => group.service == service), group => {
      name: 'reporting-${group.id}'
      displayName: group.displayName
      aggregationType: 'WorstOf'
      ignoreUnknown: false
      members: flatten(map(
        filter(group.scopes, scope => contains(scope.journeys, journey)),
        scope => map(signals, signal => 'group-${group.id}--tenant-${scope.tenant}--${signal}')
      ))
    }),
    entry => !empty(entry.members)
  )

// The API requires at least one group when this optional property is present.
func aggregationGroupsProperty(groups array) object =>
  empty(groups) ? {} : { signalAggregationGroups: groups }

func centerX(positions int[]) int => empty(positions) ? 0 : (min(positions) + max(positions)) / 2

var contextName = '${service.service}-service-health'
var journeyGroups = getJourneyGroups(service.journeys)
// Give supporting context its own column and center parents over their selected children.
var columnSpacing = 500
var journeyPositions = map(
  range(0, length(service.journeys)),
  index => (index + (enableServiceHealth ? 1 : 0)) * columnSpacing
)
var groupPositions = map(journeyGroups, group => centerX(map(
  filter(service.journeys, journey => journey.?group.?entityName == group.entityName),
  journey => journeyPositions[indexOf(service.journeys, journey)]
)))
var rootChildPositions = concat(
  enableServiceHealth ? [0] : [],
  groupPositions,
  map(
    filter(service.journeys, journey => journey.?group == null),
    journey => journeyPositions[indexOf(service.journeys, journey)]
  )
)
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
      x: centerX(rootChildPositions)
      y: 0
    }
  ],
  enableServiceHealth ? [
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
  ] : [],
  map(journeyGroups, group => {
    name: group.entityName
    displayName: group.displayName
    kind: 'journey-group'
    journey: ''
    step: ''
    rollup: true
    impact: 'Standard'
    x: groupPositions[indexOf(journeyGroups, group)]
    y: 240
  }),
  map(service.journeys, journey => {
    name: journey.entityName
    displayName: journey.displayName
    kind: 'journey'
    journey: journey.name
    step: ''
    rollup: true
    impact: 'Standard'
    x: journeyPositions[indexOf(service.journeys, journey)]
    y: journey.?group != null ? 440 : 240
  }),
  flatten(map(
    service.journeys,
    journey =>
      map(journey.steps, step => {
        name: '${journey.entityName}-${step.name}'
        displayName: step.displayName
        kind: 'step'
        journey: journey.name
        step: step.?telemetryName ?? step.name
        rollup: false
        impact: suppressOneDriveRestore && service.service == 'onedrive' && journey.name == 'document-versions' && step.name == 'step-4' ? 'Suppressed' : 'Standard'
        x: journeyPositions[indexOf(service.journeys, journey)]
        y: (journey.?group != null ? 640 : 440) + indexOf(journey.steps, step) * 170
      })
  ))
)
var relationships = concat(
  enableServiceHealth ? [{ parent: modelName, child: contextName }] : [],
  map(journeyGroups, group => { parent: modelName, child: group.entityName }),
  map(service.journeys, journey => {
    parent: journey.?group.?entityName ?? modelName
    child: journey.entityName
  }),
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
      node.kind == 'journey' || node.kind == 'journey-group'
        ? { icon: { iconName: 'UserFlow' } }
        : {},
      node.kind == 'journey' && service.service != 'teams'
        ? aggregationGroupsProperty(reportingGroupEntries(
            reportingGroups, service.service, node.journey,
            ['synthetic-success-percentage', 'synthetic-mean-duration']
          ))
        : {}
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
output relationshipNames array = [for relationship in relationships: '${relationship.parent}-to-${relationship.child}']
