# Model, telemetry, then Container Apps

## Current deployment

The sample model `m365-experience-poc` is managed independently in `rg-m365-demo`, Central US, with workspace `law-m365-experience-poc`, linked Application Insights `appi-m365-experience-poc`, and workspace-scoped query access for the model identity. Each experience has **one AzureLogAnalytics entity displayed as User Journey**, containing its overall and operation-step query signals. There are no separate child step entities. See the [model template and current deployment validation](../health-model/README.md). Application validation does not deploy or connect a live worker.

No worker, registry, mailbox, or Microsoft 365 permission grant is deployed. The model evaluates live-only queries; workers do not push health states.

## Local test

```sh
npm run exchange -- --once
npm run teams -- --once
npm run sharepoint -- --once
```

The checked-in configs use simulation and console telemetry. They perform no real mail/file operations, Azure exports, or checkpoint writes.

## Connect telemetry

1. Use the approved deployed workspace and linked Application Insights resource.
2. Set a service config's `telemetry` to `azure-monitor`.
3. Provide `APPLICATIONINSIGHTS_CONNECTION_STRING` securely.
4. Run once and verify both `AppMetrics` and individual `AppTraces` records in the linked workspace.
5. Validate service-owned [Exchange](../exchange/queries/), [Teams](../teams/queries/), [SharePoint](../sharepoint/queries/) analytics/model queries, including all-failure, all-unexecutable, missing-step and no-data cases. No target list is needed. [Measurement semantics](../utils/README.md#measurements-and-queries) explain weighting and skipped steps.

No Blob storage or health-model ingestion role is needed. The exporter sends from the **same process that runs the tests**. It is shared code, not a separate service.

Changing the telemetry destination does not enable real probes; `mode: live` additionally requires dedicated approved resources, credentials, and explicit live opt-in.

## Container Apps deployment boundary

Use one independently configured Container App per service:

```text
Exchange Container App:   one process = test + embedded OTel, every 60 seconds
SharePoint Container App: one process = test + embedded OTel, every 300 seconds
Teams Container App:      one process = bot journey + embedded OTel, every 120 seconds
```

One root npm package builds three service-owned entries; utilities never import all service implementations. The same image can run an explicitly selected entry, with embedded OTel and no sidecar/Collector/AKS requirement:

```sh
npm run build
node dist/exchange/src/worker.js --config exchange/config.json
node dist/teams/src/worker.js --config teams/config.json
node dist/sharepoint/src/worker.js --config sharepoint/config.json
```

`--config` is optional, defaulting to the selected service file. Wrong-service configs are rejected before runtime initialization. Hosted Graph requires the approved same-tenant UAMI's explicit `AZURE_CLIENT_ID`, with `graphAuthentication: "managed-identity"` (default). There is no Graph certificate/Key Vault/CLI fallback. Local certificate development requires explicit `certificate` mode. Teams still needs its independent bot certificate and expected `AZURE_TENANT_ID` tenant guard. See the [optional Exchange mock template](../exchange/infra/README.md); it is not a deployed worker.

For an always-running background loop, hosting must keep an instance running and provide CPU while idle/non-HTTP work executes; do not assume scale-to-zero/request-driven defaults keep a timer loop alive. Validate the chosen Container Apps billing/scaling configuration before deployment.

Packaging, production hosting, scoped permission assignments, and replica ownership remain separate work. Keep one authoritative replica per target set; process restarts/revisions can cause repeated attempts. Test graceful shutdown, credential rotation, export failure, and downstream missing-data monitoring. No checkpoint volume or Graph certificate secret is required for the hosted Graph path.

All three live templates are disabled until resources are supplied. Teams additionally needs a preinstalled bot and validated Connector service URL; the current outbound worker does not host the bot-registration callback/bootstrap service. HTTP-mocked journey tests are not live access or end-to-end tenant validation.

## Model queries

The model identity has Log Analytics Reader only on the new workspace. Each service has separate `AppMetrics` queries for binary success, mean duration, reporting gaps, unexecutable attempts and individual step success/duration. No query combines services; no per-probe inventory, log join or worker state is required. Overall metrics include literal `probe.journey`; step metrics use `probe.service`, `probe.journey`, `probe.step`, `probe.mode`, `probe.outcome`.

Each service's `queries/health-model/` contains `success-percentage.kql`, `mean-latency.kql`, `missing-observations.kql`, `unexecutable-attempts.kql`, `step-success.kql`, and `step-duration.kql`. The model puts human-readable signals such as “Create email - mean duration” and step success inside that service's single User Journey entity; the runtime step vocabulary and metrics are unchanged.

Journey/step queries with no measurements return no value, not fabricated 100% success or zero latency. A separate monitoring signal indicates absent service metrics. All three journey/step signal sets are wired in the model; actual live ingestion, Azure resource/provider collection and alert delivery are not proven. Notifications still require an approved action group/recipient.

## Optional provider collection rollout

Service-owned wrappers run inside each existing worker, once per cycle independently of mailbox/channel/site targets. All checked-in configs and disabled live templates leave `serviceHealth` and `serviceActivity.enabled` **false**; enabling telemetry does not enable either collector or grant access.

For an approved read-only context rollout, separately authorize `ServiceHealth.Read.All`, confirm exact subscribed service names, then opt into `serviceHealth`. Overviews and issue/history logs are **context-only**, and ServiceHealth entities remain impact-suppressed. The model's separate context query accepts only fresh live v1.0 `m365-service-health-overview` records; issues never supply health signals.

For a separate experimental Exchange/Teams beta evaluation, confirm tenant eligibility, approve the service-specific `ServiceActivity-Exchange.Read.All` or `ServiceActivity-Teams.Read.All`, and set both the config's `serviceActivity.enabled` and `ENABLE_BETA_SERVICE_ACTIVITY=true`. SharePoint beta is explicitly unsupported/rejected. Beta is unsupported for production and diagnostics only, never aggregated into synthetic measurements or Experience/journey health. No permission deployment/grant is implemented by the collectors.

Inspect explicit provider failures, source summary counts, expected flat AppTraces attributes, bounded/truncated issue history, and overlapping historical report buckets during a controlled `--once` run only after access approval. The [shared schema and limits](../utils/README.md#optional-provider-collectors) are validated before runtime creation. Simulation skips sources with no Graph credentials/network. Local mocked validation is not live Microsoft 365 access or evidence that a tenant can use a beta report.

## Acceptance and cleanup

- Exactly identified attempts and correct seconds/milliseconds are visible in the workspace.
- Binary success observations and weighted mean durations match known fixtures.
- Weighted means and service reporting-gap detection behave correctly; empty results never imply 100% success.
- Simulation is separated from live measurements.
- Each service follows its own cadence and cleans up on cancellation.
- Export failures are explicit; no filesystem/Blob outbox or hidden state exists.

For a large-company default, also satisfy the [enterprise reliability gate](./operations.md#enterprise-reliability-acceptance-gate): independent missing-result detection, platform/query/alert-path monitoring, an approved notification route not dependent only on Microsoft 365, and measured failure-injection tests. A single cheap replica is a proof of concept, not a production availability commitment.

Workspace ingestion/retention and always-running compute incur costs; agree on budgets and retention. Azure Monitor Health Models is a preview service, so confirm applicable terms.

Stop producers first when decommissioning. Revoke only approved permissions, review retained artifacts, and delete only dedicated resources with owner approval. Never delete a shared resource group or unrelated workspace.
