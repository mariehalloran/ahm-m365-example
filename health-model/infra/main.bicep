targetScope = 'resourceGroup'

@description('Name of the isolated proof-of-concept health model.')
@minLength(3)
@maxLength(44)
param modelName string = 'm365-experience-poc'

@description('A region supporting Microsoft.CloudHealth, normally the resource group location.')
param location string = resourceGroup().location

var entities = [
  // The service creates this root automatically; manage its rollup rather than leave it disconnected.
  { name: modelName, displayName: 'Microsoft 365 Synthetic Health Model (PoC)', x: 600, y: 0, rollup: true, impact: 'Standard' }
  { name: 'm365-tenant', displayName: 'Microsoft 365 and Azure Experience', x: 600, y: 180, rollup: true, impact: 'Standard' }
  { name: 'azure-resources', displayName: 'Azure Resource Health - not connected', x: 0, y: 400, rollup: false, impact: 'Standard' }
  { name: 'exchange-experience', displayName: 'Exchange Experience', x: 300, y: 400, rollup: true, impact: 'Standard' }
  { name: 'exchange-global', displayName: 'Exchange Mail-flow Cohort - not connected', x: 300, y: 620, rollup: false, impact: 'Standard' }
  { name: 'teams-experience', displayName: 'Teams Experience', x: 600, y: 400, rollup: true, impact: 'Standard' }
  { name: 'teams-global', displayName: 'Teams Cohort - not implemented', x: 600, y: 620, rollup: false, impact: 'Standard' }
  { name: 'sharepoint-experience', displayName: 'SharePoint Experience', x: 900, y: 400, rollup: true, impact: 'Standard' }
  { name: 'sharepoint-global', displayName: 'SharePoint File Cohort - not connected', x: 900, y: 620, rollup: false, impact: 'Standard' }
  { name: 'monitoring-pipeline', displayName: 'Monitoring Pipeline', x: 1200, y: 400, rollup: true, impact: 'Standard' }
  { name: 'runner-heartbeat', displayName: 'Runner Heartbeat - runner not deployed', x: 1100, y: 620, rollup: false, impact: 'Standard' }
  { name: 'graph-availability', displayName: 'Graph Query Availability - not connected', x: 1350, y: 620, rollup: false, impact: 'Standard' }
  { name: 'provider-context', displayName: 'Microsoft 365 Service Health - supporting context', x: 1550, y: 400, rollup: false, impact: 'Suppressed' }
]

var relationships = [
  { parent: modelName, child: 'm365-tenant' }
  { parent: 'm365-tenant', child: 'azure-resources' }
  { parent: 'm365-tenant', child: 'exchange-experience' }
  { parent: 'm365-tenant', child: 'teams-experience' }
  { parent: 'm365-tenant', child: 'sharepoint-experience' }
  { parent: 'm365-tenant', child: 'monitoring-pipeline' }
  { parent: 'exchange-experience', child: 'exchange-global' }
  { parent: 'teams-experience', child: 'teams-global' }
  { parent: 'sharepoint-experience', child: 'sharepoint-global' }
  { parent: 'monitoring-pipeline', child: 'runner-heartbeat' }
  { parent: 'monitoring-pipeline', child: 'graph-availability' }
]

resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' = {
  name: modelName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  tags: {
    purpose: 'Microsoft 365 synthetic monitoring proof of concept'
    deploymentStage: 'model-only'
    intendedRunnerHost: 'Azure Container Apps'
  }
  properties: {}
}

resource modelEntities 'Microsoft.CloudHealth/healthmodels/entities@2026-05-01-preview' = [for entity in entities: {
  parent: model
  name: entity.name
  properties: {
    displayName: entity.displayName
    impact: entity.impact
    canvasPosition: {
      x: entity.x
      y: entity.y
    }
    signalGroups: entity.rollup ? {
      dependencies: {
        aggregationType: 'WorstOf'
        ignoreUnknown: false
      }
    } : {}
  }
}]

resource modelRelationships 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = [for relationship in relationships: {
  parent: model
  name: '${relationship.parent}-to-${relationship.child}'
  properties: {
    parentEntityName: relationship.parent
    childEntityName: relationship.child
  }
  dependsOn: [
    modelEntities
  ]
}]

output modelId string = model.id
output modelName string = model.name
output rootEntityName string = modelName
output apiVersion string = '2026-05-01-preview'
output entityNames array = [for entity in entities: entity.name]
output entityCount int = length(entities)
output relationshipCount int = length(relationships)
