targetScope = 'resourceGroup'

param projectConfig object = loadJsonContent('../../monitoring.config.json')
param location string = projectConfig.deployment.location
param workspaceName string = 'law-${projectConfig.healthModel.name}'
@description('Generated expected target counts for each selected tenant/service/journey; never per-target model signals.')
param expectedExecutions array = []
param configSha256 string = ''

var actionGroups = projectConfig.healthModel.alertActionGroupIds
var deployFreshness = projectConfig.logAnalytics.enabled && !empty(actionGroups) && !empty(expectedExecutions)
var query = replace(replace('''
let Expected=print Expected=dynamic(__EXPECTED__)
| mv-expand Expected
| project Key=strcat(tostring(Expected.tenant),'/',tostring(Expected.service),'/',tostring(Expected.journey)),
RequiredTargets=tolong(Expected.targets),MaxAgeSeconds=tolong(Expected.maxAgeSeconds);
let Completed=M365Synthetic_CL
| where TimeGenerated > ago(1d) and Category == 'M365Synthetic' and Mode == 'live' and Kind == 'journey'
| where Timestamp <= now() and tostring(Dimensions.configSha256) == '__CONFIG__'
| extend Key=strcat(TenantAlias,'/',Service,'/',Journey)
| summarize LastObserved=max(Timestamp),ObservedTargets=dcount(TestAccountId,2) by Key,RunId
| join kind=inner Expected on Key
| where ObservedTargets >= RequiredTargets
| summarize LastObserved=max(LastObserved) by Key;
Expected
| join kind=leftouter Completed on Key
| where isnull(LastObserved) or datetime_diff('second',now(),LastObserved)>MaxAgeSeconds
| project Key,LastObserved,RequiredTargets,MaxAgeSeconds
''', '__EXPECTED__', string(expectedExecutions)), '__CONFIG__', configSha256)

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = if (deployFreshness) { name: workspaceName }
resource alert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (deployFreshness) {
  name: '${projectConfig.healthModel.name}-observation-freshness'
  location: location
  kind: 'LogAlert'
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'M365 complete journey observations stopped arriving'
    description: 'Every selected journey must have a fresh complete target inventory in Log Analytics; other lanes cannot mask missing execution or ingestion.'
    enabled: true
    severity: 1
    evaluationFrequency: 'PT1M'
    windowSize: 'P1D'
    scopes: [workspace!.id]
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
resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployFreshness) {
  name: guid(workspace!.id, projectConfig.healthModel.name, 'freshness-query')
  scope: workspace!
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '73c42c96-874c-492b-b04d-ab87d138a893')
    principalId: alert!.identity.principalId
    principalType: 'ServicePrincipal'
  }
}
