# Microsoft 365 synthetic tests

This Node project contains all worker runtime and deployment code for Exchange, Teams, OneDrive, and SharePoint Online.

## Commands

Run from this [Node project directory](./).

| Command | Purpose |
| --- | --- |
| `npm run setup:ids` | Resolve and write generated IDs to `.env` beside root config |
| `npm run setup:reply-seeds` | Provision Exchange reply fixtures and write IDs to `.env` |
| `npm run onedrive:setup -- --apply` | Provision OneDrive folder access and write drive/folder IDs |
| `npm run setup:ids -- -SharePointOnly` | Discover SharePoint IDs as the worker identity; verify immutable deployed IDs without writes in hosted mode |
| `npm run deploy -- --plan` | Local deployment plan preview |
| `npm run deploy` | Deploy models, foundation, and workers |
| `npm run exchange -- --once` | Run one Exchange cycle |
| `npm run teams -- --once` | Run one Teams cycle |
| `npm run onedrive -- --once` | Run one OneDrive cycle |
| `npm run sharepoint -- --once` | Run selected SharePoint document/list lanes |
| `npm run typecheck` | TypeScript check |
| `npm run build` | Build project |

## Run one cycle

Live execution requires a host with the configured managed identity and approved
Microsoft 365 access. These commands exercise real resources in the checked-in
live profile, not a local simulation.

```sh
cd synthetic-tests
npm ci
npm run exchange -- --once
npm run teams -- --once
npm run onedrive -- --once
npm run sharepoint -- --once
```

Use `--tenant <alias>` when the config includes multiple tenants.
Live commands require `ENABLE_LIVE_M365=true` and approved resources/managed identities.
The checked-in profile enables one approved SharePoint site/library/folder/list
target; worker-identity discovery and live acceptance are separate required checks.
Before recurrence, verify a complete real cycle, owned-artifact cleanup and
accepted reporting; successful local checks or process startup are not that proof.

## Configuration

- Use root [monitoring.config.json](../monitoring.config.json) only.
- [Generated IDs](../docs/deployment.md#generated-ids-in-env) are stored in its adjacent gitignored `.env`.
- Service selection, scenarios, execution, and deployment all come from the root config.
- `logAnalytics.enabled` controls reporting path.
- `serviceHealth.enabled` controls provider context collection.
- All selected journeys run every 300 seconds with a 240-second whole-journey deadline; Exchange aligns to five-minute boundaries. Cleanup/reporting are separately bounded, and latency thresholds stay at 15/60 seconds.

## Services

- [Exchange](./exchange/README.md)
- [Teams](./teams/README.md)
- [OneDrive](./onedrive/README.md)
- [SharePoint Online](./sharepoint/README.md)
- [Shared runtime and deployment internals](./utils/README.md)
- [Hosting resources](./infra/README.md)

## Additional docs

- [Setup](../docs/setup.md)
- [Deployment details](../docs/deployment.md)
- [Operations](../docs/operations.md)
