# Journey and business-step health models

Health models are generated from the single root config (`monitoring.config.json`) and deployed by `npm run deploy` from `synthetic-tests/`.

## Model shape

- Root model references one nested model per selected service: Exchange, Teams, OneDrive.
- Each service model contains:
  - Service experience root
  - Selected journey entities
  - Journey business-step child entities
- Exchange adds two parent nodes:
  - `exchange-mail`
  - `exchange-calendar`

## Stable journey entity IDs

| Service | Scenario -> entity |
| --- | --- |
| Exchange | `send-receive-mail` -> `exchange-global` |
| Exchange | `edit-reopen-draft` -> `exchange-draft` |
| Exchange | `attachment-mail` -> `exchange-attachment` |
| Exchange | `reply-mail` -> `exchange-reply` |
| Exchange | `recurring-calendar` -> `exchange-recurring` |
| Teams | `channel-conversation` -> `teams-global` |
| Teams | `scheduled-meeting` -> `teams-call` |
| OneDrive | `user-drive-roundtrip` -> `onedrive-planned-user-drive-roundtrip` |
| OneDrive | `app-folder-lifecycle` -> `onedrive-planned-app-folder-lifecycle` |
| OneDrive | `document-versions` -> `onedrive-planned-document-versions` |

## Signal delivery modes

`logAnalytics.enabled` in root config selects one mode for all services:

- `false`: containers publish direct aggregate health reports per cycle.
- `true`: containers publish observations; model queries evaluate rolling windows from Log Analytics.

## Group signals

- Exchange and OneDrive groups are defined under each service `targets` object.
- Groups are attached as `signalAggregationGroups` on journey entities.
- Teams stays ungrouped.

## Service Health context

When root `serviceHealth.enabled` is true:

- Each service model includes one suppressed `<service>-service-health` entity.
- Stable service health/status/count context is collected on provider lanes.
- Optional Message Center and approved activity signals are published on the same entity.

## Deploy and validate

From `synthetic-tests/`:

```sh
npm run deploy -- --plan
npm run deploy
```

Local validation:

```sh
npm --prefix synthetic-tests run catalog:check
az bicep build --file health-model/infra/main.bicep --stdout > /dev/null
az bicep build --file health-model/infra/service.bicep --stdout > /dev/null
az bicep build --file synthetic-tests/infra/main.bicep --stdout > /dev/null
```

## Related docs

- `docs/architecture.md`
- `docs/deployment.md`
- `docs/monitoring-groups.md`
- `docs/provider-monitoring.md`
