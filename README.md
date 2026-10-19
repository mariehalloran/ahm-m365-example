# Microsoft 365 synthetic health model

Run each kind of synthetic test from its own config file, on its own cadence. One small worker reads one config and runs only that service's tests.

The **health model is deployed**; see [deployment and verification](./health-model/README.md). **Azure Container Apps is the intended worker host, but container hosting is not deployed.** You can exercise the config-driven workers locally without Azure access.

## Start here

Requires Node.js 22 or 24 and npm. Run commands from the repository root.

```sh
npm ci

# Run one safe simulated Exchange cycle.
npm run probe -- --config probes/exchange/config.json --once

# Keep Exchange running on its configured cadence.
npm run probe -- --config probes/exchange/config.json

# In another terminal, run SharePoint independently.
npm run probe -- --config probes/sharepoint/config.json
```

The checked-in configs generate **simulated outcomes**, not real email or files, and do not send reports to Azure. Stop a worker with Ctrl+C.

## One config per service

| Config | Enabled | Cadence | Current behavior |
| --- | --- | --- | --- |
| [Exchange](./probes/exchange/config.json) | Yes | Every 60 seconds | Simulated mail-flow outcomes; live handler available after approval |
| [SharePoint](./probes/sharepoint/config.json) | Yes | Every 300 seconds | Simulated file outcomes; live handler available after approval |
| [Teams](./probes/teams/config.json) | No | Every 120 seconds when implemented | Config placeholder; no Teams handler |

For example, [Exchange's config](./probes/exchange/config.json) controls:

```json
{
  "type": "exchange",
  "enabled": true,
  "intervalSeconds": 60,
  "timeoutSeconds": 45,
  "mode": "simulation",
  "cohort": "exchange-global",
  "reportToHealthModel": false,
  "targets": [
    { "id": "exchange-probe-001" },
    { "id": "exchange-probe-002" },
    { "id": "exchange-probe-003" }
  ]
}
```

Change the interval or targets in that service's file, then restart its worker. There is no shared master cadence. A slow Exchange run does not block a separate SharePoint process.

Workers never overlap their own cycles: missed schedule slots are skipped and logged, not queued into catch-up bursts. Timeouts allow an additional bounded cleanup period. Use one authoritative worker per config; distributed replica ownership is not implemented.

Teams remains disabled until a real handler is implemented. Enabling its config fails explicitly; it cannot silently produce simulated Teams success.

## Connecting real services and the health model

1. Obtain approval using the [mailbox administrator request](./MAILBOX-SYNTHETIC-ACCESS.md) or the corresponding workload's permission gates.
2. Add approved target resources to the service config, then change `mode` to `live`. Exchange targets need `mailbox`; SharePoint targets need `siteId`, `driveId`, and `folderId`.
3. Supply credentials through the environment or an approved secret store, not JSON config. Live mutations also require `ENABLE_LIVE_M365=true`.
4. Validate one cycle with `--once` before scheduling.
5. Separately opt into reporting with `reportToHealthModel: true` and an approved `AHM_MODEL_ID`.

Simulation and reporting are independent settings: enabling reporting really writes to Azure even in simulation mode. Use separate simulation/live models and state.

Each worker reports only its configured cohort. It does not query Microsoft 365 Service Health or claim that the shared monitoring pipeline is healthy. State is isolated between service configurations. Provider collection and global pipeline health remain separate work.

See the [worker guide](./runner/README.md) for settings, credentials, scheduling, reporting, and legacy commands. One mailbox validates an integration, not tenant-wide availability.

## Repository layout

| Component | Responsibility |
| --- | --- |
| [health-model/](./health-model/) | Model infrastructure, report ingestion, and cohort health policy |
| [probes/exchange/](./probes/exchange/) | Exchange config, mail-flow handler, and tests |
| [probes/sharepoint/](./probes/sharepoint/) | SharePoint config, file handler, and tests |
| [probes/teams/](./probes/teams/README.md) | Disabled config and future Teams boundary |
| [runner/](./runner/) | The same generic config-driven worker used for each service |
| [shared/](./shared/) | Result contracts and shared HTTP/Graph clients |

One root npm package covers all components. There is one worker entrypoint; each service has its own config and cadence.

## Validation and further reading

```sh
npm run typecheck
npm test
npm run build
```

Structured results retain per-test outcomes, durations, and diagnostics without message bodies or secrets. OpenTelemetry outcome counters and response-time histograms remain a planned export; no OTel exporter is implemented.

- [Worker configuration and scheduling](./runner/README.md)
- [Health-model deployment](./health-model/README.md)
- [Mailbox access and cross-tenant requirements](./MAILBOX-SYNTHETIC-ACCESS.md)
- [Operations, cleanup, and telemetry definitions](./docs/operations.md)
- [Deployment boundaries](./docs/deployment.md)
