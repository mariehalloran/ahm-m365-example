targetScope = 'resourceGroup'

param registryName string
param assignments array

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: registryName
}
resource imagePull 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for assignment in assignments: {
    name: guid(registry.id, assignment.identityId, 'acr-pull')
    scope: registry
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
      principalId: assignment.principalId
      principalType: 'ServicePrincipal'
    }
  }
]
