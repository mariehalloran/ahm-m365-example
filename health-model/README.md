# Journey and business-step health models

Health models are generated from root [monitoring.config.json](../monitoring.config.json)
and its referenced service files, then deployed by `npm run deploy` from
[synthetic-tests/](../synthetic-tests/). Each
[service README](../synthetic-tests/README.md#services) includes its model image
and maps the journey/business-step entities to actual API calls.

## Model shape

- Root model references one nested model per selected service: Exchange, Teams, OneDrive, SharePoint Online.
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
| SharePoint Online | `document-library-roundtrip` -> `sharepoint-document-roundtrip` |
| SharePoint Online | `document-versions` -> `sharepoint-document-versions` |
| SharePoint Online | `list-item-lifecycle` -> `sharepoint-list-item` |

[catalog.ts](../synthetic-tests/utils/src/catalog.ts) is canonical; `npm run catalog:generate`
projects it to [catalog.json](../synthetic-tests/utils/src/catalog.json) for Bicep. SharePoint adds three journeys and
13 business-step children only when selected. The checked-in selection includes
its model, root reference and execution Function in the deployment plan. Disabling the service
omits them.

## Signal delivery modes

`logAnalytics.enabled` in root config selects one mode for all services:

- `false`: execution Functions publish direct aggregate health reports.
- `true`: execution Functions send observations directly through the Logs
  Ingestion API/DCR; model queries evaluate rolling windows from Log Analytics.

Execution cancellations and cleanup-only failures have no numeric sample in either
mode. Success and latency use conclusive observations; an all-Unknown cohort
evaluates Unknown. A genuine service failure is not hidden by a later cleanup error.
`minimumSamples` counts conclusive evidence only. Queries deduplicate before
excluding inconclusive records, including legacy zero-valued cancellation/cleanup
rows; the `inconclusive-by-group` saved search retains their diagnostics.

## Latency thresholds

Root `healthModel.latencyDegradedMilliseconds` and
`healthModel.latencyUnhealthyMilliseconds` are the defaults. Use
`healthModel.journeyLatencyOverrides` to change one service/journey without
relaxing other journeys:

```json
"journeyLatencyOverrides": {
  "teams": {
    "channel-conversation": {
      "latencyDegradedMilliseconds": 30000,
      "latencyUnhealthyMilliseconds": 60000
    }
  }
}
```

An override applies to that journey's duration signals and business steps in
both reporting modes, including any reporting-group signals. Success-rate
thresholds, failed requests, execution deadlines and cadence are unchanged.
Unlisted journeys retain the global 15/60-second defaults in this configuration.

## Group signals

- Exchange and OneDrive groups are defined under each service `targets` object.
- Groups are attached as `signalAggregationGroups` on journey entities.
- Teams and SharePoint stay ungrouped; site/library/list targets do not create user groups or per-target entities.

## Service Health context

When root `serviceHealth.enabled` is true:

- Each service model includes one suppressed `<service>-service-health` entity.
- Stable service health/status/count context is collected on provider lanes.
- Optional Message Center and approved activity signals are published on the same entity.
- SharePoint uses the stable `SharePoint` / `SharePoint Online` overview and exact issue/message service membership, separately from OneDrive.

## Root health alerts

`healthModel.alertActionGroupIds` references existing Azure Monitor action groups.
Root Degraded/Unhealthy transitions use Sev 2/Sev 1 alerts; receivers remain
operator-managed. These state-change alerts do not replace independent execution,
report-freshness or notification checks. See [operations](../docs/operations.md).

## Deploy and validate

From [synthetic-tests/](../synthetic-tests/):

```sh
npm run deploy -- --plan
npm run deploy
```

Local validation from the repository root:

```sh
npm --prefix synthetic-tests run catalog:check
az bicep build --file health-model/infra/main.bicep --stdout > /dev/null
az bicep build --file health-model/infra/service.bicep --stdout > /dev/null
az bicep build --file synthetic-tests/infra/main.bicep --stdout > /dev/null
```

## Related docs

- [Architecture](../docs/architecture.md)
- [Deployment](../docs/deployment.md)
- [Reporting groups](../docs/monitoring-groups.md)
- [Provider monitoring](../docs/provider-monitoring.md)
