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
@description('Bind native observation queries when true; otherwise accept direct external health reports.')
param logAnalyticsEnabled bool = false
param workspaceName string
param tenantScopes array
@description('Exchange/OneDrive user groups with at least one runnable scope for this service.')
param reportingGroups array = []

func bindObservationQuery(query string, service string, node object, scope object, metric object, policy object) string =>
  replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    query, '__SERVICE__', service),
    '__JOURNEY__', node.journey),
    '__STEP__', empty(metric.phase) ? node.step : metric.phase),
    '__KIND__', empty(metric.phase) ? node.kind : 'call-phase'),
    '__TENANT__', scope.tenant),
    '__GROUP__', scope.group),
    '__AGGREGATION__', metric.aggregation),
    '__WINDOW__', string(policy.signalWindowMinutes)),
    '__MINIMUM__', string(policy.minimumSamples)),
    '\r', '')

func observationSignalName(name string, scope object, multiTenant bool) string =>
  !empty(scope.group) ? 'group-${scope.group}--tenant-${scope.tenant}--${name}'
    : multiTenant ? 'tenant-${scope.tenant}--${name}' : name

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

// Empty arrays are invalid; null explicitly clears a previously configured group list.
func aggregationGroupsProperty(groups array) object =>
  { signalAggregationGroups: empty(groups) ? null : groups }

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
// The query deduplicates first, excludes inconclusive/legacy cancellation samples and returns no value below minimumSamples.
var observationQuery = loadTextContent('../queries/synthetic.kql')
var signalScopes = concat(
  map(tenantScopes, scope => { tenant: scope.id, group: '', journeys: scope.journeys }),
  flatten(map(reportingGroups, group => map(group.scopes, scope => {
    tenant: scope.tenant
    group: group.id
    journeys: scope.journeys
  })))
)
var observationMetrics = [
  {
    name: 'observed-success-percentage'
    displayName: 'Observed success percentage'
    dataUnit: 'Percent'
    aggregation: 'avg(100.0 * Value)'
    phase: ''
    evaluationRules: {
      degradedRule: { operator: 'LessThan', threshold: policy.successDegradedPercent }
      unhealthyRule: { operator: 'LessThan', threshold: policy.successUnhealthyPercent }
    }
  }
  {
    name: 'observed-mean-duration'
    displayName: 'Observed mean duration'
    dataUnit: 'Milliseconds'
    aggregation: 'avg(DurationMs)'
    phase: ''
    evaluationRules: {
      degradedRule: { operator: 'GreaterThan', threshold: policy.latencyDegradedMilliseconds }
      unhealthyRule: { operator: 'GreaterThan', threshold: policy.latencyUnhealthyMilliseconds }
    }
  }
]
var callMetrics = [
  {
    name: 'observed-call-connection-success-percentage'
    displayName: 'Observed meeting connection success'
    dataUnit: 'Percent'
    aggregation: 'avg(100.0 * Value)'
    phase: 'connection'
    evaluationRules: observationMetrics[0].evaluationRules
  }
  {
    name: 'observed-call-mean-connection-duration'
    displayName: 'Observed mean meeting connection duration'
    dataUnit: 'Milliseconds'
    aggregation: 'avg(DurationMs)'
    phase: 'connection'
    evaluationRules: observationMetrics[1].evaluationRules
  }
  {
    name: 'observed-call-disconnection-success-percentage'
    displayName: 'Observed meeting departure success'
    dataUnit: 'Percent'
    aggregation: 'avg(100.0 * Value)'
    phase: 'disconnection'
    evaluationRules: observationMetrics[0].evaluationRules
  }
  {
    name: 'observed-call-mean-disconnection-duration'
    displayName: 'Observed mean meeting departure duration'
    dataUnit: 'Milliseconds'
    aggregation: 'avg(DurationMs)'
    phase: 'disconnection'
    evaluationRules: observationMetrics[1].evaluationRules
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

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = if (logAnalyticsEnabled) {
  name: workspaceName
}
resource workspaceAuthentication 'Microsoft.CloudHealth/healthmodels/authenticationsettings@2026-05-01-preview' = if (logAnalyticsEnabled) {
  parent: model
  name: 'workspace-query'
  properties: {
    displayName: 'Service-model identity for observation queries'
    authenticationKind: 'ManagedIdentity'
    managedIdentityName: 'SystemAssigned'
  }
}
resource workspaceReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (logAnalyticsEnabled) {
  name: guid(workspace!.id, model.id, 'log-analytics-reader')
  scope: workspace!
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
          node.kind == 'journey' || node.kind == 'step'
            ? {
                azureLogAnalytics: logAnalyticsEnabled ? {
                  authenticationSetting: 'workspace-query'
                  logAnalyticsWorkspaceResourceId: workspace!.id
                  signals: flatten(map(
                    filter(signalScopes, scope => contains(scope.journeys, node.journey) && (node.kind == 'journey' || empty(scope.group))),
                    scope => map(concat(observationMetrics, node.name == 'teams-call' ? callMetrics : []), metric => {
                      name: observationSignalName(metric.name, scope, length(tenantScopes) > 1)
                      displayName: metric.displayName
                      signalKind: 'LogAnalyticsQuery'
                      queryText: bindObservationQuery(observationQuery, service.service, node, scope, metric, policy)
                      valueColumnName: 'Value'
                      dataUnit: metric.dataUnit
                      refreshInterval: 'PT1M'
                      timeGrain: 'PT${policy.signalWindowMinutes}M'
                      evaluationRules: metric.evaluationRules
                    })))
                } : null
              }
            : {}
        )
      },
      node.kind == 'journey' || node.kind == 'journey-group'
        ? { icon: { iconName: 'UserFlow' } }
        : {},
      node.kind == 'journey'
        ? aggregationGroupsProperty(service.service == 'teams' ? [] : reportingGroupEntries(
            reportingGroups, service.service, node.journey,
            ['observed-success-percentage', 'observed-mean-duration']
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
