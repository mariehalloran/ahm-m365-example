# Journey and business-step entities with grouped signals

The [root config](../monitoring.config.json) selects services/scenarios, report policy and optional OTEL. The root health model references separate service models. Each selected journey has its own entity, with **business-step child entities**. Each journey and step always has an **External Reports** signal group; Azure Monitor export optionally adds an **OpenTelemetry** group.

The isolated development family is `m365-experience-demo` in `rg-m365-demo`, redeployed report-only with four models, 34 entities, 30 relationships, six journeys and 18 business-step entities. The older `m365-experience-poc` remains separate: its model entities/root are retained and queries removed. Both families' old telemetry pairs and associated smart-detector rules have been deleted; see [Apply and migrate](#apply-and-migrate). Normal workspace deletion has a 14-day recovery window, not a permanent purge. Provisioning and failure-path testing do not prove successful Microsoft 365 access or production readiness.

## Structure

```text
Root model: Microsoft 365 Experience
|
+-- Exchange Experience [references the Exchange model]
|   +-- Send and receive email [exchange-global entity]
|   |   +-- Create email [exchange-global-create-draft]
|   |   +-- Send email [exchange-global-send]
|   |   `-- Confirm delivery [exchange-global-confirm-delivery]
|   +-- Edit and reopen draft [exchange-draft entity]
|   |   +-- Create draft
|   |   +-- Update draft
|   |   `-- Reopen draft
|   `-- Service Health [suppressed context entity]
|
+-- Teams Experience [references the Teams model]
|   +-- Publish channel message [teams-global entity]
|   |   +-- Post message
|   |   `-- Confirm publication
|   +-- Reply in channel thread [teams-reply entity]
|   |   +-- Post message
|   |   +-- Post reply
|   |   `-- Confirm reply
|   `-- Service Health [suppressed context entity]
|
`-- SharePoint Experience [references the SharePoint model]
    +-- Save and reopen file [sharepoint-global entity]
    |   +-- Verify library
    |   +-- Upload file
    |   `-- Read file
    +-- Rename and reopen file [sharepoint-rename entity]
    |   +-- Verify library
    |   +-- Upload file
    |   +-- Rename file
    |   `-- Read renamed file
    `-- Service Health [suppressed context entity]
```

Token acquisition and cleanup still execute internally, but have **no published step results or standalone health signals**. Operational failures remain journey diagnostics; hiding these steps does not remove credentials, cleanup, cancellation budgets, or failure handling.

The service catalog contains two implemented journeys per service. Each enabled scenario receives its own entity and child business steps, without another service model or worker. Step IDs are journey-scoped (`<journey-entity>-<step>`), so reused actions never collide.

The default family has **four models, 34 entities and 30 relationships**: six journey entities, 18 business-step entities, service/root entities, three native model references and three suppressed Service Health entities. Service roots depend on their journeys and context; journeys depend on their business steps. Rollup uses `WorstOf` and `ignoreUnknown: false`.

Service models are named `<healthModel.name>-<service>`. Existing journey IDs (`exchange-global`, `teams-global`, `sharepoint-global`) remain stable. Each model's root entity has the same name as its model. Root prefixes are limited to 33 characters so service suffixes fit the 44-character model limit.

## Health reports target signals

