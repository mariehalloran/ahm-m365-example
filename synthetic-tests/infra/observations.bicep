targetScope = 'resourceGroup'

param projectConfig object = loadJsonContent('../../monitoring.config.json')
param location string = projectConfig.deployment.location
param workspaceName string = 'law-${projectConfig.healthModel.name}'
param applicationInsightsName string = 'appi-${projectConfig.healthModel.name}'

var settings = projectConfig.logAnalytics
var tags = { workload: projectConfig.healthModel.name, purpose: 'direct-observations' }
var identityIds = union(flatten(map(projectConfig.tenants, tenant => map(
  filter(['exchange', 'teams', 'onedrive', 'sharepoint'], service =>
    (tenant.services[service].?enabled ?? true) && !empty(filter(items(tenant.services[service].scenarios), scenario => scenario.value))),
  service => tenant.services[service].identityResourceId))), [])
var columns = [
  { name: 'TimeGenerated', type: 'datetime' }
  { name: 'Timestamp', type: 'datetime' }
  { name: 'EventId', type: 'string' }
  { name: 'Category', type: 'string' }
  { name: 'Subject', type: 'string' }
  { name: 'Period', type: 'string' }
  { name: 'Unit', type: 'string' }
  { name: 'Version', type: 'string' }
  { name: 'Value', type: 'real' }
  { name: 'Service', type: 'string' }
  { name: 'Journey', type: 'string' }
  { name: 'Step', type: 'string' }
  { name: 'Kind', type: 'string' }
  { name: 'Mode', type: 'string' }
  { name: 'Region', type: 'string' }
  { name: 'ExecutionRegion', type: 'string' }
  { name: 'M365TenantId', type: 'string' }
  { name: 'TenantAlias', type: 'string' }
  { name: 'TestAccountId', type: 'string' }
  { name: 'SyntheticUser', type: 'string' }
  { name: 'GroupIds', type: 'dynamic' }
  { name: 'GroupNames', type: 'dynamic' }
  { name: 'DurationMs', type: 'real' }
  { name: 'FailureCategory', type: 'string' }
  { name: 'ErrorMessage', type: 'string' }
  { name: 'HttpStatus', type: 'int' }
  { name: 'RunId', type: 'string' }
  { name: 'CorrelationId', type: 'string' }
  { name: 'Dimensions', type: 'dynamic' }
]

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: { disableLocalAuth: true, enableLogAccessUsingOnlyResourcePermissions: false }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}
resource table 'Microsoft.OperationalInsights/workspaces/tables@2025-02-01' = {
  parent: workspace
  name: 'M365Synthetic_CL'
  properties: {
    plan: 'Analytics'
    retentionInDays: 30
    totalRetentionInDays: 30
    schema: { name: 'M365Synthetic_CL', columns: columns }
  }
}
resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: applicationInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    SamplingPercentage: 100
    DisableLocalAuth: true
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}
resource endpoint 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' = {
  name: settings.dataCollectionEndpointName
  location: location
  tags: tags
  properties: { networkAcls: { publicNetworkAccess: 'Enabled' } }
}
resource rule 'Microsoft.Insights/dataCollectionRules@2024-03-11' = {
  name: settings.dataCollectionRuleName
  location: location
  tags: tags
  kind: 'Direct'
  properties: {
    dataCollectionEndpointId: endpoint.id
    streamDeclarations: { 'Custom-M365Synthetic': { columns: [{ name: 'RawData', type: 'string' }] } }
    destinations: { logAnalytics: [{ name: 'workspace', workspaceResourceId: workspace.id }] }
    dataFlows: [{
      streams: ['Custom-M365Synthetic']
      destinations: ['workspace']
      outputStream: 'Custom-M365Synthetic_CL'
      transformKql: loadTextContent('./observations-transform.kql')
    }]
  }
  dependsOn: [table]
}
resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = [
  for id in identityIds: {
    scope: resourceGroup(split(id, '/')[2], split(id, '/')[4])
    name: last(split(id, '/'))
  }
]
resource ingestionWriters 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (id, index) in identityIds: {
    name: guid(rule.id, id, 'direct-observation-ingestion')
    scope: rule
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
      principalId: identities[index].properties.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

output endpointUrl string = endpoint.properties.logsIngestion.endpoint
output immutableRuleId string = rule.properties.immutableId
