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
  telemetryName: string?
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
        displayName: 'Two bots join a meeting, verify roster, play audio and leave'
        steps: [
          { name: 'place-call', displayName: 'Join dedicated meeting as two distinct bots' }
          { name: 'wait-for-answer', displayName: 'Verify both owned calls established' }
          { name: 'verify-participants', displayName: 'Verify both bot identities in both meeting rosters' }
          { name: 'play-audio', displayName: 'Play test tone and verify operation completion' }
          { name: 'end-call', displayName: 'Leave both owned calls and verify disconnected' }
        ]
      }
    ]
  }
  {
    service: 'onedrive'
    displayName: 'OneDrive Experience'
    journeys: [
      {
        name: 'user-drive-roundtrip'
        entityName: 'onedrive-planned-user-drive-roundtrip'
        displayName: 'Create, reopen, verify and delete user-drive file'
        steps: [
          { name: 'step-1', telemetryName: 'create-folder-file', displayName: 'Create owned folder and file in selected folder' }
          { name: 'step-2', telemetryName: 'reopen-file', displayName: 'Enumerate and download owned file' }
          { name: 'step-3', telemetryName: 'verify-file-hash', displayName: 'Verify exact content hash' }
          { name: 'step-4', telemetryName: 'delete-owned-artifacts', displayName: 'Delete owned artifacts and verify removal' }
        ]
      }
      {
        name: 'app-folder-lifecycle'
        entityName: 'onedrive-planned-app-folder-lifecycle'
        displayName: 'Persist, reopen and update app-folder data'
        steps: [
          { name: 'step-1', telemetryName: 'write-app-data', displayName: 'Verify prior state and write app-folder data' }
          { name: 'step-2', telemetryName: 'read-app-data', displayName: 'Read and verify data' }
          { name: 'step-3', telemetryName: 'update-app-data', displayName: 'Update, reread and verify persisted state' }
          { name: 'step-4', telemetryName: 'delete-app-scratch', displayName: 'Delete owned scratch data; retain safe state' }
        ]
      }
      {
        name: 'document-versions'
        entityName: 'onedrive-planned-document-versions'
        displayName: 'Update document and retrieve prior version'
        steps: [
          { name: 'step-1', telemetryName: 'update-document', displayName: 'Write and verify two document revisions' }
          { name: 'step-2', telemetryName: 'list-versions', displayName: 'Enumerate actual document version history' }
          { name: 'step-3', telemetryName: 'read-prior-version', displayName: 'Download prior version and verify bytes' }
          { name: 'step-4', telemetryName: 'restore-version', displayName: 'Optional: restore downloaded prior bytes and verify' }
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
