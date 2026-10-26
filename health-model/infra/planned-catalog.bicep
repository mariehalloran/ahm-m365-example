import { ServiceDefinition } from './service-catalog.bicep'

func journey(service string, name string, displayName string, steps string[]) object => {
  name: name
  entityName: '${service}-planned-${name}'
  displayName: '[Planned / unimplemented] ${displayName}'
  planned: true
  steps: map(steps, (step, index) => {
    name: 'step-${index + 1}'
    displayName: step
  })
}

@export()
var plannedServiceDefinitions ServiceDefinition[] = [
  {
    service: 'exchange'
    displayName: 'Exchange Experience'
    journeys: [
      journey('exchange', 'search-organize-mail', 'Search and organize mailbox', [
        'Create owned searchable mail'
        'Find and verify owned mail'
        'Organize and verify the change'
      ])
      journey('exchange', 'external-inbound', 'External inbound delivery variant', [
        'Send from approved external participant'
        'Verify correlated delivery in monitored mailbox'
      ])
      journey('exchange', 'external-outbound', 'External outbound delivery variant', [
        'Send to approved external participant'
        'Verify correlated delivery as external recipient'
      ])
      journey('exchange', 'outlook-web', 'OutlookWeb browser variant', [
        'Sign in through OutlookWeb'
        'Complete and verify mail workflow in browser'
      ])
    ]
  }
  {
    service: 'teams'
    displayName: 'Teams Experience'
    journeys: [
      journey('teams', 'two-bot-conversation', 'Two-bot channel conversation', [
        'Bot A sends correlated message'
        'Bot B receives message and replies'
        'Bot A receives correlated response'
        'Verify persisted content and authors'
      ])
      journey('teams', 'answered-audio', 'Answered two-party audio', [
        'Place and answer call'
        'Exchange known audio bidirectionally'
        'Verify continuity, delay and distortion'
        'Hang up'
      ])
      journey('teams', 'scheduled-meeting', 'Scheduled meeting', [
        'Join scheduled meeting'
        'Verify participant roster'
        'Exchange and verify bidirectional media'
        'Leave meeting'
      ])
      journey('teams', 'recipient-file-sharing', 'Recipient file sharing', [
        'Share owned file'
        'Retrieve as intended recipient'
        'Verify content hash'
      ])
      journey('teams', 'adaptive-card', 'Adaptive Card workflow', [
        'Publish card'
        'Invoke card action'
        'Verify workflow and callback completion'
      ])
      journey('teams', 'teams-web-messaging', 'TeamsWeb messaging browser variant', [
        'Sign in through TeamsWeb'
        'Send and verify correlated browser conversation'
      ])
      journey('teams', 'teams-web-meeting', 'TeamsWeb meeting browser variant', [
        'Join meeting through TeamsWeb'
        'Verify participant and media experience'
        'Leave meeting'
      ])
    ]
  }
  {
    service: 'sharepoint'
    displayName: 'SharePoint Experience'
    journeys: [
      journey('sharepoint', 'library-folder-roundtrip', 'Full site/library and folder/file roundtrip', [
        'Verify site and library metadata'
        'Create nested folders and upload owned file'
        'Enumerate and download file'
        'Verify content hash'
        'Delete owned artifacts'
      ])
      journey('sharepoint', 'list-item-lifecycle', 'List-item lifecycle', [
        'Create dedicated list item'
        'Read item'
        'Update and reread item'
        'Delete owned item'
      ])
      journey('sharepoint', 'recipient-sharing', 'Recipient-specific sharing', [
        'Grant recipient access'
        'Retrieve and verify as intended recipient'
        'Revoke access'
        'Verify access removal'
      ])
      journey('sharepoint', 'document-versions', 'Document versions', [
        'Update owned document'
        'Inspect version history'
        'Retrieve and verify earlier version'
        'Optional variant: restore earlier version'
        'Optional variant: check out and check in'
      ])
      journey('sharepoint', 'search-indexing', 'Search and indexing', [
        'Create owned searchable content'
        'Wait for indexing and find content'
        'Retrieve search result and verify content'
      ])
      journey('sharepoint', 'browser-upload', 'Browser upload variant', [
        'Sign in through SharePoint browser'
        'Upload and reopen owned file in browser'
        'Verify content'
      ])
    ]
  }
  {
    service: 'onedrive'
    displayName: '[Planned / unimplemented] OneDrive Experience'
    journeys: [
      journey('onedrive', 'user-drive-roundtrip', 'User-drive roundtrip', [
        'Create folder and file in approved user drive'
        'Reopen and download file'
        'Verify content hash'
        'Delete owned artifacts'
      ])
      journey('onedrive', 'app-folder-lifecycle', 'App-folder lifecycle', [
        'Write app-folder data'
        'Read data'
        'Update and verify data'
        'Delete owned data'
      ])
      journey('onedrive', 'recipient-sharing', 'Recipient sharing', [
        'Create sharing link or grant'
        'Read and verify as intended recipient'
        'Revoke access'
        'Verify access removal'
      ])
      journey('onedrive', 'document-versions', 'Document versions', [
        'Update owned document'
        'Enumerate version history'
        'Retrieve and verify earlier version'
        'Optional variant: restore earlier version'
      ])
      journey('onedrive', 'search-retrieve', 'Search and retrieve', [
        'Create owned searchable file'
        'Wait for indexing and find file'
        'Retrieve and verify content'
      ])
      journey('onedrive', 'browser-upload', 'Browser file variant', [
        'Sign in through OneDrive browser'
        'Upload and reopen owned file in browser'
        'Verify content'
      ])
    ]
  }
]
