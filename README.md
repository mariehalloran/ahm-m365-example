# Monitoring M365 with Azure Monitor Health Models

This repository deploys Azure Monitor Health Models and Microsoft 365 synthetic workers from a single root configuration: `monitoring.config.json`.

## Repository layout

- `health-model/` - model topology and signal wiring
- `synthetic-tests/` - Exchange, Teams, and OneDrive workers plus deployment command
- `monitoring.config.json` - single user-owned config for services, targets, execution, and deployment

## Supported journeys

| Service | Journeys |
| --- | --- |
| Exchange | `send-receive-mail`, `edit-reopen-draft`, `attachment-mail`, `reply-mail`, `recurring-calendar` |
| Teams | `channel-conversation`, `scheduled-meeting` |
| OneDrive | `user-drive-roundtrip`, `app-folder-lifecycle`, `document-versions` |

## Quick start

1. Complete prerequisites and access grants in `docs/setup.md`.
2. From `synthetic-tests/`, install dependencies:
   ```sh
   npm ci
   ```
3. Populate generated IDs in `.env`:
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

- Use only root `monitoring.config.json`.
- Keep generated per-target IDs in `.env` beside the config.
- `logAnalytics.enabled` controls direct reports (`false`) vs observation pipeline (`true`).
- `serviceHealth.enabled` controls provider context entities and collection.

## References

- Setup: `docs/setup.md`
- Deployment flow: `docs/deployment.md`
- Operations and monitoring: `docs/operations.md`
- Architecture diagrams: `docs/architecture.md`
- Group configuration: `docs/monitoring-groups.md`
- Worker details: `synthetic-tests/README.md`
- Model details: `health-model/README.md`
