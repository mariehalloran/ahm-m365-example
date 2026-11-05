targetScope = 'resourceGroup'

param projectConfig object
param executionFunctionId string
param watchdogFunctionId string

var actionGroups = projectConfig.healthModel.alertActionGroupIds
var modelName = projectConfig.healthModel.name
resource executionFunction 'Microsoft.Web/sites@2024-04-01' existing = { name: last(split(executionFunctionId, '/')) }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: projectConfig.deployment.functions.storageAccount }
resource freshness 'Microsoft.Insights/metricAlerts@2018-03-01' = [
  for metric in ['MissingExecutionLanes', 'MissingPublications', 'FailedLanes']: if (!empty(actionGroups)) {
    name: '${modelName}-${metric}'
    location: 'global'
    properties: {
      description: 'Independent Function watchdog detected ${metric}; inspect durable ownership and publication diagnostics.'
      severity: 1
      enabled: true
      scopes: [executionFunction.id]
      evaluationFrequency: 'PT1M'
      windowSize: 'PT5M'
      autoMitigate: true
      criteria: {
        'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
        allOf: [{
          name: metric
          metricNamespace: 'M365Monitoring'
          metricName: metric
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Maximum'
          criterionType: 'StaticThresholdCriterion'
          skipMetricValidation: true
        }]
      }
      actions: map(actionGroups, id => { actionGroupId: id })
    }
  }
]
resource storageAvailability 'Microsoft.Insights/metricAlerts@2018-03-01' = if (!empty(actionGroups)) {
  name: '${modelName}-execution-storage-availability'
  location: 'global'
  properties: {
    description: 'Durable runtime/journal Storage availability is below 99%. Independent of synthetic reporting.'
    severity: 1
    enabled: true
    scopes: [storage.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [{
        name: 'StorageAvailability'
        metricNamespace: 'Microsoft.Storage/storageAccounts'
        metricName: 'Availability'
        operator: 'LessThan'
        threshold: 99
        timeAggregation: 'Average'
        criterionType: 'StaticThresholdCriterion'
      }]
    }
    actions: map(actionGroups, id => { actionGroupId: id })
  }
}
resource stoppedMonitoring 'Microsoft.Insights/activityLogAlerts@2020-10-01' = if (!empty(actionGroups)) {
  name: '${modelName}-monitoring-host-stopped'
  location: 'global'
  properties: {
    description: 'An execution/watchdog Function host was explicitly stopped or deleted.'
    enabled: true
    scopes: [resourceGroup().id]
    condition: {
      allOf: [
        { field: 'category', equals: 'Administrative' }
        { anyOf: [{ field: 'operationName', equals: 'Microsoft.Web/sites/stop/action' }, { field: 'operationName', equals: 'Microsoft.Web/sites/delete' }] }
        { anyOf: [{ field: 'resourceId', equals: executionFunctionId }, { field: 'resourceId', equals: watchdogFunctionId }] }
      ]
    }
    actions: { actionGroups: map(actionGroups, id => { actionGroupId: id }) }
  }
}
