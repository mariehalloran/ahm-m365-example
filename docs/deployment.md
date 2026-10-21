# Root configuration, health models, then Container Apps

## Deployment status and order

The new [model templates](../health-model/README.md) define a root Azure Monitor Health Models resource referencing independent service models. Each service contains a User Journey and individual action entities receiving aggregated external health reports. Optional OTEL query signals live on those same entities.

**This federated topology has not been deployed.** Earlier single-model PoC resources in `rg-m365-demo` do not prove the new topology or report path is active. No live workers, registry/image pipeline, or tenant permission grants are established by application validation.

1. Prepare a private copy of [monitoring.config.json](../monitoring.config.json): select services/scenarios, account/target metadata, health-model destination, and OTEL.
2. Establish the root and enabled service models before enabling live workers. Deploy workspace/Application Insights/query permissions only if OTEL is enabled.
3. Authorize each worker identity separately for its scoped Microsoft 365 journey and health-report ingestion on its own service model.
4. Package and host one worker per enabled service in Azure Container Apps.
5. Prove direct reports with OTEL disabled, then optional OTEL queries, cross-model propagation, independent monitoring and notifications.

Follow the [model deployment/migration guide](../health-model/README.md). Preview with the approved subscription/resource group and the same private root config passed as `projectConfig=@<absolute-path>`. Deployment scope must match `healthModel.subscriptionId` and `resourceGroup`; the template cannot relocate resources based on worker destination metadata. Incremental deployment does **not** remove previously enabled service models, query signals, authentication settings or telemetry resources.

## Safe local validation

The Node package, dependencies and build output remain entirely inside [synthetic-tests/](../synthetic-tests/README.md). From the repository root:

```sh
npm --prefix synthetic-tests ci
npm --prefix synthetic-tests run exchange -- --once
npm --prefix synthetic-tests run teams -- --once
npm --prefix synthetic-tests run sharepoint -- --once
```

All services and supported journeys default to enabled. Checked-in service files still select **simulation**; root OTEL defaults to enabled with **console** destination. Reports are clearly labeled previews, with no Graph/ARM credentials, real messages/files, Azure ingestion, or saved state. Setting root `otel.enabled: false` additionally avoids constructing any SDK/exporter.

## Root and service configuration

Root `services.<service>.configFile` paths are relative to the root config's directory. Keep cadences, timeouts, mode, authentication and provider opt-ins in these separate service files. Root service/scenario switches, targets and OTEL settings have a single source of truth; duplicate `enabled`, `targets` and `telemetry` service-file keys are rejected. Root service/scenario selection controls whether a worker runs.

Use a mounted private root config for hosted workers:

```sh
# From synthetic-tests/, after building:
node dist/exchange/src/worker.js \
  --project-config /etc/probe/monitoring.config.json \
  --config /etc/probe/exchange.json --once
```

`--config` overrides only the service file, not root targets/gates/OTEL. It is relative to the working directory unless absolute. Without it, the root config's `configFile` is used. Adjust paths in a private config for the image layout; never assume a `synthetic-tests/`-only image includes a repository-root file.

Root targets must contain the approved mailbox address or site/team/channel IDs. Live settings examples select live mode but are not approved resources or permission grants; execution still requires the explicit environment gate. Replace the zero subscription placeholder, configure the exact model prefix/resource group, and ensure report TTL exceeds cadence plus the bounded 212-second cycle/report budget.

## Identity and permissions

Hosted Graph and health reports use only the explicitly selected same-tenant UAMI's `AZURE_CLIENT_ID`. Graph uses its Graph token; reports use a separate `https://management.azure.com/.default` token. There is no CLI/default-identity/certificate fallback. Explicit local `graphAuthentication: certificate` uses the approved development service principal for both audiences; its Graph and Azure grants must both be assigned.

The model must already contain each destination entity; ingestion does not create entities. The worker needs the report-ingestion action on its **service model**, not subscription Owner/Contributor or root-model administration. See the [model permission contract](../health-model/README.md). The model identity's optional query/reference permissions are separate from worker permissions.

Approve the [Exchange mailbox grants](../MAILBOX-SYNTHETIC-ACCESS.md), SharePoint `Sites.Selected` site-write grant, or Teams Graph observer/bot setup independently. Teams remains separately certificate-backed for Bot Connector and requires expected `AZURE_TENANT_ID`; Graph managed identity alone does not authorize bot posting.

Live execution also requires `mode: live`, all selection gates, approved targets and `ENABLE_LIVE_M365=true`. Provider collection remains separately disabled by default; stable context needs `ServiceHealth.Read.All`, and experimental beta diagnostics require their service-specific permissions plus `ENABLE_BETA_SERVICE_ACTIVITY=true`. Providers never contribute to synthetic reports or rollup.

## Optional OTEL

To add historical metrics/logs:

1. Set root `otel.enabled: true` and `otel.destination: azure-monitor`.
2. Deploy the optional workspace, linked Application Insights, query authentication/RBAC and per-entity signals.
3. Supply `APPLICATIONINSIGHTS_CONNECTION_STRING` securely, not in JSON/source control.
4. Verify live `AppMetrics`/`AppTraces` ingestion and service-specific query results, including all-failure, skipped-step and no-data cases.

OTEL is embedded in the same worker process; no separate telemetry service, Collector, sidecar or AKS is required. Disabled OTEL needs no connection string/workspace. Root OTEL enabled with console destination is for local inspection; it does not populate Azure query signals. OTEL query windows and direct-report cycle aggregates can differ, and both active signal groups contribute to entity health.

## Container Apps boundary

Build from the self-contained Node project:

```sh
npm --prefix synthetic-tests run build
```

Use `synthetic-tests/` as the image's application/build context. Include its compiled service entries and runtime dependencies, then mount the project-root config separately and the selected service config at explicit paths. The same image can run an explicitly selected Exchange, Teams or SharePoint entry; separate apps retain independent 60/120/300-second default cadences.

The [Exchange hosting mock](../synthetic-tests/exchange/infra/README.md) is compile-only, not an operational deployment. No equivalent Teams/SharePoint hosting template or published image is claimed. Use one authoritative replica per target set; rollouts/restarts can repeat attempts. Always-running loops require CPU outside HTTP requests and an instance that does not scale to zero; validate billing/scaling settings.

Workers have no persistent volume/history/outbox. Report retries, SDK buffers and aggregation are bounded memory only. Protect certificates where explicitly required, rotate them, and verify graceful shutdown and cleanup.

## Acceptance and cleanup

- With OTEL disabled: confirm entity-level direct reports, numeric aggregates, skipped Unknowns, and propagation through service/root models.
- With OTEL enabled: additionally verify exact resource/service/journey/step scoping, weighted success/means, live-only filtering and no-data behavior.
- Deny report ingestion and optional telemetry separately; failures must be explicit and one path must still be attempted when the other fails.
- Stop/stall workers, observe report expiry, and verify independent detection rather than assuming expiry forces Unknown while other signals remain.
- Test notifications end to end through a route not dependent only on Microsoft 365.

The [enterprise reliability gate](./operations.md#enterprise-reliability-acceptance-gate), independently observed freshness, model/reference authorization and a tested alert path remain requirements, not deployed functionality.

Reports, model evaluations, optional ingestion/retention and always-running compute incur costs. Agree on budgets, report cadence, TTL and retention. Azure Monitor Health Models is preview; confirm applicable terms.

Stop producers first when decommissioning. Reconcile stale report/query signals and model references, revoke only approved permissions, review retained synthetic artifacts, and remove dedicated resources only after owner approval. Never delete a shared resource group or unrelated workspace.
