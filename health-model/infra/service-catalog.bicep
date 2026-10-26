@export()
var providerActivityFunctions = {
  exchange: [
    'getConnectivityMetricsForExchange'
    'getMessageVolumeMetricsForEmailDelivery'
    'getActiveUserMetricsForOutlookWebByReadEmail'
    'getActiveUserMetricsForOutlookWebByAppOpening'
    'getActiveUserMetricsForEmailByModernAuthentication'
  ]
  teams: [
    'getUsageMetricsForTeamsByMeetingsJoined'
    'getUsageMetricsForTeamsByLaunch'
    'getMessageVolumeMetricsForTeamsChat'
    'getAudioStreamQoEMetricsForTeams'
    'getAudioStreamsOverUdpMetricsForTeams'
  ]
  sharepoint: []
  onedrive: []
}

type ServiceStep = {
  name: string
  displayName: string
}

@export()
type JourneyDefinition = {
  name: string
  entityName: string
  displayName: string
  steps: ServiceStep[]
  planned: bool?
}

@export()
type ServiceDefinition = {
  service: 'exchange' | 'teams' | 'sharepoint' | 'onedrive'
  displayName: string
  journeys: JourneyDefinition[]
}

@export()
var serviceDefinitions ServiceDefinition[] = [
  {
    service: 'exchange'
    displayName: 'Exchange Experience'
    journeys: [
      {
        name: 'send-receive-mail'
        entityName: 'exchange-global'
        displayName: 'Send and receive email'
        steps: [
          { name: 'create-draft', displayName: 'Create email' }
          { name: 'send', displayName: 'Send email' }
          { name: 'confirm-delivery', displayName: 'Confirm delivery' }
        ]
      }
      {
        name: 'edit-reopen-draft'
        entityName: 'exchange-draft'
        displayName: 'Save, edit and reopen draft'
        steps: [
          { name: 'create-draft', displayName: 'Create draft' }
          { name: 'read-initial-draft', displayName: 'Read saved draft' }
          { name: 'update-draft', displayName: 'Edit draft' }
          { name: 'read-draft', displayName: 'Reopen and verify draft' }
          { name: 'delete-draft', displayName: 'Delete draft' }
        ]
      }
      {
        name: 'attachment-reply-mail'
        entityName: 'exchange-attachment'
        displayName: 'Verify attachment and correlated reply'
        steps: [
          { name: 'send-attachment', displayName: 'Send attachment' }
          { name: 'verify-attachment', displayName: 'Verify delivered attachment hash' }
          { name: 'reply-mail', displayName: 'Reply from recipient' }
          { name: 'confirm-reply-mail', displayName: 'Verify correlated reply at sender' }
        ]
      }
      {
        name: 'distribution-list-mail'
        entityName: 'exchange-distribution'
        displayName: 'Deliver through distribution list'
        steps: [
          { name: 'send-group-mail', displayName: 'Send to distribution list' }
          { name: 'confirm-group-delivery', displayName: 'Verify every expected recipient' }
        ]
      }
      {
        name: 'recurring-calendar'
        entityName: 'exchange-recurring'
        displayName: 'Create, edit and remove recurring calendar event'
        steps: [
          { name: 'create-event', displayName: 'Create recurring series' }
          { name: 'read-occurrence', displayName: 'Read occurrence' }
          { name: 'update-event', displayName: 'Update recurring series' }
          { name: 'verify-event', displayName: 'Verify series and occurrence update' }
          { name: 'delete-event', displayName: 'Delete recurring series' }
        ]
      }
      {
        name: 'meeting-invitation'
        entityName: 'exchange-meeting'
        displayName: 'Invite, accept and cancel meeting'
        steps: [
          { name: 'create-meeting', displayName: 'Send meeting invitation' }
          { name: 'confirm-invitation', displayName: 'Read attendee invitation' }
          { name: 'verify-attendee-calendar', displayName: 'Verify attendee calendar event' }
          { name: 'accept-meeting', displayName: 'Accept as attendee' }
          { name: 'confirm-acceptance', displayName: 'Observe acceptance as organizer' }
          { name: 'cancel-meeting', displayName: 'Cancel as organizer' }
        ]
      }
    ]
  }
  {
    service: 'teams'
    displayName: 'Teams Experience'
    journeys: [
      {
        name: 'publish-channel-message'
        entityName: 'teams-global'
        displayName: 'Publish channel message'
        steps: [
          { name: 'post-message', displayName: 'Post message' }
          { name: 'confirm-publication', displayName: 'Confirm publication' }
        ]
      }
      {
        name: 'reply-channel-message'
        entityName: 'teams-reply'
        displayName: 'Reply in channel thread'
        steps: [
          { name: 'post-message', displayName: 'Post root message' }
          { name: 'post-reply', displayName: 'Post reply' }
          { name: 'confirm-reply', displayName: 'Confirm reply visibility' }
        ]
      }
      {
        name: 'call-test-user'
        entityName: 'teams-call'
        displayName: 'Place test calls and hang up'
        steps: [
          { name: 'place-call', displayName: 'Call dedicated test user' }
          { name: 'wait-before-hangup', displayName: 'Wait before hang-up' }
          { name: 'end-call', displayName: 'Hang up and confirm disconnected' }
        ]
      }
    ]
  }
  {
    service: 'sharepoint'
    displayName: 'SharePoint Experience'
    journeys: [
      {
        name: 'save-reopen-file'
        entityName: 'sharepoint-global'
        displayName: 'Save and reopen file'
        steps: [
          { name: 'verify-drive', displayName: 'Verify library' }
          { name: 'upload-file', displayName: 'Upload file' }
          { name: 'read-file', displayName: 'Read file' }
        ]
      }
      {
        name: 'rename-reopen-file'
        entityName: 'sharepoint-rename'
        displayName: 'Rename and reopen file'
        steps: [
          { name: 'verify-drive', displayName: 'Verify library' }
          { name: 'upload-file', displayName: 'Upload file' }
          { name: 'rename-file', displayName: 'Rename file' }
          { name: 'read-file', displayName: 'Reopen and verify file' }
        ]
      }
    ]
  }
]
