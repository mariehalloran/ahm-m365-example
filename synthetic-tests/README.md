# Microsoft 365 synthetic tests

This Node project contains all worker runtime and deployment code for Exchange, Teams, and OneDrive.

## Commands

Run from `synthetic-tests/`.

| Command | Purpose |
| --- | --- |
| `npm run setup:ids` | Resolve and write generated IDs to `.env` beside root config |
| `npm run setup:reply-seeds` | Provision Exchange reply fixtures and write IDs to `.env` |
| `npm run onedrive:setup -- --apply` | Provision OneDrive folder access and write drive/folder IDs |
| `npm run deploy -- --plan` | Local deployment plan preview |
| `npm run deploy` | Deploy models, foundation, and workers |
| `npm run exchange -- --once` | Run one Exchange cycle |
| `npm run teams -- --once` | Run one Teams cycle |
| `npm run onedrive -- --once` | Run one OneDrive cycle |
| `npm run typecheck` | TypeScript check |
| `npm run build` | Build project |

## Run locally

```sh
cd synthetic-tests
npm ci
npm run exchange -- --once
npm run teams -- --once
npm run onedrive -- --once
```

Use `--tenant <alias>` when the config includes multiple tenants.

## Configuration

- Use root `../monitoring.config.json` only.
- Generated IDs are stored in adjacent `.env`.
- Service selection, scenarios, execution, and deployment all come from the root config.
- `logAnalytics.enabled` controls reporting path.
- `serviceHealth.enabled` controls provider context collection.

## Service guides

- Exchange: `exchange/README.md`
- Teams: `teams/README.md`
- OneDrive: `onedrive/README.md`
- Shared runtime and deployment internals: `utils/README.md`
- Hosting resources: `infra/README.md`

## Additional docs

- Setup: `../docs/setup.md`
- Deployment details: `../docs/deployment.md`
- Operations: `../docs/operations.md`
