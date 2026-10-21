type ServiceStep = {
  name: string
  displayName: string
}

@export()
type ServiceDefinition = {
  service: 'exchange' | 'teams' | 'sharepoint'
  displayName: string
  journey: string
  timeGrain: string
  successQuery: string
  latencyQuery: string
  stepSuccessQuery: string
  stepDurationQuery: string
  serviceHealthQuery: string
  steps: ServiceStep[]
}

@export()
var serviceDefinitions ServiceDefinition[] = [
  {
    service: 'exchange'
    displayName: 'Exchange Experience'
    journey: 'send-receive-mail'
    timeGrain: 'PT5M'
    successQuery: loadTextContent('../../synthetic-tests/exchange/queries/health-model/success-percentage.kql')
    latencyQuery: loadTextContent('../../synthetic-tests/exchange/queries/health-model/mean-latency.kql')
    stepSuccessQuery: loadTextContent('../../synthetic-tests/exchange/queries/health-model/step-success.kql')
    stepDurationQuery: loadTextContent('../../synthetic-tests/exchange/queries/health-model/step-duration.kql')
    serviceHealthQuery: loadTextContent('../../synthetic-tests/exchange/queries/health-model/service-health-status.kql')
    steps: [
      { name: 'authenticate', displayName: 'Authenticate' }
      { name: 'create-draft', displayName: 'Create email' }
      { name: 'send', displayName: 'Send email' }
      { name: 'confirm-delivery', displayName: 'Confirm delivery' }
      { name: 'cleanup', displayName: 'Cleanup' }
    ]
  }
  {
    service: 'teams'
    displayName: 'Teams Experience'
    journey: 'publish-channel-message'
    timeGrain: 'PT5M'
    successQuery: loadTextContent('../../synthetic-tests/teams/queries/health-model/success-percentage.kql')
    latencyQuery: loadTextContent('../../synthetic-tests/teams/queries/health-model/mean-latency.kql')
    stepSuccessQuery: loadTextContent('../../synthetic-tests/teams/queries/health-model/step-success.kql')
    stepDurationQuery: loadTextContent('../../synthetic-tests/teams/queries/health-model/step-duration.kql')
    serviceHealthQuery: loadTextContent('../../synthetic-tests/teams/queries/health-model/service-health-status.kql')
    steps: [
      { name: 'authenticate', displayName: 'Authenticate' }
      { name: 'post-message', displayName: 'Post message' }
      { name: 'confirm-publication', displayName: 'Confirm publication' }
      { name: 'cleanup', displayName: 'Cleanup' }
    ]
  }
  {
    service: 'sharepoint'
    displayName: 'SharePoint Experience'
    journey: 'save-reopen-file'
    timeGrain: 'PT15M'
    successQuery: loadTextContent('../../synthetic-tests/sharepoint/queries/health-model/success-percentage.kql')
    latencyQuery: loadTextContent('../../synthetic-tests/sharepoint/queries/health-model/mean-latency.kql')
    stepSuccessQuery: loadTextContent('../../synthetic-tests/sharepoint/queries/health-model/step-success.kql')
    stepDurationQuery: loadTextContent('../../synthetic-tests/sharepoint/queries/health-model/step-duration.kql')
    serviceHealthQuery: loadTextContent('../../synthetic-tests/sharepoint/queries/health-model/service-health-status.kql')
    steps: [
      { name: 'authenticate', displayName: 'Authenticate' }
      { name: 'verify-drive', displayName: 'Verify library' }
      { name: 'upload-file', displayName: 'Upload file' }
      { name: 'read-file', displayName: 'Read file' }
      { name: 'cleanup', displayName: 'Cleanup' }
    ]
  }
]
