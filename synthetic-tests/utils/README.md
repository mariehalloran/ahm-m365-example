# Shared utilities and stateless service execution

**One config, one cadence, no saved state.** The worker runs the configured Exchange, Teams, or SharePoint operation, exports its result and measurements, and waits for the next scheduled slot.

It does not calculate success percentages, evaluate Healthy/Unhealthy, call the health-report API, or create a checkpoint file/blob. Log Analytics queries perform the analysis.

The intended deployment is one Azure Container App per service. Its test code and OTel SDK/exporters run in the **same process/container**. There is no separate telemetry worker, collector, or Kubernetes requirement.

## Run

Run from the `synthetic-tests/` project directory:

```sh
npm run exchange -- --once
npm run exchange
# Separate process, separate cadence:
npm run sharepoint
npm run teams -- --once
```

Each entry defaults to its own `<service>/config.json` from that project directory; optional `--config <file>` overrides it, but another service's config is rejected before runtime initialization. `--once` limits execution to one cycle; inspect individual result outcomes rather than interpreting process completion as proof that a service works. There is no generic all-service CLI or process launcher.

Production utilities do not import service implementations. Each service's `src/worker.ts` supplies its selected journey handler to [worker.ts](./src/worker.ts). [runner.ts](./src/runner.ts) only executes that handler (or deterministic simulation), validates the version 2.0 result, and exports observations.

Shared code also includes [auth](./src/auth.ts), [config validation](./src/service-config.ts), [Graph](./src/graph.ts), [HTTP](./src/http.ts), [Bot Connector](./src/teams.ts), [step measurement](./src/steps.ts), and [embedded OTel](./src/results.ts). Service-specific API actions remain under that service's `src/steps.ts`.

First execution is immediate. The fixed-rate schedule never overlaps its own previous cycle; missed slots are skipped and logged. Configs are read only at startup. SIGINT/SIGTERM stop scheduling, cancel active work, permit bounded probe cleanup, and flush/shut down telemetry.

Separate service processes do not block each other. Keep one authoritative instance per target set; statelessness is not a distributed lock, and replicas can otherwise duplicate emails.

## Config

| Field | Meaning |
| --- | --- |
| `type` | `exchange`, `sharepoint`, or `teams` |
| `enabled` | Whether this worker runs |
| `intervalSeconds` | Start-to-start cadence, 1-86,400 seconds |
| `timeoutSeconds` | Probe execution timeout, up to 120 seconds; cleanup has a separate bounded budget |
| `mode` | `simulation` or `live` |
| `graphAuthentication` | `managed-identity` by default; `certificate` is explicit local-live opt-in |
| `serviceHealth` | Optional boolean, default `false`; stable Microsoft service health context only |
| `serviceActivity` | Optional strict beta diagnostic settings, default disabled; see below |
| `scenario` | Optional deterministic simulation scenario |
| `cohort` | Low-cardinality grouping label for downstream queries; not a worker health policy |
| `telemetry` | `console` by default; `azure-monitor` exports OTel metrics and result logs |
| `targets` | Dedicated test resources, each with a unique opaque `id` |

The parser rejects unknown fields, duplicates, invalid types/limits, and wrong-service target fields. Live mode requires complete service-specific resources. Invalid/disabled configs do not execute probes or initialize an Azure exporter.

The old `reportToHealthModel` field is no longer supported. Remove it and use `telemetry`; no health-report setting replaces it.

Example live target:

```json
{ "id": "exchange-probe-001", "mailbox": "dedicated-synthetic@example.invalid" }
```

```json
{ "id": "sharepoint-probe-001", "siteId": "approved-site", "driveId": "approved-drive", "folderId": "approved-folder" }
```

```json
{
  "id": "teams-probe-001",
  "tenantId": "11111111-1111-4111-8111-111111111111",
  "teamId": "22222222-2222-4222-8222-222222222222",
  "channelId": "approved-standard-channel-id",
  "serviceUrl": "https://smba.trafficmanager.net/teams/"
}
```

