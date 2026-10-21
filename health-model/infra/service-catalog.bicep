type ServiceStep = {
  name:
    | 'create-draft'
    | 'send'
    | 'confirm-delivery'
    | 'post-message'
    | 'confirm-publication'
    | 'verify-drive'
    | 'upload-file'
    | 'read-file'
  displayName: string
}

@export()
type JourneyDefinition = {
  name: string
  entityName: string
  displayName: string
  timeGrain: string
  successQuery: string
  latencyQuery: string
  latencyDisplayName: string
  stepSuccessQuery: string
  stepDurationQuery: string
  steps: ServiceStep[]
}

@export()
type ServiceDefinition = {
  service: 'exchange' | 'teams' | 'sharepoint'
  displayName: string
  serviceHealthQuery: string
  journeys: JourneyDefinition[]
}

@export()
var serviceDefinitions ServiceDefinition[] = [
  {
    service: 'exchange'
    displayName: 'Exchange Experience'
    serviceHealthQuery: loadTextContent('../../synthetic-tests/exchange/queries/health-model/service-health-status.kql')
    journeys: [
      {
        name: 'send-receive-mail'
        entityName: 'exchange-global'
        displayName: 'Send and receive email'
        timeGrain: 'PT5M'
        successQuery: loadTextContent('../../synthetic-tests/exchange/queries/health-model/success-percentage.kql')
        latencyQuery: loadTextContent('../../synthetic-tests/exchange/queries/health-model/mean-latency.kql')
        latencyDisplayName: 'Confirmed delivery - mean duration (ms)'
        stepSuccessQuery: loadTextContent('../../synthetic-tests/exchange/queries/health-model/step-success.kql')
        stepDurationQuery: loadTextContent('../../synthetic-tests/exchange/queries/health-model/step-duration.kql')
        steps: [
          { name: 'create-draft', displayName: 'Create email' }
          { name: 'send', displayName: 'Send email' }
          { name: 'confirm-delivery', displayName: 'Confirm delivery' }
        ]
      }
    ]
  }
  {
    service: 'teams'
    displayName: 'Teams Experience'
    serviceHealthQuery: loadTextContent('../../synthetic-tests/teams/queries/health-model/service-health-status.kql')
    journeys: [
      {
        name: 'publish-channel-message'
        entityName: 'teams-global'
        displayName: 'Publish channel message'
        timeGrain: 'PT5M'
        successQuery: loadTextContent('../../synthetic-tests/teams/queries/health-model/success-percentage.kql')
        latencyQuery: loadTextContent('../../synthetic-tests/teams/queries/health-model/mean-latency.kql')
        latencyDisplayName: 'Confirmed publication - mean duration (ms)'
        stepSuccessQuery: loadTextContent('../../synthetic-tests/teams/queries/health-model/step-success.kql')
        stepDurationQuery: loadTextContent('../../synthetic-tests/teams/queries/health-model/step-duration.kql')
        steps: [
          { name: 'post-message', displayName: 'Post message' }
          { name: 'confirm-publication', displayName: 'Confirm publication' }
        ]
      }
    ]
  }
  {
    service: 'sharepoint'
    displayName: 'SharePoint Experience'
    serviceHealthQuery: loadTextContent('../../synthetic-tests/sharepoint/queries/health-model/service-health-status.kql')
    journeys: [
      {
        name: 'save-reopen-file'
        entityName: 'sharepoint-global'
        displayName: 'Save and reopen file'
        timeGrain: 'PT15M'
        successQuery: loadTextContent('../../synthetic-tests/sharepoint/queries/health-model/success-percentage.kql')
        latencyQuery: loadTextContent('../../synthetic-tests/sharepoint/queries/health-model/mean-latency.kql')
        latencyDisplayName: 'Whole journey - mean duration (ms)'
        stepSuccessQuery: loadTextContent('../../synthetic-tests/sharepoint/queries/health-model/step-success.kql')
        stepDurationQuery: loadTextContent('../../synthetic-tests/sharepoint/queries/health-model/step-duration.kql')
        steps: [
          { name: 'verify-drive', displayName: 'Verify library' }
          { name: 'upload-file', displayName: 'Upload file' }
          { name: 'read-file', displayName: 'Read file' }
        ]
      }
    ]
  }
]
