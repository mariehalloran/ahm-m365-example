targetScope = 'resourceGroup'

param projectConfig object = loadJsonContent('../../monitoring.config.json')
param location string = projectConfig.deployment.location
param workspaceName string = 'law-${projectConfig.healthModel.name}'
@description('Generated expected target counts for each selected tenant/service/journey; never per-target model signals.')
param expectedExecutions array = []
param configSha256 string = ''

var actionGroups = projectConfig.healthModel.alertActionGroupIds
var deployFreshness = projectConfig.logAnalytics.enabled && !empty(actionGroups) && !empty(expectedExecutions)
var maximumAgeSeconds = max(concat([60], map(expectedExecutions, execution => int(execution.maxAgeSeconds))))
var windowMinutes = first(filter([1, 5, 10, 15, 30, 45, 60, 120, 180, 240, 300, 360], minutes => minutes * 60 >= maximumAgeSeconds))
var watchdogName = '${take(projectConfig.deployment.functions.appName, 54)}-watch'
var watchdogMaximumAgeSeconds = 5 * projectConfig.deployment.functions.watchdogIntervalSeconds
var query = replace(replace(replace(replace(replace('''
let WatchdogLastObserved=toscalar(AppTraces
| where TimeGenerated > ago(__WINDOW__m)
| where AppRoleName == '__WATCHDOG__' and Message startswith 'monitoring-watchdog-completed'
| summarize max(TimeGenerated));
let Expected=print Expected=dynamic(__EXPECTED__)
| mv-expand Expected
| project Key=strcat(tostring(Expected.tenant),'/',tostring(Expected.service),'/',tostring(Expected.journey)),
RequiredTargets=tolong(Expected.targets),MaxAgeSeconds=tolong(Expected.maxAgeSeconds);
let Completed=M365Synthetic_CL
| where TimeGenerated > ago(__WINDOW__m) and Category == 'M365Synthetic' and Mode == 'live' and Kind == 'journey'
| where Timestamp <= now() and tostring(Dimensions.configSha256) == '__CONFIG__'
| extend Key=strcat(TenantAlias,'/',Service,'/',Journey)
| summarize LastObserved=max(Timestamp) by Key,TestAccountId
| summarize LastObserved=min(LastObserved),ObservedTargets=count() by Key
| join kind=inner Expected on Key
| where ObservedTargets >= RequiredTargets
| summarize LastObserved=max(LastObserved) by Key;
Expected
| join kind=leftouter Completed on Key
| extend WatchdogLastObserved=WatchdogLastObserved,WatchdogMaximumAgeSeconds=__WATCHDOG_AGE__
| where isnull(LastObserved) or datetime_diff('second',now(),LastObserved)>MaxAgeSeconds
    or isnull(WatchdogLastObserved) or datetime_diff('second',now(),WatchdogLastObserved)>WatchdogMaximumAgeSeconds
| project Key,LastObserved,RequiredTargets,MaxAgeSeconds,WatchdogLastObserved,WatchdogMaximumAgeSeconds
''', '__EXPECTED__', string(expectedExecutions)), '__CONFIG__', configSha256), '__WINDOW__', string(windowMinutes)), '__WATCHDOG__', watchdogName), '__WATCHDOG_AGE__', string(watchdogMaximumAgeSeconds))

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = if (deployFreshness) { name: workspaceName }
resource alert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (deployFreshness) {
  name: '${projectConfig.healthModel.name}-observation-freshness'
  location: location
  kind: 'LogAlert'
  identity: { type: 'SystemAssigned' }
  properties: {
    displayName: 'M365 execution or reporting freshness failed'
    description: 'Every selected journey requires fresh complete target coverage and the independent watchdog must publish a completion heartbeat.'
    enabled: true
    severity: 1
    evaluationFrequency: 'PT5M'
    windowSize: 'PT${windowMinutes}M'
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
