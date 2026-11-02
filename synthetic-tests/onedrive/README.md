# OneDrive synthetic journeys

This service validates OneDrive and SharePoint-backed file operations for configured user drives and app folders.

## Journeys

| Scenario | Summary |
| --- | --- |
| `user-drive-roundtrip` | Create, enumerate, download/hash-verify and delete owned content in the selected folder |
| `app-folder-lifecycle` | Validate app folder create/read/update/delete flow |
| `document-versions` | Update file and verify version history behavior |

## Required setup

1. Follow [OneDrive permissions and setup](../../docs/onedrive-permissions.md) and configure account UPNs/folder names in root `monitoring.config.json`.
2. Resolve account user IDs:
   ```sh
   npm run setup:ids
   ```
3. Configure the separate setup managed identity in the service's `setup` block. Review the [bulk setup plan](../../docs/onedrive-setup.md#plan-apply-and-rerun) on the approved Azure host, then apply:
   ```sh
   npm run onedrive:setup -- --apply
   ```

## Run locally

```sh
npm run onedrive -- --once
npm run onedrive -- --tenant <alias> --once
```

## Runtime behavior

- Each lane runs configured scenarios on a fixed cycle interval.
- Each complete journey has a 120-second deadline and a separate 15-second latency degradation threshold.
- Worker cancellation and cleanup-only outcomes are Unknown without numeric samples; genuine service failures/deadline expiry remain failures.
- Setup-generated IDs are read from `.env` and bound to configured targets.
- Results include per-step latency and resource IDs for cleanup troubleshooting.

## Diagnostics

When troubleshooting failures, check:

- lane-level result payload for failed scenario/step
- Graph response status and operation name in emitted errors
- worker logs for setup-ID resolution and permission failures

## Related docs

- Worker runtime: [shared utilities](../utils/README.md)
- Root setup/deployment docs: [repository overview](../../README.md)
