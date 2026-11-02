# OneDrive synthetic journeys

This service validates personal OneDrive user drives and app folders. Dedicated SharePoint sites/libraries/lists use the separate [SharePoint worker](../sharepoint/README.md).

## Journeys

| Scenario | Summary |
| --- | --- |
| `user-drive-roundtrip` | Create, enumerate, download/hash-verify and delete owned content in the selected folder |
| `app-folder-lifecycle` | Validate app folder create/read/update/delete flow |
| `document-versions` | Verify two revisions, enumerate history and download exact prior bytes; optionally rewrite prior bytes |

## Required setup

1. Follow [OneDrive permissions and setup](../../docs/onedrive-permissions.md) and configure account UPNs/folder names in root [monitoring.config.json](../../monitoring.config.json).
2. Resolve account user IDs:
   ```sh
   npm run setup:ids
   ```
3. Configure the separate setup managed identity in the service's `setup` block. Review the [bulk setup plan](../../docs/onedrive-setup.md#plan-apply-and-rerun) on the approved Azure host, then apply:
   ```sh
   npm run onedrive:setup -- --apply
   ```

## Run one cycle

Run from [synthetic-tests/](../) on a host with the configured managed identity
for live execution.

```sh
npm run onedrive -- --once
npm run onedrive -- --tenant <alias> --once
```

## Runtime behavior

- Each lane runs configured scenarios every 300 seconds.
- Each complete journey has a 240-second deadline; latency thresholds remain 15 seconds Degraded and 60 seconds Unhealthy.
- Each checked-in lane runs both accounts concurrently at the default concurrency three. Cleanup settlement allows 12 seconds and publication 30 within a 299-second whole-cycle envelope.
- Worker cancellation and cleanup-only outcomes are Unknown without numeric samples; genuine service failures/deadline expiry remain failures.
- [Setup-generated IDs](../../docs/deployment.md#generated-ids-in-env) are read from `.env` and bound to configured targets.
- Results retain business-step timing and sanitized diagnostics.

## Diagnostics

When troubleshooting failures, check:

- lane-level result payload for failed scenario/step
- Graph response status and operation name in emitted errors
- worker logs for setup-ID resolution and permission failures

## Related docs

- Worker runtime: [shared utilities](../utils/README.md)
- Root setup/deployment docs: [repository overview](../../README.md)
