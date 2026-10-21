targetScope = 'resourceGroup'

import { ServiceDefinition } from './service-catalog.bicep'

@minLength(3)
@maxLength(44)
param modelName string
param location string
param service ServiceDefinition

func sourceGroup(name string, displayName string, members string[]) object => {
  name: name
  displayName: displayName
  aggregationType: 'WorstOf'
  ignoreUnknown: false
  members: members
}

var contextName = '${service.service}-service-health'
var nodes = concat(
  [
    {
      name: modelName
      displayName: service.displayName
      kind: 'root'
      rollup: true
      impact: 'Standard'
      x: 300
      y: 0
    }
    {
      name: contextName
      displayName: 'Service Health'
      kind: 'context'
      rollup: false
      impact: 'Suppressed'
      x: 0
      y: 240
    }
  ],
  map(service.journeys, journey => {
    name: journey.entityName
    displayName: journey.displayName
    kind: 'journey'
    rollup: true
    impact: 'Standard'
    x: 400 + indexOf(service.journeys, journey) * 500
    y: 240
  }),
  flatten(map(
    service.journeys,
    journey =>
      map(journey.steps, step => {
        name: '${journey.entityName}-${step.name}'
        displayName: step.displayName
        kind: 'step'
        rollup: false
        impact: 'Standard'
        x: 400 + indexOf(service.journeys, journey) * 500
        y: 440 + indexOf(journey.steps, step) * 170
      })
  ))
)
var relationships = concat(
  [{ parent: modelName, child: contextName }],
  map(service.journeys, journey => { parent: modelName, child: journey.entityName }),
  flatten(map(
    service.journeys,
    journey =>
      map(journey.steps, step => {
        parent: journey.entityName
        child: '${journey.entityName}-${step.name}'
      })
  ))
)
resource model 'Microsoft.CloudHealth/healthmodels@2026-05-01-preview' = {
  name: modelName
  location: location
  identity: { type: 'SystemAssigned' }
  tags: { purpose: 'Microsoft 365 synthetic monitoring', service: service.service }
  properties: {}
}
resource entities 'Microsoft.CloudHealth/healthmodels/entities@2026-10-01-preview' = [
  for node in nodes: {
    parent: model
    name: node.name
    properties: union(
      {
        displayName: node.displayName
        impact: node.impact
        canvasPosition: { x: node.x, y: node.y }
        signalGroups: node.rollup ? { dependencies: { aggregationType: 'WorstOf', ignoreUnknown: false } } : {}
      },
      node.kind == 'root'
        ? {}
        : {
            signalAggregationGroups: [
              sourceGroup(
                'external-reports',
                'External Reports',
                node.kind == 'context'
                  ? ['microsoft-reported-service-status']
                  : ['synthetic-success-percentage', 'synthetic-mean-duration']
              )
            ]
          }
    )
  }
]
resource modelRelationships 'Microsoft.CloudHealth/healthmodels/relationships@2026-05-01-preview' = [
  for relationship in relationships: {
    parent: model
    name: '${relationship.parent}-to-${relationship.child}'
    properties: { parentEntityName: relationship.parent, childEntityName: relationship.child }
    dependsOn: [entities]
  }
]

output modelId string = model.id
output rootEntityName string = model.name
output entityNames array = [for node in nodes: node.name]
