# Microsoft 365 synthetic monitoring

**Run a test, report its result, repeat.** Each service has its own config and cadence. Workers are stateless: no Blob storage, checkpoint files, success-rate calculations, or health-state reports.

Start with the service-owned journey guides: [Exchange send/receive](./exchange/README.md), [Teams channel publication](./teams/README.md), and [SharePoint save/reopen](./sharepoint/README.md). Each documents its exact endpoints, reusable actions, config, tests, and queries. These are API-backed journeys, not browser/desktop or employee sign-in tests. HTTP-level tests assume approved access; no real tenant execution or employee receipt is established.

```text
Exchange Container App   [test + OTel SDK, every 60 seconds]  --+
Teams Container App      [test + OTel SDK, every 120 seconds] --+
SharePoint Container App [test + OTel SDK, every 300 seconds] --+
                                                             |
                                         workspace-based Application Insights
                                                             |
                                                  Log Analytics / KQL
                                               success percentage and latency
                                                             |
                                              health-model query signals
```

The [sample health model and telemetry resources](./health-model/README.md) are managed independently in `rg-m365-demo`. Each service experience has **one AzureLogAnalytics entity displayed as User Journey**, with overall and named-step KQL signals inside it—not separate child step entities. Query signals evaluate **live-only** data; no live worker is connected yet. Azure Container Apps is the intended worker host, not an already deployed worker.

OpenTelemetry runs **inside each service's existing process**, not in another worker/container. Each service has its own Container App and config; no AKS cluster, sidecar, or OTel Collector is required for this export path.

## Run locally

Requires Node.js 22 or 24 and npm. Run from the repository root:

```sh
npm ci
npm run exchange -- --once
# Remove --once to repeat on Exchange's cadence.
npm run exchange
# Another terminal/process runs SharePoint independently.
npm run sharepoint
# Or run one safe Teams simulation.
npm run teams -- --once
```

Checked-in configs use **simulation** and **console output**: no real email/files, Azure ingestion, or local state writes. Stop with Ctrl+C.

## Configure each service

| Config | Cadence | Default |
| --- | --- | --- |
| [Exchange](./exchange/config.json) | 60 seconds | Simulated mail-flow result |
| [SharePoint](./sharepoint/config.json) | 300 seconds | Simulated file result |
| [Teams](./teams/config.json) | 120 seconds | Simulated channel publication; bot-backed live handler requires approved access |

```json
{
  "type": "exchange",
  "enabled": true,
  "intervalSeconds": 60,
  "timeoutSeconds": 45,
  "mode": "simulation",
  "graphAuthentication": "managed-identity",
  "cohort": "exchange-global",
  "telemetry": "console",
  "targets": [{ "id": "exchange-probe-001" }]
}
```

Restart a worker after editing its file. Separate services do not share a scheduler. A worker never overlaps its own cycles; missed slots are skipped, not queued into catch-up bursts. Run one instance per target set until distributed ownership is implemented.

Each command defaults to its own `<service>/config.json`; use `--config <file>` to override it. A service entry rejects another service's config before credentials or operations are initialized.

## Send telemetry to Log Analytics

Use a **workspace-based Application Insights resource linked to the intended Log Analytics workspace**, then:

1. Set the service config's `telemetry` to `azure-monitor`.
2. Supply its `APPLICATIONINSIGHTS_CONNECTION_STRING` as an environment variable/secret, not in JSON or source control.
3. Run a single cycle and check `AppMetrics` and `AppTraces` in the linked workspace after ingestion.

The worker exports:

- One success measurement per attempt: **1 = success, 0 = unsuccessful**.
- A total probe-duration histogram in seconds.
- An Exchange send-request-duration histogram in seconds.
- An Exchange confirmed-delivery-duration histogram in seconds.
- Teams Connector send/publication and SharePoint upload/read duration histograms in seconds.
- `synthetic.step.success` (1/0) and `synthetic.step.duration` (seconds) for every executed action, including failed actions and cleanup.
- Structured per-attempt and per-step diagnostics. Blocked actions are `skipped`, with no fabricated duration or success sample.

[Telemetry semantics](./utils/README.md#measurements-and-queries) describe **average success × 100**, average durations, and reporting gaps. Each service owns its `queries/analytics/` and `queries/health-model/` files. Overall metric dimensions are service, journey, mode, and outcome; step metrics add only the bounded step ID. Mailbox/probe inventories are not required.

For real tests, obtain the [approved mailbox and scoped permissions](./MAILBOX-SYNTHETIC-ACCESS.md), add dedicated targets, change `mode` to `live`, and explicitly set `ENABLE_LIVE_M365=true`. Live execution and Azure export are independent choices. Simulated measurements are labeled and excluded from the default live queries.

Start with the disabled live templates in [Exchange](./exchange/config.live.example.json), [Teams](./teams/config.live.example.json), or [SharePoint](./sharepoint/config.live.example.json). Replace placeholder resources and enable only after approval. Hosted Graph defaults to the explicit user-assigned managed identity in `AZURE_CLIENT_ID`; certificate authentication is opt-in local development only. Teams Bot Connector still needs separate bot certificate credentials and a matching expected tenant; Graph MI does not automatically authorize bot sending.

## Components

| Folder | Responsibility |
| --- | --- |
| [health-model/](./health-model/) | Independently deployed topology and query signals |
| [exchange/](./exchange/) | Exchange worker, config, journey/actions, tests, queries and optional mock hosting template |
| [teams/](./teams/) | Teams worker, config, journey/actions, tests and queries |
| [sharepoint/](./sharepoint/) | SharePoint worker, config, journey/actions, tests and queries |
| [utils/](./utils/README.md) | Shared auth/config, clients, measured steps, execution/scheduling and embedded OTel |

## Validate

```sh
npm run typecheck
npm test
npm run build
node dist/exchange/src/worker.js --once
node dist/teams/src/worker.js --once
node dist/sharepoint/src/worker.js --once
```

One root npm package builds all three entries; tests are excluded from production output. See [shared worker configuration](./utils/README.md), [operations](./docs/operations.md), and [deployment boundaries](./docs/deployment.md). No worker publishes Healthy/Unhealthy or calls the Health Report Ingestion API.
