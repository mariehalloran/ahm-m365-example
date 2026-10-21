# Root configuration, health models, then Container Apps

## Deployment status and order

The [model templates](../health-model/README.md) define a root Azure Monitor Health Models resource referencing independent service models. Each service has two independently selected journey entities and business-step child entities. Each journey/step receives aggregated direct reports in **External Reports**, its only signal group. All services/scenarios give four models, 34 entities, 30 relationships, six journeys and 18 business-step entities. Token acquisition and cleanup have neither entities nor published step data.

The isolated `m365-experience-demo` model family has been redeployed report-only: four models, 34 entities, 30 relationships, six journeys and 18 business-step entities. All three apps have ready/running `--0000005` revisions on the verified immutable digest in the [shared worker guide](../synthetic-tests/infra/README.md#verified-report-only-deployment). Fresh SharePoint provider status is Unknown with explicit Graph 403 diagnostics. All-service end-to-end verification is still in progress; this deployment does not establish successful Microsoft 365 journeys, tenant grants, or notification delivery. The earlier single-model PoC remains separate with its model retained and queries removed.

1. Prepare a private copy of [monitoring.config.json](../monitoring.config.json): select services/scenarios, account/target metadata, health-model destination, and report policy.
2. Establish the root and enabled service models before enabling live workers.
3. Authorize each worker identity separately for its scoped Microsoft 365 journey and health-report ingestion on its own service model.
4. Package and host one worker per enabled service in Azure Container Apps.
5. Prove direct journey/step/provider reports, cross-model propagation, independent monitoring and notifications.

Follow the [model deployment/migration guide](../health-model/README.md). Preview with the approved subscription/resource group and the same private root config passed as `projectConfig=@<absolute-path>`. Deployment scope must match `healthModel.subscriptionId` and `resourceGroup`; the template cannot relocate resources based on worker destination metadata. Incremental deployment does **not** remove previously enabled service models, query signals, authentication settings or telemetry resources.

## Safe local validation

The Node package, dependencies and build output remain entirely inside [synthetic-tests/](../synthetic-tests/README.md). From the repository root:

```sh
npm --prefix synthetic-tests ci
npm --prefix synthetic-tests run exchange -- --once
npm --prefix synthetic-tests run teams -- --once
npm --prefix synthetic-tests run sharepoint -- --once
```

All services and supported journeys default to enabled. Checked-in service files select **simulation**. Console results and reports are clearly labeled previews, with no Graph/ARM credentials, real messages/files, Azure ingestion, or saved state. Simulation must not publish cloud health.

## Root and service configuration

Root `services.<service>.configFile` paths are relative to the root config's directory. Keep cadences, timeouts, mode, authentication and provider opt-ins in these separate service files. Root service/scenario switches, targets and report policy have a single source of truth; duplicate `enabled`, `targets` and obsolete `telemetry` service-file keys are rejected. Root service/scenario selection controls whether a worker runs.

Use a mounted private root config for hosted workers:

```sh
# From synthetic-tests/, after building:
node dist/exchange/src/worker.js \
  --project-config /etc/probe/monitoring.config.json \
  --config /etc/probe/exchange.json --once
```

`--config` overrides only the service file, not root targets/gates/report policy. It is relative to the working directory unless absolute. Without it, the root config's `configFile` is used. Adjust paths in a private config for the image layout; never assume a `synthetic-tests/`-only image includes a repository-root file.

Root targets must contain the approved mailbox address or site/team/channel IDs. Live settings examples select live mode but are not approved resources or permission grants; execution still requires the explicit environment gate. Replace the zero subscription placeholder, configure the exact model prefix/resource group, and ensure report TTL exceeds cadence plus the bounded 212-second cycle/report budget.

## Identity and permissions

Hosted Graph and health reports use only the explicitly selected same-tenant UAMI's `AZURE_CLIENT_ID`. Graph uses its Graph token; reports use a separate `https://management.azure.com/.default` token. There is no CLI/default-identity/certificate fallback. Explicit local `graphAuthentication: certificate` uses the approved development service principal for both audiences; its Graph and Azure grants must both be assigned.

The model must already contain each destination entity; ingestion does not create entities. The worker needs the report-ingestion action on its **service model**, not subscription Owner/Contributor or root-model administration. See the [model permission contract](../health-model/README.md). The root model identity's native-reference permissions are separate from worker permissions.

Approve the [Exchange mailbox grants](../MAILBOX-SYNTHETIC-ACCESS.md), SharePoint `Sites.Selected` site-write grant, or Teams Graph observer/bot setup independently. Teams remains separately certificate-backed for Bot Connector and requires expected `AZURE_TENANT_ID`; Graph managed identity alone does not authorize bot posting.

Live execution also requires `mode: live`, all selection gates, approved targets and `ENABLE_LIVE_M365=true`. Live examples collect stable Service Health once per cycle independently of journey initialization; simulation keeps it off. Stable context needs separately approved `ServiceHealth.Read.All` admin consent. Exact overview status reports directly to `${service}-service-health` using `microsoft-reported-service-status` (100 healthy, 50 degraded, 0 interruption), with `impactSuppressed`. Failed/missing/unknown overviews produce Unknown without a numeric value and retain failure context; the existing trial observes Graph 403 pending consent. Experimental beta diagnostics remain off and require service-specific permissions plus `ENABLE_BETA_SERVICE_ACTIVITY=true`. Neither provider context nor beta diagnostics contributes to synthetic reports or Experience rollup.

## Container Apps boundary

Build from the self-contained Node project:

```sh
npm --prefix synthetic-tests run build
```

Use `synthetic-tests/` as the image's application/build context. Include its compiled service entries and runtime dependencies, then mount the project-root config separately and the selected service config at explicit paths. The same image can run an explicitly selected Exchange, Teams or SharePoint entry; separate apps retain independent 60/120/300-second default cadences.

The [shared hosting template](../synthetic-tests/infra/main.bicep) and [worker module](../synthetic-tests/infra/worker.bicep) support all three selected services using the [Dockerfile](../synthetic-tests/Dockerfile). Apps have no ingress, use single-revision mode and one replica, and request 0.25 CPU/0.5 GiB each. Use one authoritative replica per target set; rollouts/restarts can repeat attempts. Config hashes trigger rollouts when mounted configuration changes. Always-running loops require CPU outside HTTP requests and an instance that does not scale to zero; validate billing/scaling settings.

Workers have no persistent volume/history/outbox. Report retries and cycle aggregation are bounded memory only. Console diagnostics remain available, but reports are not a full metrics store, percentile history, or arbitrary log-query interface. Protect certificates where explicitly required, rotate them, and verify graceful shutdown and cleanup.

## Acceptance and cleanup

- Confirm entity-level direct reports, numeric aggregates, skipped Unknowns, separate suppressed provider status, and propagation through service/root models.
- Deny report ingestion and verify explicit failures without confusing publication failures with Microsoft 365 outages.
- Stop/stall workers, observe report expiry, and verify independent detection: TTL removes external signals, not a guaranteed Unhealthy state or alert.
- Test notifications end to end through a route not dependent only on Microsoft 365.

The [enterprise reliability gate](./operations.md#enterprise-reliability-acceptance-gate), independently observed freshness, model/reference authorization and a tested alert path remain requirements, not deployed functionality.

Reports, model evaluations and always-running compute incur costs. Agree on budgets, report cadence, TTL and diagnostic retention. Azure Monitor Health Models is preview; confirm applicable terms.

Incremental deployment will not remove old telemetry resources. The verified migration explicitly deleted both the demo and original PoC Log Analytics/Application Insights pairs and associated smart-detector rules, removed four workspace-query settings and four scoped reader-role assignments, and retained the original PoC model with its queries removed. All three apps now have no Application Insights environment settings or ingestion secrets; only root/service configuration secrets remain. Normal workspace deletion has a **14-day recovery window**, not a permanent purge. The obsolete Exchange-only mock template has also been stripped of telemetry and compiled. Follow the [migration procedure](../health-model/README.md#apply-and-migrate) for future environments; current cleanup/redeployment verification does not replace the all-service end-to-end acceptance gate still in progress.

Stop producers first when decommissioning. Reconcile stale report signals and model references, revoke only approved permissions, review retained synthetic artifacts, and remove dedicated resources only after owner approval. Never delete a shared resource group or unrelated resources.