The Teams `serviceUrl` must come from approved bot-installation metadata; the example is not proof of a valid conversation route. Only the supported public-cloud Connector origin/path is accepted. Bot installation and its validated metadata are administrator setup inputs, not created by a periodic test.

One target now produces useful measurements; there is no worker-side three-sample minimum or stabilization counter.

## Optional provider collectors

The service entry supplies both its journey and its [service-owned provider wrapper](../exchange/src/providers.ts); shared worker/runtime code does not import service implementations. Exchange, Teams and SharePoint collect independently at their existing per-type cadence, once per cycle regardless of target count. Read-only provider sources run concurrently with the synthetic journey, without blocking journey startup. Both settle before the cycle summary, and diagnostics that finish after the journey's flush are flushed before that summary. No persisted watermark, last-seen cache, health report, or extra OTel process is introduced.

All fields are optional and default to:

```json
{
  "serviceHealth": false,
  "serviceActivity": {
    "enabled": false,
    "aggregationIntervalMinutes": 15,
    "lookbackMinutes": 30
  }
}
```

`serviceHealth` must be boolean. `serviceActivity` is a strict object: `enabled` is boolean; aggregation is **5, 10, 15, or 30 minutes**; lookback is an integer multiple of aggregation, at least one aggregation interval and at most **1,440 minutes**. An omitted nested field uses the shown default. An optional `functions` array must contain exactly one verified identifier for that service:

| Service | Default/only beta function | Value and additional application permission |
| --- | --- | --- |
| Exchange | `getConnectivityMetricsForExchange` | Provider percentage 0–100; `ServiceActivity-Exchange.Read.All` |
| Teams | `getMessageVolumeMetricsForTeamsChat` | Nonnegative safe-integer count; `ServiceActivity-Teams.Read.All` |
| SharePoint | None | `enabled: true` or any nonempty `functions` is rejected |

Unknown functions, URLs, fields, duplicates, wrong-service functions, unsafe Int64 values and invalid windows are rejected; no unverified optional reports are exposed. `functions` can be omitted to select the one verified default. Enabling beta requires **`ENABLE_BETA_SERVICE_ACTIVITY=true` before runtime/credentials/mutations**, including simulation; live execution independently requires `ENABLE_LIVE_M365=true`. A disabled service does not create a runtime. Microsoft marks beta APIs unsupported for production; confirm tenant eligibility/enablement and licensing with the administrator.

**Business Basic versus enterprise:** API-backed synthetics and stable Service Health can use Basic when the required subscribed service/Teams SKU and approved administrator access exist. The beta API pages specify application permissions but do **not** explicitly establish Basic entitlement; do not promise beta availability. Microsoft's separate [advanced Microsoft 365 monitoring eligibility](https://learn.microsoft.com/microsoft-365/enterprise/microsoft-365-monitoring) is at least 5,000 qualifying Office 365/Microsoft 365 E3/E5 licenses plus 50 monthly active users for a core service. Do not automatically apply that UI feature's threshold as a verified beta API entitlement rule; confirm actual report enablement/availability for the tenant.

The beta window ends at the current UTC aggregation bucket floor and starts `lookbackMinutes` earlier, so it never requests a future or unbounded range. For example, at 18:32 UTC:

```text
GET https://graph.microsoft.com/beta/reports/serviceActivity/getConnectivityMetricsForExchange(inclusiveIntervalStartDateTime=2026-10-16T18:00:00Z,exclusiveIntervalEndDateTime=2026-10-16T18:30:00Z,aggregationIntervalInMinutes=15)
```

Stable collection uses exported reusable `getServiceHealthOverviews` and `getServiceHealthIssues` from [service-health.ts](./src/service-health.ts), and needs separately approved **`ServiceHealth.Read.All`**. It filters exact subscribed names: `Exchange Online`, `Microsoft Teams`, `SharePoint Online`; no guessed aliases or empty-service healthy default. Discovery/administrator verification of the tenant's actual subscribed names remains a prerequisite. An unmatched/empty overview is an explicit `no-data` failure; an empty valid issue list is zero issue records, not a healthy status.

