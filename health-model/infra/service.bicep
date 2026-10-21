targetScope = 'resourceGroup'

import { JourneyDefinition, ServiceDefinition } from './service-catalog.bicep'

@minLength(3)
@maxLength(44)
param modelName string
param location string
param service ServiceDefinition
param policy object
param enableOtel bool
param workspaceName string
param applicationInsightsResourceId string

type QuerySignal = {
  name: string
  displayName: string
  signalKind: 'LogAnalyticsQuery'
  queryText: string
  valueColumnName: 'Value'
  refreshInterval: string
  timeGrain: string
  evaluationRules: object
}

func bindQuery(queryText string, applicationInsightsId string, stepName string) string =>
  replace(replace(queryText, '__STEP__', stepName), '__APPLICATION_INSIGHTS_RESOURCE_ID__', applicationInsightsId)

func createQuerySignal(name string, displayName string, queryText string, timeGrain string, evaluationRules object) QuerySignal => {
  name: name
  displayName: displayName
  signalKind: 'LogAnalyticsQuery'
  queryText: queryText
  valueColumnName: 'Value'
  refreshInterval: 'PT1M'
  timeGrain: timeGrain
  evaluationRules: evaluationRules
}

func journeySignals(journey JourneyDefinition, applicationInsightsId string, successRules object, durationRules object) QuerySignal[] =>
  concat(
    [
      createQuerySignal(
        'live-success-percentage',
        'Whole journey - success percentage',
        bindQuery(journey.successQuery, applicationInsightsId, ''),
        journey.timeGrain,
        successRules
      )
      createQuerySignal(
        'live-mean-duration',
        journey.latencyDisplayName,
        bindQuery(journey.latencyQuery, applicationInsightsId, ''),
        journey.timeGrain,
        durationRules
      )
    ],
    flatten(map(journey.steps, step => [
      createQuerySignal(
        'live-${step.name}-success-percentage',
        '${step.displayName} - success percentage',
        bindQuery(journey.stepSuccessQuery, applicationInsightsId, step.name),
        journey.timeGrain,
        successRules
      )
      createQuerySignal(
        'live-${step.name}-mean-duration',
        '${step.displayName} - mean duration (ms)',
        bindQuery(journey.stepDurationQuery, applicationInsightsId, step.name),
        journey.timeGrain,
        durationRules
      )
    ]))
  )

var contextName = '${service.service}-service-health'
var nodes = concat(
  [
    {
      name: modelName
      displayName: service.displayName
      rollup: true
      impact: 'Standard'
      x: 300
      y: 0
    }
    {
      name: contextName
      displayName: 'Service Health'
      rollup: false
      impact: 'Suppressed'
      x: 0
      y: 240
    }
  ],
  map(service.journeys, journey => {
    name: journey.entityName
    displayName: journey.displayName
    rollup: false
    impact: 'Standard'
    x: 400 + indexOf(service.journeys, journey) * 350
    y: 240
  })
)
var relationships = concat(
  [{ parent: modelName, child: contextName }],
  map(service.journeys, journey => { parent: modelName, child: journey.entityName })
)
var successRules = {
  degradedRule: { operator: 'LessThan', threshold: policy.successDegradedPercent }
  unhealthyRule: { operator: 'LessThan', threshold: policy.successUnhealthyPercent }
}
var durationRules = {
  degradedRule: { operator: 'GreaterThan', threshold: policy.latencyDegradedMilliseconds }
  unhealthyRule: { operator: 'GreaterThan', threshold: policy.latencyUnhealthyMilliseconds }
}
var journeyGroups = toObject(service.journeys, journey => journey.entityName, journey => {
  azureLogAnalytics: {
    authenticationSetting: 'workspace-query'
    logAnalyticsWorkspaceResourceId: workspace.id
    signals: journeySignals(journey, applicationInsightsResourceId, successRules, durationRules)
  }
})
var contextGroup = {
  azureLogAnalytics: {
    authenticationSetting: 'workspace-query'
    logAnalyticsWorkspaceResourceId: workspace.id
    signals: [
      union(
        createQuerySignal(
          'microsoft-reported-service-status',
          'Microsoft-reported service status - supporting context',
          bindQuery(service.serviceHealthQuery, applicationInsightsResourceId, ''),
          'PT15M',
          {
            degradedRule: { operator: 'LessThan', threshold: 100 }
            unhealthyRule: { operator: 'LessThan', threshold: 1 }
          }
        ),
        { dataUnit: 'Provider status score', refreshInterval: 'PT5M' }
      )
    ]
  }
}
var queryGroups = union(journeyGroups, { '${contextName}': contextGroup })

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
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '73c42c96-874c-492b-b04d-ab87d138a893'
    )
    principalId: model.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource entities 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = [
  for node in nodes: {
    parent: model
    name: node.name
    properties: {
      displayName: node.displayName
      impact: node.impact
      canvasPosition: { x: node.x, y: node.y }
      signalGroups: union(
        node.rollup ? { dependencies: { aggregationType: 'WorstOf', ignoreUnknown: false } } : {},
        enableOtel ? (queryGroups[?node.name] ?? {}) : {}
      )
    }
    dependsOn: [workspaceAuthentication, workspaceQueryReader]
  }
]

resource modelRelationships 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = [
  for relationship in relationships: {
    parent: model
    name: '${relationship.parent}-to-${relationship.child}'
    properties: {
      parentEntityName: relationship.parent
      childEntityName: relationship.child
    }
    dependsOn: [entities]
  }
]

output modelId string = model.id
output rootEntityName string = model.name
output entityNames array = [for node in nodes: node.name]
