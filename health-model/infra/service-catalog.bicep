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
    | 'update-draft'
    | 'read-draft'
    | 'post-reply'
    | 'confirm-reply'
    | 'rename-file'
  displayName: string
}

@export()
type JourneyDefinition = {
  name: string
  entityName: string
  displayName: string
  steps: ServiceStep[]
}

@export()
type ServiceDefinition = {
  service: 'exchange' | 'teams' | 'sharepoint'
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
          { name: 'update-draft', displayName: 'Edit draft' }
          { name: 'read-draft', displayName: 'Reopen and verify draft' }
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
