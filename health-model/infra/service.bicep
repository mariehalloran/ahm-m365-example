targetScope = 'resourceGroup'

import { ServiceDefinition } from './service-catalog.bicep'

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

var journeyName = '${service.service}-global'
var contextName = '${service.service}-service-health'
var nodes = concat(
  [
    {
      name: modelName
      displayName: service.displayName
      kind: 'root'
      step: ''
      rollup: true
      impact: 'Standard'
      x: 300
      y: 0
    }
    {
      name: journeyName
      displayName: 'User Journey'
      kind: 'journey'
      step: ''
      rollup: true
      impact: 'Standard'
      x: 450
      y: 200
    }
    {
      name: contextName
      displayName: 'Service Health'
      kind: 'context'
      step: ''
      rollup: false
      impact: 'Suppressed'
      x: 0
      y: 200
    }
  ],
  map(service.steps, step => {
    name: '${service.service}-${step.name}'
    displayName: step.displayName
    kind: 'action'
    step: step.name
    rollup: false
    impact: 'Standard'
    x: 450
    y: 400 + indexOf(service.steps, step) * 180
  })
)
var relationships = concat(
  [
    { parent: modelName, child: journeyName }
    { parent: modelName, child: contextName }
  ],
  map(service.steps, step => { parent: journeyName, child: '${service.service}-${step.name}' })
)
var successRules = {
  degradedRule: { operator: 'LessThan', threshold: policy.successDegradedPercent }
  unhealthyRule: { operator: 'LessThan', threshold: policy.successUnhealthyPercent }
}
var durationRules = {
  degradedRule: { operator: 'GreaterThan', threshold: policy.latencyDegradedMilliseconds }
  unhealthyRule: { operator: 'GreaterThan', threshold: policy.latencyUnhealthyMilliseconds }
}
var contextRules = {
  degradedRule: { operator: 'LessThan', threshold: 100 }
  unhealthyRule: { operator: 'LessThan', threshold: 1 }
}
var journeyDurationNames = {
  exchange: 'Confirmed delivery - mean duration (ms)'
  teams: 'Confirmed publication - mean duration (ms)'
  sharepoint: 'Whole journey - mean duration (ms)'
}
var queryGroups = toObject(filter(nodes, node => node.kind != 'root'), node => node.name, node => {
  azureLogAnalytics: {
    authenticationSetting: 'workspace-query'
    logAnalyticsWorkspaceResourceId: workspace.id
    signals: node.kind == 'context'
      ? [
          union(
            createQuerySignal(
              'microsoft-reported-service-status',
              'Microsoft-reported service status - supporting context',
              bindQuery(service.serviceHealthQuery, applicationInsightsResourceId, ''),
              'PT15M',
              contextRules
            ),
            {
              dataUnit: 'Provider status score'
              refreshInterval: 'PT5M'
            }
          )
        ]
      : [
          createQuerySignal(
            'live-success-percentage',
            '${node.displayName} - success percentage',
            bindQuery(
              node.kind == 'journey' ? service.successQuery : service.stepSuccessQuery,
              applicationInsightsResourceId,
              node.step
            ),
            service.timeGrain,
            successRules
          )
          createQuerySignal(
            'live-mean-duration',
            node.kind == 'journey' ? journeyDurationNames[service.service] : '${node.displayName} - mean duration (ms)',
            bindQuery(
              node.kind == 'journey' ? service.latencyQuery : service.stepDurationQuery,
              applicationInsightsResourceId,
              node.step
            ),
            service.timeGrain,
            durationRules
          )
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
