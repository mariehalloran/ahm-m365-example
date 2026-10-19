# Config-driven service worker

**One config file, one worker, one cadence.** A worker runs only Exchange or SharePoint, using that service's targets and interval. Start another worker with another config to give it an independent schedule.

The same program is intended for each Azure Container Apps worker. Container packaging, deployment, managed-identity selection for ACA, and distributed replica ownership are not implemented. The deployed [health model](../health-model/README.md) does not depend on deploying a worker.

## Commands

From the repository root:

```sh
# One cycle; suitable for configuration checks and local integration tests.
npm run probe -- --config probes/exchange/config.json --once

# Continuous Exchange worker.
npm run probe -- --config probes/exchange/config.json

# Independent SharePoint worker, normally another terminal or container.
npm run probe -- --config probes/sharepoint/config.json

# Disabled configuration: exits without running or claiming health.
npm run probe -- --config probes/teams/config.json --once
```

An explicit config path is required. Files are read at startup; restart after changing them. There is no hot reload or global schedule.

## Config fields

| Field | Meaning |
| --- | --- |
| `type` | `exchange`, `sharepoint`, or disabled `teams` |
| `enabled` | Whether this worker may run |
| `intervalSeconds` | Nominal start-to-start cadence, 1-86,400 seconds |
| `timeoutSeconds` | Per-probe execution timeout, up to 120 seconds; cleanup has a separate bounded budget |
| `mode` | `simulation` or `live`; simulation produces modeled outcomes, not measured service latency |
| `scenario` | Optional simulation case: `healthy`, `slow`, `failed`, `timeout`, or `stale` |
| `cohort` | Configured cohort's entity ID in the health model |
| `reportToHealthModel` | Explicit reporting opt-in; defaults to false |
| `targets` | Dedicated test resources, each with a unique `id` |

Config fields and targets are validated strictly. Unknown fields, duplicate IDs, invalid cadence/timeouts, and wrong-service target fields fail explicitly. Enabled configurations need targets. Teams is not implemented and cannot be enabled, including in simulation mode.

Target examples:

```json
{ "id": "exchange-probe-001", "mailbox": "dedicated-synthetic@example.invalid" }
```

```json
{ "id": "sharepoint-probe-001", "siteId": "approved-site", "driveId": "approved-drive", "folderId": "approved-folder" }
```

The config supplies the service type and cohort, so they are not repeated on every target. Targets can include `region` and an optional simulation `scenario`. The examples use three targets to preserve the default three-fresh-sample policy; repeated simulation targets are not independent user populations.

## Scheduling behavior

- First execution starts immediately.
- Each worker has its own fixed-rate schedule; another service runs in a separate process.
- A worker never starts a new cycle while its previous cycle is still running.
- Overruns skip and log missed slots, rather than building a backlog or sending a burst of catch-up tests.
- SIGINT/Ctrl+C and SIGTERM stop scheduling, cancel active work, and allow the existing bounded probe cleanup.
- Invalid or disabled configs do not acquire credentials, run probes, write history, or send health reports.

Only run one authoritative instance per config and reporting target. Storage ETags detect conflicting writers but do not prevent duplicate test sends. Multiple ACA replicas need explicit ownership/leases before they are safe.

## Results, state, and reporting

Every completed probe emits its structured result. Each service cycle also emits a summary identifying the type, mode, reporting status, cohort state, and probe count. Simulation is labeled and its durations are modeled. Do not confuse simulated results with actual Microsoft 365 availability.

Worker history is isolated by service, execution mode, configuration, and reporting destination. Changing the authoritative configuration can reset its stabilization history. Do not point independently configured workers at the same cohort unless their evidence policy explicitly supports it.

With `reportToHealthModel: false`, the worker makes no Azure reporting calls or provider-health queries. `mode: live` can still mutate approved Microsoft 365 resources: reporting and live execution are separate approvals.

For real Azure report submission, set `reportToHealthModel: true` and supply `AHM_MODEL_ID` through the environment. The default `AHM_API_VERSION` is `2026-05-01-preview`. Ensure the configured cohort entity exists and the submitting identity has model-scoped ingestion access. Simulation reporting requires a separate approved simulation model.

Reporting also requires `REPORT_TTL_SECONDS >= intervalSeconds + timeoutSeconds + 90`. This margin allows for cleanup, ingestion, and whole-minute TTL rounding; an invalid reporting/freshness combination is rejected before execution. The default 900-second TTL accommodates the checked-in examples.

The worker submits **only its cohort reports**. It does not query provider health or update the shared `runner-heartbeat`, `graph-availability`, or `provider-context` reports. Those entities remain Unknown until their own producers are implemented. A successful Exchange worker is not proof that every worker or the whole monitoring pipeline is healthy.

If a configured cohort has insufficient fresh evidence, it remains Unknown. The default minimum is three fresh samples and complete configured-target coverage. Healthy/Degraded/Unhealthy thresholds and consecutive failure/recovery policy remain in the [health policy](../health-model/src/policy.ts).

## Credentials and advanced settings

Credentials never belong in the JSON file. Local live Graph access requires:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_CERTIFICATE_PATH`
- `ENABLE_LIVE_M365=true`, after the resource and authorization checks

The PEM file contains the certificate/private key; keep it ignored and readable only by its owner. See the [administrator handoff](../MAILBOX-SYNTHETIC-ACCESS.md). Hosted Graph identity selection and hosted cross-tenant support are not implemented.

Azure report submission uses its own default Azure credential selection, which can select these same application environment variables. Do not assume Azure CLI identity and Graph identity are automatically separated.

Advanced policy and storage settings remain environment variables. The service config is authoritative for service, mode, cadence, scenario, and targets.

| Setting | Default / purpose |
| --- | --- |
| `REPORT_TTL_SECONDS` | `900`; must exceed the intended cadence with room for completion and ingestion |
| `POLL_INTERVAL_MS` | `2000` |
| `MIN_FRESH_SAMPLES` / `MIN_FRESH_COVERAGE` | `3` / `1` |
| `HEALTHY_SUCCESS_RATE` / `DEGRADED_SUCCESS_RATE` | `0.99` / `0.95` |
| `HEALTHY_LATENCY_MS` / `UNHEALTHY_LATENCY_MS` | `15000` / `60000` |
| `CONSECUTIVE_FAILURES` / `CONSECUTIVE_RECOVERIES` | `2` / `2` |
| `STATE_STORAGE_URL` | Optional managed-identity Azure Blob endpoint; each worker uses an isolated blob |

Do not change the freshness policy just to make missing data appear Healthy. Expired external signals can be removed by Azure Monitor Health Models, so stopped-worker behavior must be tested against the final model's other signals and propagation.

## Build and start

Development uses `npm run probe`. The production entrypoint runs the same worker from compiled JavaScript:

```sh
npm run build
npm start -- --config probes/exchange/config.json --once
# Or continue on the configured cadence:
npm start -- --config probes/exchange/config.json
```

Production builds include application code only, not tests or test helpers.

`--once` limits execution to one cycle; inspect the emitted results and cohort state to assess the test outcome. No alternate demo, mailbox, or combined-cycle program is required.

## Future telemetry

Each worker currently executes its service handlers in-process. A separate child-process protocol and OTel SDK/exporter are not implemented. Keep structured per-email/per-probe events and low-cardinality outcome counters/duration histograms as distinct outputs; IDs belong in events/traces, not metric dimensions. See [telemetry semantics](../docs/operations.md#future-process-and-otel-boundary-not-implemented).
