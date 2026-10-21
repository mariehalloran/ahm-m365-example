targetScope = 'resourceGroup'

@description('The approved root configuration. Keep credentials out of this object.')
param projectConfig object = loadJsonContent('../../monitoring.config.json')
@description('Resolved service-owned files, prepared from root configFile paths by deployment:prepare.')
param serviceConfigs object = {
  exchange: loadJsonContent('../exchange/config.json')
  teams: loadJsonContent('../teams/config.json')
  sharepoint: loadJsonContent('../sharepoint/config.json')
}
param location string = resourceGroup().location
@description('First deploy false to establish the private registry and identities; then deploy the built image.')
param deployWorkers bool = false
param workerImage string = ''
@description('Separate Microsoft 365 mutation gate; simulation deployments leave this false.')
param enableLiveProbes bool = false

var modelName = projectConfig.healthModel.name
var services = filter(
  ['exchange', 'teams', 'sharepoint'],
  service =>
    projectConfig.services[service].enabled && !empty(filter(
      items(projectConfig.services[service].scenarios),
      scenario => scenario.value
    ))
)
var resourceToken = uniqueString(resourceGroup().id, modelName)
var registryName = 'crm365${resourceToken}'
var tags = { workload: modelName, purpose: 'synthetic-worker' }

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: registryName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
    roleAssignmentMode: 'LegacyRegistryPermissions'
  }
}

resource environment 'Microsoft.App/managedEnvironments@2026-07-01' = {
  name: 'cae-${modelName}'
  location: location
  tags: tags
  properties: {
    // Console streaming works without configuring workspace log forwarding.
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

resource reportWriter 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, modelName, 'health-report-writer')
  properties: {
    roleName: '${modelName} health report writer'
    description: 'Publish health reports only; no model administration or Microsoft 365 access.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: ['Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action']
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = [
  for service in services: {
    name: 'uami-${modelName}-${service}'
    location: location
    tags: tags
  }
]

resource models 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' existing = [
  for service in services: {
    name: '${modelName}-${service}'
  }
]

resource reportAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (service, index) in services: {
    name: guid(models[index].id, identities[index].id, reportWriter.id)
    scope: models[index]
    properties: {
      roleDefinitionId: reportWriter.id
      principalId: identities[index].properties.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

resource imagePullAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for (service, index) in services: {
    name: guid(registry.id, identities[index].id, 'acr-pull')
    scope: registry
    properties: {
      roleDefinitionId: subscriptionResourceId(
        'Microsoft.Authorization/roleDefinitions',
        '7f951dda-4ed3-4680-a7ca-43fe172d538d'
      )
      principalId: identities[index].properties.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

module workers './worker.bicep' = [
  for (service, index) in services: if (deployWorkers) {
    name: '${service}-worker'
    params: {
      appName: 'm365-${take(resourceToken, 6)}-${service}'
      location: location
      tags: tags
      environmentId: environment.id
      registryServer: registry.properties.loginServer
      identityResourceId: identities[index].id
      identityClientId: identities[index].properties.clientId
      tenantId: subscription().tenantId
      workerImage: workerImage
      projectConfig: projectConfig
      serviceConfig: serviceConfigs[service]
      enableLiveProbes: enableLiveProbes
    }
    dependsOn: [reportAssignments, imagePullAssignments]
  }
]

output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output environmentId string = environment.id
output appNames array = [for service in services: 'm365-${take(resourceToken, 6)}-${service}']
output identityIds array = [for (service, index) in services: identities[index].id]
