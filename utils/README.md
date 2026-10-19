# Shared utilities and stateless service execution

**One config, one cadence, no saved state.** The worker runs the configured Exchange, Teams, or SharePoint operation, exports its result and measurements, and waits for the next scheduled slot.

It does not calculate success percentages, evaluate Healthy/Unhealthy, call the health-report API, or create a checkpoint file/blob. Log Analytics queries perform the analysis.

The intended deployment is one Azure Container App per service. Its test code and OTel SDK/exporters run in the **same process/container**. There is no separate telemetry worker, collector, or Kubernetes requirement.

## Run

From the repository root:

```sh
npm run exchange -- --once
npm run exchange
# Separate process, separate cadence:
npm run sharepoint
npm run teams -- --once
```

Each entry defaults to its own `<service>/config.json`; optional `--config <file>` overrides it, but another service's config is rejected before runtime initialization. `--once` limits execution to one cycle; inspect individual result outcomes rather than interpreting process completion as proof that a service works. There is no generic all-service CLI or process launcher.

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

## Credentials and export

Hosted live Graph uses only `ManagedIdentityCredential({ clientId })`, selected with a valid UUID `AZURE_CLIENT_ID`, for `https://graph.microsoft.com/.default`. It never falls back to DefaultAzureCredential, Azure CLI, client secrets, a certificate, Key Vault, or a guessed/system host identity. The identity and approved target must be in the same Microsoft 365 tenant. Assign Exchange roles through mailbox-scoped Exchange RBAC for Applications, not tenant-wide Entra Graph mail grants.

Explicit `graphAuthentication: "certificate"` local live Graph operations require:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_CERTIFICATE_PATH`
- `ENABLE_LIVE_M365=true`, after the mailbox/site access checks

Do not store passwords, connection strings, or private keys in config files. Keep PEM files ignored and readable only by their owner. See the [administrator handoff](../MAILBOX-SYNTHETIC-ACCESS.md).

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

Production builds include application code only, excluding tests. Workers execute handlers in-process; Container Apps packaging/deployment remain separate work. One root npm package owns all three entries and these shared utilities.
