# Model, telemetry, then Container Apps

## Current deployment

The sample model `m365-experience-poc` is deployed in `rg-m365-demo`, Central US, with workspace `law-m365-experience-poc`, linked Application Insights `appi-m365-experience-poc`, and workspace-scoped query access for the model's identity. The model preserves thirteen entities and eleven relationships. See the [model template and validation](../health-model/README.md).

No worker, registry, mailbox, or Microsoft 365 permission grant is deployed. The model evaluates live-only queries; workers do not push health states.

## Local test

```sh
npm run probe -- --config probes/exchange/config.json --once
npm run probe -- --config probes/sharepoint/config.json --once
```

The checked-in configs use simulation and console telemetry. They perform no real mail/file operations, Azure exports, or checkpoint writes.

## Connect telemetry

1. Use the approved deployed workspace and linked Application Insights resource.
2. Set a service config's `telemetry` to `azure-monitor`.
3. Provide `APPLICATIONINSIGHTS_CONNECTION_STRING` securely.
4. Run once and verify both `AppMetrics` and individual `AppTraces` records in the linked workspace.
5. Validate [success-rate, mean-duration, and service last-seen queries](../telemetry/README.md), including all-failure, all-unexecutable, and no-data cases. No mailbox/probe list is needed.

No Blob storage or health-model ingestion role is needed. The exporter sends from the **same process that runs the tests**. It is shared code, not a separate service.

Changing the telemetry destination does not enable real probes; `mode: live` additionally requires dedicated approved resources, credentials, and explicit live opt-in.

## Container Apps deployment boundary

Use one independently configured Container App per service:

```text
Exchange Container App:   one process = test + embedded OTel, every 60 seconds
SharePoint Container App: one process = test + embedded OTel, every 300 seconds
Teams Container App:      do not deploy until its probe exists
```

The same image can run each config. No separate OTel worker, sidecar, Collector, or AKS cluster is required. Build with `npm run build`; startup is `npm start -- --config <service-config.json>`.

For an always-running background loop, hosting must keep an instance running and provide CPU while idle/non-HTTP work executes; do not assume scale-to-zero/request-driven defaults keep a timer loop alive. Validate the chosen Container Apps billing/scaling configuration before deployment.

Packaging, protected Graph credential loading, replica ownership, and ACA infrastructure remain separate work. Keep one authoritative replica per target set; process restarts/revisions can cause repeated attempts. Test graceful shutdown, credential rotation, export failure, and downstream missing-data monitoring. No checkpoint volume is needed.

## Model queries

The model's managed identity has Log Analytics Reader only on the new workspace. Simple `AppMetrics` queries aggregate attempts/successes and weighted mean durations by service, plus a service reporting-gap check. No per-probe inventory, log join, or worker state is required.

Journey queries with no measurements return no value, not fabricated 100% success or zero latency. The separate monitoring signal indicates absent service metrics. Teams, Azure resource context, and provider collection remain unconnected. Notifications still require an approved action group/recipient.

## Acceptance and cleanup

- Exactly identified attempts and correct seconds/milliseconds are visible in the workspace.
- Outcome counters and weighted mean durations match known fixtures.
- Weighted means and service reporting-gap detection behave correctly; empty results never imply 100% success.
- Simulation is separated from live measurements.
- Each service follows its own cadence and cleans up on cancellation.
- Export failures are explicit; no filesystem/Blob outbox or hidden state exists.

For a large-company default, also satisfy the [enterprise reliability gate](./operations.md#enterprise-reliability-acceptance-gate): independent missing-result detection, platform/query/alert-path monitoring, an approved notification route not dependent only on Microsoft 365, and measured failure-injection tests. A single cheap replica is a proof of concept, not a production availability commitment.

Workspace ingestion/retention and always-running compute incur costs; agree on budgets and retention. Azure Monitor Health Models is a preview service, so confirm applicable terms.

Stop producers first when decommissioning. Revoke only approved permissions, review retained artifacts, and delete only dedicated resources with owner approval. Never delete a shared resource group or unrelated workspace.
