targetScope = 'resourceGroup'

param namespaceName string
param eventHubName string
param namespacePrincipalId string

var consumerGroupName = 'log-analytics-${substring(replace(namespacePrincipalId, '-', ''), 0, 16)}'

resource namespace 'Microsoft.EventHub/namespaces@2024-01-01' existing = {
  name: namespaceName
}
resource hub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' existing = {
  parent: namespace
  name: eventHubName
}
resource consumer 'Microsoft.EventHub/namespaces/eventhubs/consumergroups@2024-01-01' = {
  parent: hub
  name: consumerGroupName
  properties: {}
}

output consumerGroupName string = consumerGroupName