Each source has an independent **30-second budget**, uses existing bounded Graph HTTP retries, and follows at most **five pages**, each bounded to **2 MB**, on the exact same Graph HTTPS origin/version/collection or report-function path. Stable pages request at most 100 items; beta pages allow up to the requested window's bucket count (maximum 288), rejecting duplicate/out-of-window/unaligned intervals. Escaped, cyclic or over-budget continuation fails the source instead of publishing a partial snapshot. Graph redirects do not forward bearer tokens. Journey requests remain v1.0; report requests explicitly select beta. Source failures do not prevent other configured sources or successful journeys from reporting. `service-cycle-summary.providers` records `configured`, `succeeded`, `failed`, `skipped`, and emitted `records`; it never claims failed/skipped sources succeeded.

`ResultTelemetry.recordDiagnostic` is an allowlisted, validated **Logger-only** facade in the existing SDK. It cannot add provider observations to any synthetic/step histogram. Azure exporters map these ordinary MessageData logs to `AppTraces.Message` with **flat** `Properties`:

| Exact Message | Attributes |
| --- | --- |
| `m365-service-health-overview` | `provider.service`, `provider.mode=live`, `provider.api_version=v1.0`, `provider.collected_at`, `provider.source=serviceAnnouncement.healthOverviews`, `provider.service_id`, `provider.service_name`, raw `provider.status` |
| `m365-service-health-issue` | Same service/mode/version/collection time; `provider.source=serviceAnnouncement.issues`, `provider.issue_id`, `provider.service_name`, `provider.status`, bounded JSON `provider.issue`, boolean `provider.truncated` |
| `m365-service-activity` | Service/mode/collection time; `provider.api_version=beta`, `provider.source` and `provider.function`, `provider.interval_start`, `provider.interval_end` (sample bucket), `provider.aggregation_interval_minutes`, **either** `provider.percentage` **or** `provider.value` |
| `m365-provider-collection-failed` | Service/mode/version/source/collection time, `provider.observed_at`, sanitized `provider.category`, optional numeric `provider.http_status`; no error body/headers/token |
| `m365-provider-collection-skipped` | Service, `provider.mode=simulation`, version/source/collection time, `provider.skip_reason=simulation`; no Microsoft-reported status |

Log timestamp is collection time, not historical report time. Approved issue JSON preserves id, service, classification, status, title, impact description, feature/group, start/end/modified times, resolution flag and posts (created time/type/content type/content). It retains at most 10 posts and bounds strings/serialized JSON to 6,000 characters; both `provider.truncated` and JSON `truncated` explicitly flag reductions, with `postsTotal` preserving original post count. Unknown fields are discarded; raw HTTP failures and mailbox content are never logged. This provider metadata can still be tenant-sensitive: restrict workspace access/retention accordingly.

The SDK's bounded in-memory log queue accommodates the capped provider pages plus maximum journey target count; `--once` flushes diagnostic logs with results, then shuts down. Overlapping historical beta samples are snapshots, not newly occurring events—never sum them as new requests or derive synthetic success rates. Stable context remains impact-suppressed; only fresh exact live/v1.0 overview logs can supply the separate context query. Issues and beta never populate Experience/journey health signals. Provider diagnostics are not proof of live tenant access.

