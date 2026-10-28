// Metadata is authored in synthetic-tests/utils/src/catalog.ts.
type ServiceStep = {
  name: string
  displayName: string
  telemetryName: string?
}

@export()
type JourneyGroupDefinition = {
  entityName: string
  displayName: string
}

@export()
type JourneyDefinition = {
  name: string
  entityName: string
  displayName: string
  group: JourneyGroupDefinition?
  steps: ServiceStep[]
}

@export()
func getJourneyGroups(journeys JourneyDefinition[]) JourneyGroupDefinition[] =>
  union(map(filter(journeys, journey => journey.?group != null), journey => journey.group!), [])

@export()
type ServiceDefinition = {
  service: 'exchange' | 'teams' | 'onedrive'
  displayName: string
  journeys: JourneyDefinition[]
}

@export()
var serviceDefinitions ServiceDefinition[] = loadJsonContent('../../synthetic-tests/utils/src/catalog.json', '$.serviceDefinitions')
