# Journey and business-step entities with grouped signals

The [root config](../monitoring.config.json) selects services/scenarios, report policy and optional OTEL. The root health model references separate service models. Each selected journey has its own entity, with **business-step child entities**. Each journey and step always has an **External Reports** signal group; Azure Monitor export optionally adds an **OpenTelemetry** group.

Use the same reviewed root configuration for model and worker deployment. For
recorded live acceptance and remaining gaps, see [deployment status](../docs/deployment.md#deployment-status-and-order).
Provisioning or failure-path testing alone does not prove successful Microsoft 365
access or production readiness.

## Catalog versus modeled and live coverage

The model represents **implemented root scenarios**, not every agreed target family.
See [Exchange's six core journeys](../synthetic-tests/exchange/README.md#journeys-and-scheduling),
[Teams' five target families and narrower current coverage](../synthetic-tests/teams/README.md#target-catalog-versus-current-implementation),
[SharePoint's five target families and supporting rename coverage](../synthetic-tests/sharepoint/README.md#target-catalog-versus-current-implementation),
and [OneDrive's entirely planned catalog](../synthetic-tests/README.md#onedrive-target-catalog-planned).
There is no OneDrive worker/model yet; planned browser, media, recipient-access and
other families do not acquire entities or Healthy signals merely by being documented.

Exchange mail runs every 60 seconds and its other five core journeys every 300;
current Teams scenarios run every 120 and SharePoint every 300. Cadence/deadlines
belong to service-owned execution lanes; root config selects scenarios and targets.
Execution timeouts are failed attempts reported Unhealthy; unexecuted dependent
steps stay unobserved, not failed requests. Model existence is not live verification:
Exchange mail/draft/attachment-reply/DL are verified Healthy, calendar is currently
403-blocked by scoped-authorization cache propagation; Teams verification covers
single-bot Graph readback and call signaling only; SharePoint awaits live targets.

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
|   |   +-- Initial read
|   |   +-- Update draft
|   |   +-- Reopen draft
|   |   `-- Delete owned draft [optional trial retention can skip]
|   +-- Attachment/hash/correlated reply [exchange-attachment entity]
|   +-- Distribution-list fanout [exchange-distribution entity]
|   +-- Recurring calendar CRUD/occurrence [exchange-recurring entity]
|   +-- Meeting invitation/accept/cancel [exchange-meeting entity]
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
|   +-- Call test users [teams-call entity]
|   |   +-- Place individual call
|   |   +-- Wait before hang-up
|   |   `-- End call and confirm disconnected
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

Token acquisition and generic cleanup still execute internally, but have **no published step results or standalone health signals**. Explicit draft/event deletion, meeting cancellation and call hang-up are business steps. Operational failures remain journey diagnostics; hiding internal steps does not remove credentials, cleanup, cancellation budgets, or failure handling.

The service catalog contains six Exchange journeys, two SharePoint journeys and three Teams journeys, including signaling-only individual test-user calls. Exchange adds attachment/reply, explicit distribution-list delivery, recurring calendar and meeting invitation flows; its draft includes initial read and deletion. Each enabled scenario receives its own entity and child business steps without another service model or worker. Step IDs are journey-scoped (`<journey-entity>-<step>`), so reused actions never collide.

The default source family has **four models, 61 entities and 57 relationships**: eleven journey entities, 40 business-step entities, service/root entities, three native model references and three suppressed Service Health entities. Service roots depend on their journeys and context; journeys depend on their business steps. Rollup uses `WorstOf` and `ignoreUnknown: false`. The `teams-call` journey has `place-call`, `wait-before-hangup`, `end-call` children; existing journey IDs are unchanged. Multiple target attempts aggregate into shared entities, not per-user signals. Healthy calling is placement, dwell and verified hang-up, not proof of recipient ringing or receipt.

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

Each service has a separate `${service}-service-health` entity with `impactSuppressed` and an **External Reports** group. Stable v1.0 operational/degradation/interruption publishes as `microsoft-reported-service-status`: **100 healthy, 50 degraded, 0 interruption**; unapproved states/failed/missing data are **Unknown without a value**. Exchange/Teams context groups also admit the five service-owned `microsoft-activity-<function>` signal names. Explicit customer beta thresholds report latest fresh buckets directly; counts and Teams percentages remain diagnostic absent thresholds. QoE coverage is never automatic call quality. Issue history stays diagnostic; no provider signal supplies synthetic/Experience health. See [provider setup, exact functions and mappings](../docs/provider-monitoring.md).

Collection has its own lane inside each existing service container, with configurable `providerIntervalSeconds` (default 300), independent of journey setup/cadence. Stable and beta permissions/consent are separate. No healthy provider snapshot is invented. Suppression keeps provider context out of Experience rollup and synthetic success calculations; direct reporting does not require Log Analytics.

With OTEL disabled there are no query-backed sources. External Reports groups use `WorstOf` and `ignoreUnknown: false`; entities without signals omit group definitions rather than submitting an invalid empty array. Reports provide current-cycle success percentages and mean durations, not a full metrics store, percentiles, or arbitrary log queries. Cross-cycle weighted statistics cannot be reconstructed from means alone.

## Optional OTEL signals

Root `otel.enabled` defaults to false. Only `enabled: true` with `destination: azure-monitor` and at least one enabled journey provisions Log Analytics and workspace-backed Application Insights. `destination: console` is a local OTEL preview and does not create telemetry infrastructure or query-backed signals.

Azure export adds `otel-success-percentage` and `otel-mean-duration` under **OpenTelemetry** on every enabled journey/business-step entity. External Reports and topology remain intact (61 entities with all eleven journeys). Service Health stays suppressed and external-report-only. No per-target signal inventories or monitoring-pipeline entities are added.

The shared [KQL source](./queries/synthetic.kql) binds the Application Insights resource ID, service, journey and business step. It queries `AppTraces` for live schema-2.0 `synthetic-result` or `synthetic-step` logs with observation and ingestion timestamps inside 15 minutes. Skipped/internal actions and provider logs cannot become synthetic samples. Success is the mean of binary samples times 100; duration is mean milliseconds, including executed failures. No data yields no numeric result, not a healthy fallback. Queries evaluate every minute and use the same root thresholds as direct reports, but their rolling window can differ from current-cycle report health and adds ingestion/query latency.

Each service-model identity receives workspace-scoped Log Analytics Reader and managed-identity query authentication. Workers receive no workspace-query permission. Default resource names are `law-<model-name>` and `appi-<model-name>`; if overridden, use the same Application Insights name in the worker deployment. Connection strings are not model deployment outputs.

Enabling export adds ingestion/storage/query costs and requires verifying actual `AppTraces`/metrics arrival and model evaluation. Offline validation does not establish cloud ingestion.

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

Deploy the model before the matching worker image so all selected journey and journey-scoped step destinations exist before reports arrive. Exchange expansion adds four journey entities, seventeen business-step entities and the draft's two new steps: 23 entities/relationships and 46 external signals when all are selected. Existing mail/draft journey and mail create-draft IDs remain valid; this expansion requires no deletion of those entities. The previous compact layout's inline `<step>-*` external signals stop refreshing after worker cutover and disappear after their existing TTL (normally 15 minutes); do not invent reports or recreate journey entities to clear them. Reconcile any earlier unscoped step entities/relationships only after verifying ownership.

**Incremental deployment does not delete obsolete resources.** When opting out of previously deployed OTEL, explicitly reconcile old query signals/groups, query authentication, scoped reader assignments and obsolete app connection-string settings. Delete only owned telemetry resources after reviewing retention/export obligations; never delete an active destination merely because earlier report-only migration instructions did so. Preserve model entities/root, native references and workers. When enabling OTEL, deploy model/telemetry resources before the matching workers. Never use complete deployment mode on a shared resource group.

When changing business-step IDs, deploy the new entities/relationships before
worker cutover. Verify fresh reports, then remove only the superseded owned
relationships/entities. Do not recreate stable journey roots or delete unrelated
resources; incremental deployments can leave both generations present.

## Validation and limits

```sh
python3 -B -m unittest discover -s health-model/tests -p 'test_*.py'
npm --prefix synthetic-tests test
```

Offline tests cover scenario selection, multiple journey definitions, optional workspace/query conditions, external-report preservation, query/record contracts, internal-step exclusion, and preserved execution/cleanup behavior. They are not Azure deployment simulations or live KQL execution tests.

Verify live business-action data, fresh direct reports and service/root rollup after deployment. Successful token acquisition is not mailbox access, API-backed tests are not employee login/UI tests, and Unhealthy configuration failures are not proof of a Microsoft outage.

With all eleven journeys at default cadences (Exchange mail 60 seconds, other Exchange journeys 300 seconds), synthetic journey/step reports make about **48,096 ingestion calls/day before retries**, plus stable provider reports when enabled. Lane publication updates only observed journeys; an independent fast lane never sends empty/Unknown reports for slow-lane entities. Timeouts publish failed journey evidence; prerequisite-skipped action entities have no invented failure samples. No extra Container Apps are added. Calling adds service API traffic and a Teams-only authenticated public callback; it proves placement, configured dwell and disconnection, not ringing, device notification, employee sign-in or media quality. Review applicable pricing, report/API quotas and the [enterprise acceptance gate](../docs/operations.md#enterprise-reliability-acceptance-gate).
