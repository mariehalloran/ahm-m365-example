targetScope = 'resourceGroup'

param projectConfig object = loadJsonContent('../../monitoring.config.json')
param location string = projectConfig.deployment.location
param workspaceName string = 'law-${projectConfig.healthModel.name}'

var actionGroups = projectConfig.healthModel.alertActionGroupIds
var expected = flatten(map(projectConfig.tenants, tenant => map(
  filter(['exchange', 'teams', 'onedrive'], service => tenant.services[service].enabled && tenant.services[service].execution.mode == 'live' && !empty(filter(items(tenant.services[service].scenarios), scenario => scenario.value))),
  service => {
    tenant: tenant.id
    service: service
    maxAgeSeconds: 2 * tenant.services[service].execution.intervalSeconds + 180
  }
)))
var query = replace('''
M365Synthetic_CL
| where TimeGenerated > ago(30m) and Category == 'M365Synthetic' and Mode == 'live' and Kind == 'journey'
| where Timestamp <= now()
| summarize LastObserved=max(Timestamp) by TenantAlias,Service
| summarize Observed=make_bag(bag_pack(strcat(TenantAlias,'/',Service),LastObserved))
| extend Expected=dynamic(__EXPECTED__)
| mv-expand Expected
| extend TenantAlias=tostring(Expected.tenant),Service=tostring(Expected.service),MaxAgeSeconds=tolong(Expected.maxAgeSeconds)
| extend LastObserved=todatetime(Observed[strcat(TenantAlias,'/',Service)])
| where isnull(LastObserved) or datetime_diff('second',now(),LastObserved)>MaxAgeSeconds
| project TenantAlias,Service,LastObserved,MaxAgeSeconds
''', '__EXPECTED__', string(expected))
resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  name: workspaceName
}
resource alert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (!empty(actionGroups) && !empty(expected)) {
  name: '${projectConfig.healthModel.name}-observation-freshness'
  location: location
  kind: 'LogAlert'
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'M365 synthetic observations stopped arriving'
    description: 'No fresh journey observations for an enabled tenant/service. Independent of model no-data health.'
    enabled: true
    severity: 1
    evaluationFrequency: 'PT1M'
    windowSize: 'PT30M'
    scopes: [workspace.id]
    autoMitigate: true
    criteria: {
      allOf: [{
        query: query
        timeAggregation: 'Count'
        operator: 'GreaterThan'
        threshold: 0
        failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
      }]
    }
    actions: { actionGroups: actionGroups }
  }
}
resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(actionGroups) && !empty(expected)) {
  name: guid(workspace.id, projectConfig.healthModel.name, 'freshness-query')
  scope: workspace
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '73c42c96-874c-492b-b04d-ab87d138a893')
    principalId: alert!.identity.principalId
    principalType: 'ServicePrincipal'
  }
}
