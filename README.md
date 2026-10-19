# Microsoft 365 synthetic monitoring

**Run a test, report its result, repeat.** Each service has its own config and cadence. Workers are stateless: no Blob storage, checkpoint files, success-rate calculations, or health-state reports.

Start with the [user journeys and endpoint guide](./probes/README.md): email arrival, Teams message observation, and document save/readback. It explains each employee goal, the exact API calls, what is implemented, and what an API-backed test cannot prove about the user interface.

Detailed plans: [Teams post/readback/cleanup](./probes/teams/README.md) and [SharePoint upload/read/verify/delete](./probes/sharepoint/README.md). The Teams plan is not an implemented handler or proof of employee receipt.

```text
Exchange Container App   [test + OTel SDK, every 60 seconds]  --+
SharePoint Container App [test + OTel SDK, every 300 seconds] --+
                                                             |
                                         workspace-based Application Insights
                                                             |
                                                  Log Analytics / KQL
                                               success percentage and latency
                                                             |
                                              health-model query signals
```

The [sample health model and telemetry resources](./health-model/README.md) are deployed in `rg-m365-demo`. Query signals evaluate **live-only** data; no live worker is connected yet. Azure Container Apps is the intended worker host, not an already deployed worker.

OpenTelemetry runs **inside each service's existing process**, not in another worker/container. Each service has its own Container App and config; no AKS cluster, sidecar, or OTel Collector is required for this export path.

## Run locally

Requires Node.js 22 or 24 and npm. Run from the repository root:

```sh
npm ci
npm run probe -- --config probes/exchange/config.json --once
# Remove --once to repeat on Exchange's cadence.
npm run probe -- --config probes/exchange/config.json
# Another terminal/process runs SharePoint independently.
npm run probe -- --config probes/sharepoint/config.json
```

Checked-in configs use **simulation** and **console output**: no real email/files, Azure ingestion, or local state writes. Stop with Ctrl+C.

## Configure each service

| Config | Cadence | Default |
| --- | --- | --- |
| [Exchange](./probes/exchange/config.json) | 60 seconds | Simulated mail-flow result |
| [SharePoint](./probes/sharepoint/config.json) | 300 seconds | Simulated file result |
| [Teams](./probes/teams/config.json) | 120 seconds | Disabled; handler not implemented |

```json
{
  "type": "exchange",
  "enabled": true,
  "intervalSeconds": 60,
  "timeoutSeconds": 45,
  "mode": "simulation",
  "cohort": "exchange-global",
  "telemetry": "console",
  "targets": [{ "id": "exchange-probe-001" }]
}
```

Restart a worker after editing its file. Separate services do not share a scheduler. A worker never overlaps its own cycles; missed slots are skipped, not queued into catch-up bursts. Run one instance per target set until distributed ownership is implemented.

## Send telemetry to Log Analytics

Use a **workspace-based Application Insights resource linked to the intended Log Analytics workspace**, then:

1. Set the service config's `telemetry` to `azure-monitor`.
2. Supply its `APPLICATIONINSIGHTS_CONNECTION_STRING` as an environment variable/secret, not in JSON or source control.
3. Run a single cycle and check `AppMetrics` and `AppTraces` in the linked workspace after ingestion.

The worker exports:

- An outcome counter for success, failure, or inability to execute.
- A total probe-duration histogram in seconds.
- An Exchange confirmed-delivery-duration histogram in seconds.
- One structured result per attempt for diagnostics and percentile calculations.

[Simple KQL examples](./telemetry/README.md) sum attempts/successes, calculate average durations, and check when a service last reported. Metric dimensions are only service, mode, and outcome. No mailbox/probe inventory is required; opaque IDs stay in diagnostic records.

For real tests, obtain the [approved mailbox and scoped permissions](./MAILBOX-SYNTHETIC-ACCESS.md), add dedicated targets, change `mode` to `live`, and explicitly set `ENABLE_LIVE_M365=true`. Live execution and Azure export are independent choices. Simulated measurements are labeled and excluded from the default live queries.

## Components

| Folder | Responsibility |
| --- | --- |
| [health-model/](./health-model/) | Deployed model topology; future query-based signal integration |
| [probes/](./probes/README.md) | User journeys, endpoints, service configs, and test operations |
| [runner/](./runner/) | Stateless execution and independent per-config scheduling |
| [telemetry/](./telemetry/) | OTel export and downstream KQL |
| [shared/](./shared/) | Result contracts and HTTP/Graph clients |

## Validate

```sh
npm run typecheck
npm test
npm run build
npm start -- --config probes/exchange/config.json --once
```

See [worker configuration](./runner/README.md), [operations](./docs/operations.md), and [deployment boundaries](./docs/deployment.md). No worker publishes Healthy/Unhealthy or calls the Health Report Ingestion API.
