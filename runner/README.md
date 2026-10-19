# Stateless service worker

**One config, one cadence, no saved state.** The worker runs the configured operation, exports its raw result and measurements, and waits for the next scheduled slot.

It does not calculate success percentages, evaluate Healthy/Unhealthy, call the health-report API, or create a checkpoint file/blob. Log Analytics queries perform the analysis.

The intended deployment is one Azure Container App per service. Its test code and OTel SDK/exporters run in the **same process/container**. There is no separate telemetry worker, collector, or Kubernetes requirement.

## Run

From the repository root:

```sh
npm run probe -- --config probes/exchange/config.json --once
npm run probe -- --config probes/exchange/config.json
# Separate process, separate cadence:
npm run probe -- --config probes/sharepoint/config.json
```

`--config` is required. `--once` limits execution to one cycle; inspect individual result outcomes rather than interpreting process completion as proof that a service works.

First execution is immediate. The fixed-rate schedule never overlaps its own previous cycle; missed slots are skipped and logged. Configs are read only at startup. SIGINT/SIGTERM stop scheduling, cancel active work, permit bounded probe cleanup, and flush/shut down telemetry.

Separate service processes do not block each other. Keep one authoritative instance per target set; statelessness is not a distributed lock, and replicas can otherwise duplicate emails.

## Config

| Field | Meaning |
| --- | --- |
| `type` | `exchange`, `sharepoint`, or disabled `teams` |
| `enabled` | Whether this worker runs |
| `intervalSeconds` | Start-to-start cadence, 1-86,400 seconds |
| `timeoutSeconds` | Probe execution timeout, up to 120 seconds; cleanup has a separate bounded budget |
| `mode` | `simulation` or `live` |
| `scenario` | Optional deterministic simulation scenario |
| `cohort` | Low-cardinality grouping label for downstream queries; not a worker health policy |
| `telemetry` | `console` by default; `azure-monitor` exports OTel metrics and result logs |
| `targets` | Dedicated test resources, each with a unique opaque `id` |

The parser rejects unknown fields, duplicates, invalid types/limits, and wrong-service target fields. Teams cannot be enabled until a handler is implemented. Invalid/disabled configs do not execute probes or initialize an Azure exporter.

The old `reportToHealthModel` field is no longer supported. Remove it and use `telemetry`; no health-report setting replaces it.

Example live target:

```json
{ "id": "exchange-probe-001", "mailbox": "dedicated-synthetic@example.invalid" }
```

```json
{ "id": "sharepoint-probe-001", "siteId": "approved-site", "driveId": "approved-drive", "folderId": "approved-folder" }
```

One target now produces useful measurements; there is no worker-side three-sample minimum or stabilization counter.

## Credentials and export

Local live Graph operations require:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_CERTIFICATE_PATH`
- `ENABLE_LIVE_M365=true`, after the mailbox/site access checks

Do not store passwords, connection strings, or private keys in config files. Keep PEM files ignored and readable only by their owner. See the [administrator handoff](../MAILBOX-SYNTHETIC-ACCESS.md).

`telemetry: azure-monitor` additionally requires `APPLICATIONINSIGHTS_CONNECTION_STRING` for a workspace-based Application Insights resource. No Azure subscription Owner/Contributor, health-model ingestion role, or Blob permission is required just to export through the configured ingestion connection. Tenant policy may require additional ingestion authentication; confirm it before hosting.

The probe's mailbox identity and telemetry destination are independent. Cross-tenant hosting and approved hosted Graph credential loading still need deployment work. Azure Container Apps remains the intended host, not an already deployed worker.

Advanced execution settings such as `POLL_INTERVAL_MS` remain environment variables. Worker health thresholds, report TTL, minimum samples, consecutive-failure settings, `AHM_MODEL_ID`, and `STATE_STORAGE_URL` are not part of this worker.

## Results, not health decisions

Each result has an outcome and measured durations, never a Healthy/Unhealthy state. Logs contain opaque correlation/test IDs for drill-down; metrics do not.

- A successful operation with successful cleanup is a successful probe.
- Authentication, authorization, or collector problems are identified as unexecutable rather than asserted to be Exchange delivery failures.
- A delivery timeout is a failed test with no confirmed delivery-duration sample.
- A confirmed delivery followed by cleanup failure retains delivery timing but has a failed overall outcome.
- Simulation durations are modeled and always labeled as simulation.

See [telemetry semantics and KQL](../telemetry/README.md). OTel export buffers are transient SDK memory, not persistent worker state. Offline disk storage is disabled; a process crash or network outage can lose telemetry. There is no exactly-once delivery guarantee or durable outbox.

## Build

```sh
npm run build
npm start -- --config probes/exchange/config.json --once
```

Production builds include application code only. Workers currently execute handlers in-process; child-probe execution and Container Apps packaging/deployment remain separate work.
