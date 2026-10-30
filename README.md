# Monitoring M365 with Azure Monitor Health Models

This repository deploys Azure Monitor Health Models and Microsoft 365 synthetic workers from a single root configuration: [`monitoring.config.json`](./monitoring.config.json).

The health model helps administrators monitor Microsoft 365 in terms of completed tasks rather than isolated API responses. API-backed synthetic journeys provide success and latency signals, and the model connects business steps and journeys to Exchange, Teams, OneDrive, and the overall Microsoft 365 experience. This dependency-based view makes observed impact easier to trace and supports experience-level alerts, while Microsoft-reported Service Health remains separate supporting context.

![Exchange Experience health model showing Mail and Calendar journeys, business-step health, and separate Service Health context](./docs/images/exchange-health-model.png)


## Supported journeys

| Service | Journey | What it tests | How it works |
| --- | --- | --- | --- |
| Exchange | `send-receive-mail` | Mail submission and Inbox delivery | Create a message, send it to the same mailbox, and poll its Inbox for the matching message. |
| Exchange | `edit-reopen-draft` | Draft persistence and edits | Create and read a draft, edit it, reopen and verify the saved changes, then delete it. |
| Exchange | `attachment-mail` | Attachment delivery and content integrity | Send an attachment to self, find the delivered message, download the attachment, and verify its content hash. |
| Exchange | `reply-mail` | Reply delivery and conversation correlation | Reply to a pre-provisioned, received self-addressed message and verify the correlated reply in the same mailbox's Inbox. |
| Exchange | `recurring-calendar` | Recurring calendar persistence and updates | Create a private recurring series without attendees, read an occurrence, update and verify the series and occurrence, then delete it. |
| Teams | `channel-conversation` | Bot channel posts and threaded replies | Each pair's primary bot posts a root message and reply; Graph readback verifies both persisted authors and correlation markers. |
| Teams | `scheduled-meeting` | Bot-only meeting connectivity and departure | Both bots join a dedicated, existing meeting, verify established calls, meeting metadata and both participant rosters, then leave and confirm disconnection. |
| OneDrive | `user-drive-roundtrip` | File persistence and content integrity | Create an owned folder and file beneath the approved test folder, enumerate and download the file, verify its hash, then delete and verify removal. |
| OneDrive | `app-folder-lifecycle` | App-folder data persistence and lifecycle | Create a cycle-owned folder in the app folder, write and read data, update and reread it, then delete the folder and verify removal. |
| OneDrive | `document-versions` | Version history and prior content retrieval | Write and verify two revisions, enumerate versions, download and verify prior-version bytes, and optionally rewrite those bytes as current content before cleanup. |

## Test accounts and bots

Exchange and OneDrive use dedicated, licensed Microsoft 365 test accounts because mailboxes, calendars, and personal drives are user resources. This exercises real delivery and persistence rather than mocked API responses. The accounts are test targets, not worker sign-in credentials: hosted workers authenticate app-only using managed identities. Teams uses managed-identity bot pairs so channel and meeting journeys run unattended without human participants or interactive runtime sign-in. These checks cover API and bot behavior, not employee client interfaces or audio quality.

## Quick start

1. Complete prerequisites and access grants in [`docs/setup.md`](./docs/setup.md).
2. From [`synthetic-tests/`](./synthetic-tests/), install dependencies:
   ```sh
   npm ci
   ```
3. Populate the [generated ID bindings](./docs/deployment.md#generated-ids-in-env):
   ```sh
   npm run setup:ids
   npm run setup:reply-seeds      # when Exchange reply journey is enabled
   npm run onedrive:setup -- --apply  # when OneDrive is enabled
   ```
4. Preview and deploy:
   ```sh
   npm run deploy -- --plan
   npm run deploy
   ```

## Configuration

- Use only root [`monitoring.config.json`](./monitoring.config.json).
- Keep [generated per-target ID bindings](./docs/deployment.md#generated-ids-in-env) beside the config.
- `logAnalytics.enabled` controls direct reports (`false`) vs observation pipeline (`true`).
- `serviceHealth.enabled` controls provider context entities and collection.

## References

- Setup: [docs/setup.md](./docs/setup.md)
- Deployment flow: [docs/deployment.md](./docs/deployment.md)
- Operations and monitoring: [docs/operations.md](./docs/operations.md)
- Architecture diagrams: [docs/architecture.md](./docs/architecture.md)
- Group configuration: [docs/monitoring-groups.md](./docs/monitoring-groups.md)
- Worker details: [synthetic-tests/README.md](./synthetic-tests/README.md)
- Model details: [health-model/README.md](./health-model/README.md)
