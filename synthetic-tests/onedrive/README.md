# OneDrive synthetic journeys

This service validates OneDrive and SharePoint-backed file operations for configured user drives and app folders.

## Journeys

| Scenario | Summary |
| --- | --- |
| `user-drive-roundtrip` | Upload, read, update, and delete in a user drive |
| `app-folder-lifecycle` | Validate app folder create/read/update/delete flow |
| `document-versions` | Update file and verify version history behavior |

## Required setup

1. Configure OneDrive targets in root `monitoring.config.json`.
2. Populate setup credentials in root config (`setup.enabled: true`) and run:
   ```sh
   npm run onedrive:setup -- --apply
   ```
3. Resolve generated IDs:
   ```sh
   npm run setup:ids
   ```

## Run locally

```sh
npm run onedrive -- --once
npm run onedrive -- --tenant <alias> --once
```

## Runtime behavior

- Each lane runs configured scenarios on a fixed cycle interval.
- Setup-generated IDs are read from `.env` and bound to configured targets.
- Results include per-step latency and resource IDs for cleanup troubleshooting.

## Diagnostics

When troubleshooting failures, check:

- lane-level result payload for failed scenario/step
- Graph response status and operation name in emitted errors
- worker logs for setup-ID resolution and permission failures

## Related docs

- Worker runtime: `../utils/README.md`
- Root setup/deployment docs: `../../README.md`