The [Health Report Ingestion API](https://learn.microsoft.com/azure/azure-monitor/health-models/health-report-ingestion) targets a **named external signal on an existing entity**. The entity path identifies the journey or business step; `signalName` identifies the measurement.

For example, the send action reports to `exchange-global-send` in the Exchange model:

```json
{
  "signalName": "synthetic-success-percentage",
  "healthState": "Unhealthy",
  "value": 0,
  "expiresInMinutes": 15
}
```

Each journey and business-step entity uses `synthetic-success-percentage` and `synthetic-mean-duration` in its **External Reports** group. The journey reports whole-attempt measurements; each child reports only its corresponding action.

For each complete cycle, success is `100 * succeeded / executed`; duration is mean milliseconds across executed samples, including failures. Default Degraded/Unhealthy thresholds are below 99%/95% success and above 15,000/60,000 ms. Equality does not breach. These are demo thresholds, not per-action SLOs or p95.

Skipped actions receive Unknown without numeric values; they are not failed requests. No samples never means 100% success or zero latency. Whole-journey elapsed time still includes internal work. Request, confirmed delivery/publication, and whole-journey timing retain their separate definitions.

Cleanup failures and credential failures still explain an unsuccessful journey, but do not generate standalone step observations. Valid-but-incomplete setup produces actual unexecutable initialization failures; unexecuted business actions remain Unknown. `--once` still fails after reporting an initialization error.

The API creates external signals, not entities, and uses `2026-05-01-preview`; a 204 acknowledges ingestion. Reports replace the previous cycle with a default 15-minute TTL. Expiry removes the external signal; it does **not** guarantee an Unhealthy state or an alert. Independently monitor execution and publication freshness. Workers keep no cross-cycle aggregation history or durable outbox.

## Microsoft-reported Service Health

Each service has a separate `${service}-service-health` entity with `impactSuppressed` and an **External Reports** group. Stable v1.0 overview status publishes directly as `microsoft-reported-service-status`: **100 healthy, 50 degraded, 0 interruption**. Failed collection, a missing exact-service overview, or unknown status publishes **Unknown without a numeric value**, with failure context. Issue history and experimental beta reports remain console diagnostics only, not health evidence for journeys or steps.

Collection runs once per service cycle even if journey initialization fails. `ServiceHealth.Read.All` needs separate tenant-admin consent; the existing live trial observes Graph 403 until that approval is granted. No healthy provider snapshot is invented. Suppression keeps provider context out of Experience rollup and synthetic success calculations.

With OTEL disabled there are no query-backed sources. External Reports groups use `WorstOf` and `ignoreUnknown: false`; entities without signals omit group definitions rather than submitting an invalid empty array. Reports provide current-cycle success percentages and mean durations, not a full metrics store, percentiles, or arbitrary log queries. Cross-cycle weighted statistics cannot be reconstructed from means alone.

## Optional OTEL signals

Root `otel.enabled` defaults to false. Only `enabled: true` with `destination: azure-monitor` and at least one enabled journey provisions Log Analytics and workspace-backed Application Insights. `destination: console` is a local OTEL preview and does not create telemetry infrastructure or query-backed signals.

Azure export adds `otel-success-percentage` and `otel-mean-duration` under **OpenTelemetry** on every enabled journey/business-step entity. The existing External Reports group, reports and 34-entity topology remain intact. Service Health stays suppressed and external-report-only. No per-target signal inventories or monitoring-pipeline entities are added.

The shared [KQL source](./queries/synthetic.kql) binds the Application Insights resource ID, service, journey and business step. It queries `AppTraces` for live schema-2.0 `synthetic-result` or `synthetic-step` logs with observation and ingestion timestamps inside 15 minutes. Skipped/internal actions and provider logs cannot become synthetic samples. Success is the mean of binary samples times 100; duration is mean milliseconds, including executed failures. No data yields no numeric result, not a healthy fallback. Queries evaluate every minute and use the same root thresholds as direct reports, but their rolling window can differ from current-cycle report health and adds ingestion/query latency.

Each service-model identity receives workspace-scoped Log Analytics Reader and managed-identity query authentication. Workers receive no workspace-query permission. Default resource names are `law-<model-name>` and `appi-<model-name>`; if overridden, use the same Application Insights name in the worker deployment. Connection strings are not model deployment outputs.

Enabling export adds ingestion/storage/query costs and requires verifying actual `AppTraces`/metrics arrival and model evaluation. This source restoration has not changed the recorded report-only cloud deployment.

## Implementation and permissions

- [main.bicep](./infra/main.bicep): scenario selection, root model and native references.
- [service-catalog.bicep](./infra/service-catalog.bicep): typed service/journey catalog and business actions.
- [service.bicep](./infra/service.bicep): selected journey and child step entities with named source groups, using entities API `2026-10-01-preview`.
- [Health reporting](../synthetic-tests/utils/src/health-reports.ts): aggregate and publish named signals to journey/step entities.
- [Report projection](../synthetic-tests/utils/src/contracts.ts): exclude internal token/cleanup observations from published results.

Use a current Bicep CLI supporting typed exports and functions. ARM language version 2.0 represents existing resources symbolically; these are not extra deployments.

Workers need only `Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action` on their service model, independently of Microsoft 365 authorization. The root identity receives Reader on its child models for [native nesting](https://learn.microsoft.com/azure/azure-monitor/health-models/concepts#nested-health-models). Worker identities need no model administration.

## Apply and migrate

Use the same reviewed private root config for models and workers. Its subscription/resource group must match deployment scope:

```sh
az deployment group what-if --subscription '<approved-subscription>' \
  --resource-group '<approved-resource-group>' --template-file health-model/infra/main.bicep \
  --parameters projectConfig=@/absolute/path/monitoring.private.json

# Only after reviewing the preview:
az deployment group create --subscription '<approved-subscription>' \
  --resource-group '<approved-resource-group>' --name m365-model-foundation \
  --template-file health-model/infra/main.bicep \
  --parameters projectConfig=@/absolute/path/monitoring.private.json
```

Deploy the model before the matching worker image so all six journey and journey-scoped step destinations exist before reports arrive. The previous compact layout's inline `<step>-*` external signals stop refreshing after worker cutover and disappear after their existing TTL (normally 15 minutes); do not invent reports or recreate journey entities to clear them. Reconcile any earlier unscoped step entities/relationships only after verifying ownership.

**Incremental deployment does not delete obsolete resources.** When opting out of previously deployed OTEL, explicitly reconcile old query signals/groups, query authentication, scoped reader assignments and obsolete app connection-string settings. Delete only owned telemetry resources after reviewing retention/export obligations; never delete an active destination merely because earlier report-only migration instructions did so. Preserve model entities/root, native references and workers. When enabling OTEL, deploy model/telemetry resources before the matching workers. Never use complete deployment mode on a shared resource group.

For the current demo, cleanup and report-only redeployment are verified: both telemetry pairs and associated smart-detector rules are deleted, four workspace-query settings and four scoped reader-role assignments are removed, and all three apps have ready/running `--0000006` revisions with no Application Insights environment settings or ingestion secrets. The latest model and optional-OTEL-capable workers were redeployed on 2026-10-22 with OTEL disabled. Only root/service configuration secrets remain. Normal workspace deletion has a **14-day recovery window**, not a permanent purge. The original PoC model entities/root remain with their queries removed.

The [shared worker guide](../synthetic-tests/infra/README.md#verified-report-only-deployment) records the immutable image digest and passed all-service live failure-path acceptance. All **51 external signals are fresh**: all six journeys are Unhealthy, skipped business actions are Unknown without numeric values, and all three Service Health context signals are Unknown with Graph 403/permission-failure diagnostics. The root and native service references are Unhealthy. No telemetry resources, query bindings, workspace authentication, instrumentation-key/ingestion secrets, or configured platform log-forwarding destination remain. This verifies real failure reporting and model rollup, not successful Microsoft 365 journeys or notification delivery.

## Validation and limits

```sh
python3 -B -m unittest discover -s health-model/tests -p 'test_*.py'
npm --prefix synthetic-tests test
```

Offline tests cover scenario selection, multiple journey definitions, optional workspace/query conditions, external-report preservation, query/record contracts, internal-step exclusion, and preserved execution/cleanup behavior. They are not Azure deployment simulations or live KQL execution tests.

Verify live business-action data, fresh direct reports and service/root rollup after deployment. Successful token acquisition is not mailbox access, API-backed tests are not employee login/UI tests, and Unhealthy configuration failures are not proof of a Microsoft outage.

With both journeys per product at default cadence, synthetic journey/step reports make about **38,304 calls/day before retries**, plus stable provider reports when enabled. No extra Container Apps are added. Review applicable pricing, report/API quotas and the [enterprise acceptance gate](../docs/operations.md#enterprise-reliability-acceptance-gate). Passed all-service live failure-path acceptance does not establish successful tenant journeys, production readiness, or notification delivery.