First-party references: [stable health overviews](https://learn.microsoft.com/graph/api/serviceannouncement-list-healthoverviews?view=graph-rest-1.0), [stable issues](https://learn.microsoft.com/graph/api/serviceannouncement-list-issues?view=graph-rest-1.0), [Exchange connectivity beta](https://learn.microsoft.com/graph/api/serviceactivity-getconnectivitymetricsforexchange?view=graph-rest-beta), [Teams chat volume beta](https://learn.microsoft.com/graph/api/serviceactivity-getmessagevolumemetricsforteamschat?view=graph-rest-beta), [serviceActivity catalog](https://learn.microsoft.com/graph/api/resources/serviceactivity?view=graph-rest-beta).

## Credentials and export

Hosted live Graph uses only `ManagedIdentityCredential({ clientId })`, selected with a valid UUID `AZURE_CLIENT_ID`, for `https://graph.microsoft.com/.default`. It never falls back to DefaultAzureCredential, Azure CLI, client secrets, a certificate, Key Vault, or a guessed/system host identity. The identity and approved target must be in the same Microsoft 365 tenant. Assign Exchange roles through mailbox-scoped Exchange RBAC for Applications, not tenant-wide Entra Graph mail grants.

Explicit `graphAuthentication: "certificate"` local live Graph operations require:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_CERTIFICATE_PATH`
- `ENABLE_LIVE_M365=true`, after the mailbox/site access checks

Do not store passwords, connection strings, or private keys in config files. Keep PEM files ignored and readable only by their owner. See the [administrator handoff](../../MAILBOX-SYNTHETIC-ACCESS.md).

Teams also requires `BOT_TENANT_ID`, `BOT_CLIENT_ID`, and `BOT_CLIENT_CERTIFICATE_PATH`. The bot's Connector token uses `https://api.botframework.com/.default`; Graph observation uses `https://graph.microsoft.com/.default`. Bot, observer, and target tenants must match. The two tokens are not interchangeable.

`telemetry: azure-monitor` additionally requires `APPLICATIONINSIGHTS_CONNECTION_STRING` for a workspace-based Application Insights resource. No Azure subscription Owner/Contributor, health-model ingestion role, or Blob permission is required just to export through the configured ingestion connection. Tenant policy may require additional ingestion authentication; confirm it before hosting.

The Graph identity and telemetry destination are independent. Cross-tenant hosted Graph authentication is not implemented. Teams MI observation additionally requires `AZURE_TENANT_ID` for the expected bot/Graph/target tenant guard; Bot Connector stays certificate-backed and independently authorized. Simulation and disabled configs initialize no credentials. Azure Container Apps remains the intended host, not an already deployed worker.

Advanced execution settings such as `POLL_INTERVAL_MS` remain environment variables. Worker health thresholds, report TTL, minimum samples, consecutive-failure settings, `AHM_MODEL_ID`, and `STATE_STORAGE_URL` are not part of this worker.

## Results, not health decisions

Each result has an outcome and measured durations, never a Healthy/Unhealthy state. OTel records **1 for success or 0 otherwise**, plus duration observations. Logs contain opaque correlation/test IDs for drill-down; metrics do not. Each service has its own query files, not a combined service calculation.

- A successful operation with successful cleanup is a successful probe.
- Authentication, authorization, or collector problems are identified as unexecutable rather than asserted to be Exchange delivery failures.
- A delivery timeout is a failed test with no confirmed delivery-duration sample.
- Exchange request timing is emitted when the send request was attempted, even if it failed. Send duration, confirmed delivery duration, and total duration are distinct.
- Teams records bot send-request time and confirmed channel-publication time. This is not a recipient read receipt or UI test.
- SharePoint records upload and verified-readback time, including failed attempted phases, as well as total time.
- A confirmed delivery followed by cleanup failure retains delivery timing but has a failed overall outcome.
- Simulation durations are modeled and always labeled as simulation.

OTel export buffers are transient SDK memory, not persistent worker state. Offline disk storage is disabled; a process crash or network outage can lose telemetry. There is no exactly-once delivery guarantee or durable outbox.

## Measurements and queries

| Metric | Observation |
| --- | --- |
| `synthetic.probe.success` | One numeric histogram sample per attempt: success `1`, failure/unexecutable `0` |
| `synthetic.probe.duration` | Total attempt duration through cleanup, seconds |
| `synthetic.step.success` | One numeric histogram sample per executed step: succeeded `1`, failed `0` |
| `synthetic.step.duration` | One elapsed-seconds sample per executed step, including failed execution |
| `mailflow.send.duration` | Attempted Exchange send request, seconds |
| `mailflow.delivery.duration` | Confirmed Inbox observation measured from send initiation, seconds |
| `teams.message.send.duration` | Attempted Connector post request, seconds |
| `teams.message.publication.duration` | Confirmed expected-author Graph observation from send initiation, seconds |
| `sharepoint.file.upload.duration` | Attempted upload and response validation, seconds |
| `sharepoint.file.read.duration` | Attempted content download and exact verification, seconds |

Overall and phase metric labels are only `probe.service`, `probe.journey`, `probe.mode`, `probe.outcome`. Step labels add only `probe.step`. Journey/step values are a closed service-specific vocabulary, never target-controlled names. No mailbox, cohort, test ID, correlation ID, site/channel ID, or private payload is a metric dimension.

`SyntheticResult` retains schema version `2.0`, existing phase timings, and a `steps` array (default `[]` for older diagnostics). Each executed step has bounded name, `succeeded`/`failed`, `observedAt`, and `durationMs`; failed steps add a bounded diagnostic category. Skipped steps instead have a nonsecret reason, no duration, and no step metric. Authentication failure does not fabricate failed send/read operations. Cleanup failure fails the overall attempt while leaving earlier successes and measurements unchanged.

`measureStep` executes a supplied async action, times it with the supplied clock, records a normalized observation, and rethrows the original failure. Journeys stop prerequisites, then attempt only owned-artifact cleanup with a separate ten-second cancellation budget. Per-attempt mutable IDs remain ephemeral. There is no plugin registry, durable job, outbox, health calculation, or state file.

Real `MeterProvider` and `LoggerProvider` instances live inside each worker. Histograms export delta sum/count, not gauges that replace prior attempts. Every attempt emits `synthetic-result`; every step emits `synthetic-step` diagnostics, including skipped status. Logs permit opaque test/correlation IDs and retain milliseconds; messages, target IDs, tokens, raw responses and credentials are never exported. Simulation is labeled modeled, not measured real latency, and stale timestamps propagate to its step records.

Each service owns separate queries:

| Service | Analytics | Model signals |
| --- | --- | --- |
| Exchange | [analytics](../exchange/queries/analytics/) | [health-model](../exchange/queries/health-model/) |
| Teams | [analytics](../teams/queries/analytics/) | [health-model](../teams/queries/health-model/) |
| SharePoint | [analytics](../sharepoint/queries/analytics/) | [health-model](../sharepoint/queries/health-model/) |

Success percentage is `100 * sum(Sum) / sum(ItemCount)` for `synthetic.probe.success`; step success uses the corresponding step instrument. Unequal export batches must be weighted: never average batch averages. All-zero attempts give 0%, while no samples give no percentage, not invented 100%. A reporting-gap check uses positive sample count, not success sum; zero-count exporter rows cannot keep a stopped service fresh.

Durations use `sum(Sum) / sum(ItemCount)` and are means, **not p95**. Individual result logs can support percentiles; histogram summary rows alone cannot reconstruct them. Request acceptance is not confirmed delivery/publication; unconfirmed operations have no confirmed-duration sample. Read/upload failure can retain attempted phase duration.

Queries select one literal service/journey/step and live mode; deployed model queries also scope the exact Application Insights resource. Analytics queries keep `_ResourceId` separate for multiple applications. Default reporting-gap windows follow independent cadence: Exchange three minutes, Teams five, SharePoint eleven. No target inventory or raw-log joins are needed, and one reporting target cannot identify another missing target.

`telemetry: azure-monitor` requires an explicitly validated connection string for workspace-based Application Insights linked to Log Analytics. Result/step logs arrive in `AppTraces`, measurements in `AppMetrics`. The exporter disables disk storage, statsbeat self-monitoring, and hidden background providers, and exposes sanitized bounded export/flush/shutdown failures. Success samples do not guarantee ingestion or alert delivery; independent monitoring, approved retention/volume/cost, and live acceptance remain required.

## Build

```sh
npm run build
node dist/exchange/src/worker.js --once
node dist/teams/src/worker.js --once
node dist/sharepoint/src/worker.js --once
```

Run these commands from `synthetic-tests/`. Production builds include application code only, excluding tests. Workers execute handlers in-process; Container Apps packaging/deployment remain separate work. The package in that directory owns all three entries and these shared utilities.
