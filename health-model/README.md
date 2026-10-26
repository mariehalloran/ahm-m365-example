# Journey and business-step entities with grouped signals

The [root config](../monitoring.config.json) selects runtime services/scenarios, report policy and optional OTEL. The root health model references separate service models. Each journey has its own entity, with **business-step child entities**. Implemented journeys/steps always have an **External Reports** signal group; Azure Monitor export optionally adds an **OpenTelemetry** group. Planned coverage has no signals.

Use the same reviewed root configuration for model and worker deployment. For
recorded live acceptance and remaining gaps, see [deployment status](../docs/deployment.md#deployment-status-and-order).
Provisioning or failure-path testing alone does not prove successful Microsoft 365
access or production readiness.

## Catalog versus modeled and live coverage

The model represents **selected implemented root scenarios plus the full documented
planned catalog** by default (`includePlannedJourneys=true`).
See [Exchange's six core journeys](../synthetic-tests/exchange/README.md#journeys-and-scheduling),
[Teams' five target families and narrower current coverage](../synthetic-tests/teams/README.md#target-catalog-versus-current-implementation),
[SharePoint's five target families and supporting rename coverage](../synthetic-tests/sharepoint/README.md#target-catalog-versus-current-implementation),
and [OneDrive's roundtrip, app-folder persistence and versions](../synthetic-tests/onedrive/README.md).
The checked-in root selects Exchange, Teams and OneDrive and disables SharePoint.
Planned roots and business steps are labeled **[Planned / unimplemented]**, have no
external or OTEL signals, and remain Unknown without fabricated reports. Their roots
have suppressed impact; references with no selected implemented journeys are also suppressed.
Thus missing implementations cannot make existing synthetic experience rollups
permanently Unknown. Suppression is not success or evidence of execution.
The OneDrive reference now uses the same scoped nested-model Reader assignment as
other active services. Its worker's report-ingestion permission is separate from
Microsoft 365 file permissions. Neither model existence nor Reader access proves
live file operations or report ingestion.

The [implemented catalog](./infra/service-catalog.bicep) remains shared with model
selection; the [planned catalog](./infra/planned-catalog.bicep) is model-only metadata,
not fake worker registration or additional root scenario switches. Set
`includePlannedJourneys=false` for an implemented-only **new** deployment; incremental
ARM deployment does not delete previously deployed planned entities.

| Service | Implemented roots (existing IDs preserved) | Planned roots / variants |
| --- | --- | --- |
| Exchange | 6: mail, draft, attachment/reply, distribution list, recurring calendar, meeting invitation | 4: search/organize, external inbound variant, external outbound variant, OutlookWeb variant |
| Teams | 3: publish, reply, two-bot meeting roster/playback/departure | 7: full two-bot conversation, bidirectional audio, full scheduled meeting, recipient file sharing, Adaptive Card, TeamsWeb messaging variant, TeamsWeb meeting variant |
| SharePoint | 2 handlers retained, disabled in the checked-in selection | 6: metadata/nested-folder roundtrip, list-item lifecycle, recipient sharing, versions, search/indexing, browser-upload variant |
| OneDrive | 3: selected-folder roundtrip, app-folder persistence, actual prior-version retrieval; optional downloaded-byte restore | 3 remaining: recipient sharing, search/retrieve, browser-file variant |

The complete target families are separate from narrower implemented coverage:
single-bot readback does not prove two-bot receipt; meeting roster and completed
playback do not prove received audio; exact-content readback does not claim the full folder/hash family.
Optional restore/check-in/out are variant steps within planned versions, not
duplicate test suites. Authentication/cleanup are not modeled as business steps.

Exchange mail runs every 60 seconds and its other five core journeys every 300;
current Teams scenarios run every 120 and all three OneDrive lanes every 300. Cadence/deadlines
belong to service-owned execution lanes; root config selects scenarios and targets.
Execution timeouts are failed attempts reported Unhealthy; unexecuted dependent
steps stay unobserved, not failed requests. Model existence is not live verification:
Exchange mail/draft/attachment-reply/DL are verified Healthy, calendar is currently
403-blocked by scoped-authorization cache propagation; Teams verification covers
single-bot Graph readback and call signaling only; SharePoint awaits live targets.

## Structure

The service catalogs below include retained SharePoint coverage, disabled by
default. The planned catalog adds suppressed journey roots. OneDrive is active
only when explicitly selected, including in the checked-in simulation profile.

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
|   +-- Two-bot meeting audio [teams-call entity; call-test-user scenario ID retained]
|   |   +-- Join as two independently authenticated bots
|   |   +-- Verify both calls established
|   |   +-- Verify both application identities in both rosters
|   |   +-- Play primary test tone and authenticate completion
|   |   `-- Leave both owned legs and confirm disconnected
|   `-- Service Health [suppressed context entity]
|
+-- OneDrive Experience [references the OneDrive model]
|   +-- User-drive roundtrip [onedrive-planned-user-drive-roundtrip]
|   +-- App-folder persistence [onedrive-planned-app-folder-lifecycle]
|   +-- Document versions [onedrive-planned-document-versions]
|   `-- Service Health [suppressed; no supported collector/call children]
|
`-- SharePoint Experience [disabled; planned-only reference in the sample]
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

The service catalog contains six Exchange journeys, two retained SharePoint journeys, three OneDrive journeys and three Teams journeys, including bounded two-bot meeting join/roster/Graph-confirmed prerecorded playback/departure. Exchange adds attachment/reply, explicit distribution-list delivery, recurring calendar and meeting invitation flows; its draft includes initial read and deletion. Each enabled scenario receives its own entity and child business steps without another service model or worker. Step IDs are journey-scoped (`<journey-entity>-<step>`), so reused actions never collide.

The checked-in selection has **five models, 171 entities and 166 relationships**:
32 journey roots (12 active, 20 planned) and 113 business-step entities
(47 active, 66 planned), four native model references, three suppressed Service
Health entities and fourteen provider-call children. Implemented-only selection has
four models, 83 entities and 79 relationships. Service roots depend on journeys and
context; journeys depend on business steps. Rollup uses `WorstOf` and
`ignoreUnknown: false`, with planned roots suppressed. The `teams-call` journey
retains `place-call`, `wait-for-answer`, `play-audio`, `end-call`, and adds
`verify-participants`. The obsolete deployed `wait-before-hangup` child and its
relationship need narrowly scoped operator removal after deployment; never delete
the journey or whole model to migrate it.

OneDrive promotes the existing `onedrive-planned-user-drive-roundtrip`,
`onedrive-planned-app-folder-lifecycle`, and
`onedrive-planned-document-versions` roots and their `step-1`…`step-4` children.
The historical `-planned-` name does not determine impact or signals: active
metadata gives normal rollup, UserFlow icons and External Reports. Semantic
business-action names remain the OTEL query selectors. Model assembly filters
planned duplicates of active IDs; older profiles without OneDrive retain all six
suppressed planned roots, without enabling a worker. Search, recipient sharing and
browser variants remain explicitly unimplemented.
Target attempts aggregate into shared entities, not per-user signals.

All 34 **journey roots**, implemented and planned, use the **User flow** icon
(`properties.icon.iconName: 'UserFlow'`); service roots, context and business steps
do not. No custom icon is needed.

Service models are named `<healthModel.name>-<service>`. Existing journey IDs (`exchange-global`, `teams-global`, `sharepoint-global`) remain stable. Each model's root entity has the same name as its model. Root prefixes are limited to 33 characters so service suffixes fit the 44-character model limit.

## Health reports target signals

The [Health Report Ingestion API](https://learn.microsoft.com/azure/azure-monitor/health-models/health-report-ingestion) targets a **named external signal on an existing entity**. The entity path identifies the journey or business step; `signalName` identifies the measurement.

For example, the send action reports to `exchange-global-send` in the Exchange model:

```json
{
  "signalName": "synthetic-success-percentage",
  "healthState": "Unhealthy",
  "value": 0,
  "expiresInMinutes": 15,
  "additionalContext": "{\"unit\":\"Percent\"}"
}
```

Each journey and business-step entity uses `synthetic-success-percentage` and `synthetic-mean-duration` in its **External Reports** group. The journey reports whole-attempt measurements; each child reports only its corresponding action.

For each complete cycle, success is `100 * succeeded / executed`; duration is mean milliseconds across executed samples, including failures. Default Degraded/Unhealthy thresholds are below 99%/95% success and above 15,000/60,000 ms. Equality does not breach. These are demo thresholds, not per-action SLOs or p95.

Skipped actions receive Unknown without numeric values; they are not failed requests. No samples never means 100% success or zero latency. Whole-journey elapsed time still includes internal work. Request, confirmed delivery/publication, and whole-journey timing retain their separate definitions.

Cleanup failures and credential failures still explain an unsuccessful journey, but do not generate standalone step observations. Valid-but-incomplete setup produces actual unexecutable initialization failures; unexecuted business actions remain Unknown. `--once` still fails after reporting an initialization error.

The API creates external signals, not entities, and uses `2026-05-01-preview`; a 204 acknowledges ingestion. Reports replace the previous cycle with a default 15-minute TTL. Expiry removes the external signal; it does **not** guarantee an Unhealthy state or an alert. Independently monitor execution and publication freshness. Workers keep no cross-cycle aggregation history or durable outbox.

### Direct-report units: platform limitation

Every direct report includes a unit in its JSON `additionalContext`, including Unknown reports: synthetic success `Percent`, synthetic duration `Milliseconds`, provider percentages `Percent`, provider counts `Count`, and categorical overview mappings `status-score` (not an availability percentage). These units accompany the measurements in the model's external-report context; **they do not populate native UI unit labels**.

The first-party [`HealthReportRequest` schema](https://github.com/Azure/azure-rest-api-specs/blob/main/specification/cloudhealth/resource-manager/Microsoft.CloudHealth/CloudHealth/preview/2026-05-01-preview/cloudhealth.json) allows `signalName`, `healthState`, `value`, `evaluationRules`, `expiresInMinutes`, and `additionalContext`, but **no `dataUnit`**. The October schema has the same restriction. `dataUnit` is a 1–100-character string (not an enum) on query-backed signal definitions, not ingestion requests. `signalGroups.external` is read-only, so predeclaring external units would also be unsupported. Optional OTEL query signals retain native `Percent`/`Milliseconds` units. Native units on direct external reports require a platform API change; no read-only field or invented ingestion property is written.

## Microsoft-reported Service Health

Each service has a separate `${service}-service-health` parent with `impact: Suppressed`. Beneath it, separate entities visibly list each collected API:

| Child entity suffix | External Reports member |
| --- | --- |
| `-health-overviews` | `microsoft-reported-service-status` |
| `-issues` | `microsoft-reported-issue-count` |
| `-<activity-function>` | `microsoft-activity-<activity-function>` |

Exchange/Teams each have five named activity children; SharePoint has the two stable children only. The model catalogs every supported call so selection changes need no new entity deployment. Workers publish only enabled stable calls and selected beta functions. Disabled/unselected calls remain unobserved (or expire after a previous selection), not Healthy. Each call has its own **External Reports** group; the parent aggregates child context only and no longer lists duplicate external members.

Stable v1.0 operational/degradation/interruption maps to **100 healthy, 50 degraded, 0 interruption**; unapproved states/failed/missing data are **Unknown without a value**. A successful complete issues collection reports a diagnostic count (including a verified empty snapshot as zero), always **Unknown**, not an availability score. Every selected beta function reports its latest fresh bucket: without explicit customer thresholds, numeric values display with **Unknown** and no evaluation rules; with thresholds, only that context measurement is evaluated. Failed, missing, stale or malformed observations report Unknown without a value. QoE coverage is never automatic call quality. No provider signal supplies synthetic/Experience health. See [provider setup, exact functions and mappings](../docs/provider-monitoring.md).

Collection has its own lane inside each existing service container, with configurable `providerIntervalSeconds` (default 300), independent of journey setup/cadence. Stable and beta permissions/consent are separate. No healthy provider snapshot is invented. Suppression keeps provider context out of Experience rollup and synthetic success calculations; direct reporting does not require Log Analytics.

With OTEL disabled there are no query-backed sources. External Reports groups use `WorstOf` and `ignoreUnknown: false`; entities without signals omit group definitions rather than submitting an invalid empty array. Reports provide current-cycle success percentages and mean durations, not a full metrics store, percentiles, or arbitrary log queries. Cross-cycle weighted statistics cannot be reconstructed from means alone.

## Optional OTEL signals

Root `otel.enabled` defaults to false. Only `enabled: true` with `destination: azure-monitor` and at least one enabled journey provisions Log Analytics and workspace-backed Application Insights. `destination: console` is a local OTEL preview and does not create telemetry infrastructure or query-backed signals.

Azure export adds `otel-success-percentage` and `otel-mean-duration` under **OpenTelemetry** on every selected implemented journey/business-step entity, not planned nodes. External Reports and topology remain intact. Service Health stays suppressed and external-report-only. No per-target signal inventories or monitoring-pipeline entities are added.

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

Workers need only `Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action` on their service model, independently of Microsoft 365 authorization. The root identity receives Reader on implemented child models for [native nesting](https://learn.microsoft.com/azure/azure-monitor/health-models/concepts#nested-health-models); planned-only models do not add permission grants. Worker identities need no model administration.

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

Provider-call presentation adds sixteen child entities/relationships and moves existing overview/activity signal destinations from `${service}-service-health` to those children. Deploy the model before matching workers, then stop **all old worker revisions** that refresh parent-level signals. The parent no longer declares those old aggregation members; previously ingested signals themselves remain until their existing TTL expires (normally 15 minutes; use the actual prior `expiresInMinutes`). Verify the parent external inventory is empty after expiry and each enabled call is ingested on its child. Do not delete/recreate the suppressed parent or fabricate clearing reports. No deployment, old-signal deletion or live-profile change is performed by the source update.

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

With the twelve selected journeys at default cadences (Exchange mail 60 seconds, other Exchange/OneDrive journeys 300 seconds, Teams 120 seconds), synthetic journey/step reports make about **51,552 ingestion calls/day before retries**, plus supported provider reports when enabled. Lane publication updates only observed journeys; an independent fast lane never sends empty/Unknown reports for slow-lane entities. Timeouts publish failed journey evidence; prerequisite-skipped action entities have no invented failure samples. No extra Container Apps are added. Calling adds service API traffic and a Teams-only authenticated public callback; it proves placement, configured dwell and disconnection, not ringing, device notification, employee sign-in or media quality. Review applicable pricing, report/API quotas and the [enterprise acceptance gate](../docs/operations.md#enterprise-reliability-acceptance-gate).
