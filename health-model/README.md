# Journey and business-step health models

The [root configuration](../monitoring.config.json) selects executable journeys.
The root health model references one independent model each for Exchange, Teams
and OneDrive. The [shared catalogue](../synthetic-tests/utils/src/catalog.ts) contains only retained
journeys and their business steps; there is no optional proposal catalog or
planned-entity deployment switch.
Bicep reads its generated JSON projection; use `npm run catalog:generate` from
`synthetic-tests/` after changing metadata.
See [architecture and health-model data-flow diagrams](../docs/architecture.md)
for the distinction between synthetic evaluation and supporting provider context.

## Root health alerts

Set `healthModel.alertActionGroupIds` in the root configuration to the full Azure
resource IDs of your Azure Monitor action groups. Up to five unique IDs are
supported. Create the groups and manage recipients in Azure; notification
addresses do not belong in the project configuration.

For incident/ticketing integration, see
[IT Service Management integration](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/itsmc-overview),
including its secure-webhook guidance and ServiceNow ITSM-action deprecation notice.

`npm run deploy` from `synthetic-tests/` connects those groups to the main model's
**Microsoft 365 Experience** root entity: **Degraded = Sev 2**, **Unhealthy =
Sev 1**. Alerts fire when the root enters the corresponding state, not on every
probe cycle. Nested service and journey entities get no additional alerts.
See the [native alert behavior](https://learn.microsoft.com/azure/azure-monitor/health-models/alerts).

An omitted or empty list configures no root alerts. The template does not create,
modify or delete action groups or their receivers.
After deployment, test action-group delivery and both root-state transitions in a
non-production model; source validation does not establish email delivery.
Healthy and Unknown are not alert conditions. Keep the
[independent execution, freshness and notification safeguards](../docs/operations.md#enterprise-reliability-acceptance-gate);
missing reports alone do not guarantee a root alert.

## Selected topology

Every service model contains:

- One service Experience root and its selected journeys; Exchange inserts Mail
  and Calendar parent user journeys.
- An impact-suppressed `${service}-service-health` supporting entity only when
  root `serviceHealth.enabled` is explicitly `true`.
- Business-step children for every selected journey.
- Numeric signals on each journey and executed business step, supplied either by
  direct worker reports or native observation queries. The only signal aggregation groups are your
  [Exchange/OneDrive user groups](../docs/monitoring-groups.md), on their journey entities.

The supporting entity receives stable overview and issue-count signals plus
enabled beta activity signals, ungrouped: up to eleven for Exchange (two stable
and nine beta), seven for Teams (two stable and five beta), and two for OneDrive,
which has no beta endpoint in the referenced Graph resource. Unavailable enabled
sources report Unknown without a numeric value; disabled sources are not reported.
There are **no per-API child entities or relationships**.
Provider context never supplies synthetic samples or Experience health.

Exchange groups its existing journeys under two parents:

| Parent user journey | Child journeys |
| --- | --- |
| Mail (`exchange-mail`) | Self-send/Inbox receipt, draft lifecycle, self-attachment delivery, explicitly labelled SELF-REPLY |
| Calendar (`exchange-calendar`) | Private recurring-series lifecycle in the user's own calendar, no attendees |

These parents roll up child health with native `WorstOf` dependencies; they do
not receive synthetic reports or query signals. A parent is omitted when none of
its children are selected. Teams and OneDrive retain their direct journey children.

The root config and shared catalogue determine the model inventory.
Explicit root `"serviceHealth": { "enabled": true }` adds one supporting entity
and relationship per selected service and permits configured provider collection.
The default and omission are off; there are no provider calls, provider lanes or
provider reports while off.

Disabling a service or every one of its scenarios excludes its nested model and
root reference from the desired deployment. Individual scenario switches remove
that journey and its steps from the desired inventory, plus its parent when the
last selected child is removed. With several tenants, a journey stays modeled while
any tenant runs it.

### Stable journey IDs

| Service | Root scenario → journey entity |
| --- | --- |
| Exchange | `send-receive-mail` → `exchange-global`; `edit-reopen-draft` → `exchange-draft`; `attachment-mail` → `exchange-attachment`; `reply-mail` → `exchange-reply`; `recurring-calendar` → `exchange-recurring` |
| Teams | `channel-conversation` → `teams-global`; `scheduled-meeting` → `teams-call` |
| OneDrive | `user-drive-roundtrip` → `onedrive-planned-user-drive-roundtrip`; `app-folder-lifecycle` → `onedrive-planned-app-folder-lifecycle`; `document-versions` → `onedrive-planned-document-versions` |

OneDrive's historical `-planned-` names already receive real reports and **must
not be renamed or deleted because of that substring**. Its semantic steps map to
the existing `step-1`…`step-4` child IDs. Other child IDs are
`<journey-entity>-<semantic-step>`. The optional OneDrive byte-restore step is
suppressed when no configured OneDrive target enables `restoreVersion`.

Only journeys and their Mail/Calendar parents use the native `UserFlow` icon.
Authentication and generic cleanup are internal—not extra entities. Explicit draft/file deletion,
private-series deletion and call departure remain measured business steps.

Journey guides define exact evidence and API boundaries:
[Exchange](../synthetic-tests/exchange/README.md#journeys-and-scheduling),
[Teams](../synthetic-tests/teams/README.md#journeys-and-evidence),
[OneDrive](../synthetic-tests/onedrive/README.md#journeys-and-exact-endpoints).
Graph bot readback is not a second bot's receipt, and verified meeting
connectivity does not prove received audio, bidirectional audio or call quality.

## Signal delivery modes

The root `logAnalytics.enabled` flag selects one reporting mode for all services:

| Value | Synthetic health source |
| --- | --- |
| `false` (default) | Service containers publish direct, per-cycle aggregate health reports after each execution lane settles. Each report includes a numeric value, evaluated health state and a TTL of `healthModel.signalWindowMinutes` minutes. There is no log pipeline, workspace query authentication, workspace reader grant or administrator saved search in a new direct-only deployment. |
| `true` | Containers publish raw observations through Event Hubs and the managed-identity Function/DCR bridge into `M365Synthetic_CL`. Native Log Analytics queries evaluate historical rolling aggregates over `healthModel.signalWindowMinutes`, requiring `healthModel.minimumSamples`. |

This is the only reporting-mode switch; neither mode requires a telemetry SDK or
exporter. The flag changes signal delivery, not entity IDs, business-step mappings,
dependency rollup, reporting-group membership, service schedules or provider context.
The suppressed Service Health supporting entity, when enabled, always receives
external reports independently of this flag. Neither mode creates per-target
signal inventories.

Both modes use `observed-success-percentage` and `observed-mean-duration`.
Whole journeys aggregate attempts; children aggregate only executed actions.
Success is `100 * succeeded / executed`; mean duration includes failed executed
samples. Only collected optional steps have samples. Skipped actions, token
acquisition and generic cleanup never become action samples; an unobserved action
does not become a failed or invented successful request. Insufficient samples
produce no new value. Queries deduplicate `EventId` before evaluating the window.

Direct mode aggregates the settled cycle, not a local rolling history: workers
remain stateless between cycles. Each fresh report replaces that signal's previous
reported measurement until its TTL expires. If a cycle has no samples for a step,
it publishes no placeholder; its previous report ages out. Missing or expired
reports become Unknown, not automatically Unhealthy. Native root alerts trigger
only on Degraded/Unhealthy transitions, so stopped workers or failed publication
can escape those alerts. Keep independent execution, freshness, ingestion and
notification checks; direct mode has no Log Analytics missing-data query alert.

With more than one tenant in the root config, each model receives every
overall signal as `tenant-<tenant id>--<signal>` (for example
`tenant-contoso--observed-success-percentage`), so tenants never mask one
another on the shared service model. This covers the journey and step
signals above, the `teams-call` signals below and the Service Health and
activity signals. With exactly one tenant the names stay plain, as listed here.
Group signals use `group-<id>--tenant-<tenant id>--<signal>` and are not qualified
twice. Adding a second tenant (or dropping back to one) renames every overall signal
at once: `npm run deploy` changes models and workers together, and reports under the
old direct-report names expire after their last report's lifetime.

The checked-in Degraded/Unhealthy rules are below 99%/95% success or above
15,000/60,000 ms mean duration; equality does not breach. A timed-out attempt
contributes success 0, while unexecuted dependent actions remain unobserved.
Health is evaluated on the aggregate measurements; a single failure in a large
cohort does not necessarily make the entity Unhealthy. Cleanup/credential failures
can fail the journey without inventing failed business actions.

The existing `teams-call` entity also has four call-specific signals in either mode:
`observed-call-connection-success-percentage`,
`observed-call-mean-connection-duration`,
`observed-call-disconnection-success-percentage` and
`observed-call-mean-disconnection-duration`. These measurements do not add journeys,
business-step entities or unavailable call-quality measurements.

Entity definitions use `2026-10-01-preview`. In query mode refresh is one minute,
with native Percent/Milliseconds units. The service-model identity queries the
workspace. Successful CLI queries alone do not prove model-side authorization
or notification delivery.

### External-report units and definitions

Units accompany every report in JSON `additionalContext.unit`, including Unknown
reports: `Percent`, `Milliseconds`, `Count`, or categorical `status-score`.
The ingestion request schema does not support `dataUnit`, and external signal
definitions are read-only. Native unit labels therefore cannot be written by
the reporters; query-backed signals use native units. Direct synthetic and provider
signals appear only after ingestion; the model template writes no external
signal definitions or status. Reporting-group member names may remain unresolved
until their first matching report arrives.

## User groups

Exchange and OneDrive `targets.<groupId>` entries add native `signalAggregationGroups`
to their **journey** entities only
([ARM contract](https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/2026-10-01-preview/healthmodels/entities#signalaggregationgroup),
`2026-10-01-preview`): one `reporting-<group id>` group per user group,
displayed with the group's `userGroupName` and combined `WorstOf`. They are the only
aggregation groups in the model; overall signals publish ungrouped. Each group's `members`
are its `group-<id>--tenant-<tenant>--<signal>` signal-name strings, one set per tenant
service the group has users in: `observed-success-percentage` and
`observed-mean-duration`. Teams has no user groups, including on `teams-call`.
Step and Service Health signals are never included, and no entities,
relationships or models are added. A journey receives a group only when its tenant
service and scenario are enabled and the group has a member target for it.
TypeScript derives membership from each group's `users` into the template's
service-scoped `reportingGroups` parameter. Matching group IDs within one service
combine tenant views, with consistent `userGroupName`; Exchange and OneDrive IDs
are independent. Bicep explicitly clears former Teams groups and other removed
journey groups. Old direct reports expire after their report TTL.
Group health reaches parents through the normal
dependency roll-up. Under native `WorstOf`, Unknown has the lowest severity and
`ignoreUnknown: false` does not make a missing signal override a known one, so inspect
individual signals rather than treating a known group state as proof that every member
reported. See [reporting groups](../docs/monitoring-groups.md).

## Microsoft-reported Service Health

This section applies only when root `serviceHealth.enabled` is `true`. Each service's
`execution` source switches, cadences, permissions and live/beta approvals still
apply. Microsoft documents the related advanced monitoring feature for at least
5,000 qualifying E3/E5 licenses and 50 monthly active users; confirm beta API
eligibility with Microsoft. Stable Service Health has no such minimum.

All provider reports for a product target **`${service}-service-health` itself**:

| Source | Signal |
| --- | --- |
| Stable `serviceAnnouncement.healthOverviews` | `microsoft-reported-service-status` |
| Stable `serviceAnnouncement.issues` | `microsoft-reported-issue-count` |
| Each approved beta activity function | `microsoft-activity-<activity-function>` |

With several tenants each name is published as `tenant-<tenant id>--<name>`, so the
single `${service}-service-health` entity carries one set per tenant.

The stable list collector selects exact product service names: `Exchange Online`,
`Microsoft Teams`, and `Microsoft OneDrive`. OneDrive additionally requires
overview ID `OneDriveForBusiness`; it is **not** the `SharePoint Online` service.
The collector uses the list endpoints, never an individual overview lookup;
the individual-ID endpoint returned 403 in the earlier hosted trial.
OneDrive issues are filtered by exact `Microsoft OneDrive` service name. Denied
or missing OneDrive data reports Unknown without a value; no beta permission or invented OneDrive
activity call is introduced.

The first provider cycle ingests every selected signal on the existing supporting
entity, including an explicit Unknown report when no observation is available.
Configuration alone does not make them appear. They are not
grouped, and the template writes no read-only external signal definitions. Each
report retains its source and API version in `additionalContext`, so stable status
stays distinct from beta activity.

Only approved stable status mappings are automatic: operational 100/Healthy,
degradation 50/Degraded, interruption 0/Unhealthy. Missing, denied, malformed,
unknown or stale data produces explicit Unknown without a value, not a
fallback 50. Collection failures retain diagnostics; the Unknown report replaces
the previous state and has the configured TTL. Issues report observed counts
with Unknown health. Beta functions report the latest fresh bucket;
counts/percentages remain diagnostic unless explicit customer thresholds apply.
The supporting entity itself is `impact: Suppressed` and has no provider-child
dependency group. Its reports cannot affect Experience rollup.
See [exact provider contracts](../docs/provider-monitoring.md).

When disabling an existing deployment, update the workers with the matching
configuration/image first so collection stops. Incremental ARM deployment does
not delete old entities: remove each selected service's
`<model-name>-<service>-to-<service>-service-health` relationship, then its
`<service>-service-health` entity. Do not delete the service model or its journeys.

## Shared observation queries

Only `logAnalytics.enabled: true` creates/reuses `law-<model>`, `appi-<model>`,
`M365Synthetic_CL` and the observation pipeline. Five administrator saved searches
live in [`queries/admin/`](./queries/admin/); they are deployed only in this mode.
A new direct-only deployment does not require either component.

[synthetic.kql](./queries/synthetic.kql) binds service, journey/action, tenant,
optional group and aggregate over the configured signal window. It excludes
simulation, providers and unexecuted actions and deduplicates replayed event IDs.
No data or insufficient samples returns no value, not a Healthy zero. Thresholds
remain in root configuration. Queries apply them to rolling history; direct
publishers apply the same rules to each settled cycle's aggregates.

Only in query mode do service-model identities receive workspace-scoped
Reader/query authentication.
The root identity receives scoped Reader on selected nested models for native
references. Only query-mode worker identities receive Event Hub sender access.
Private configuration-reader permissions are independent of log collection.
Direct synthetic and provider-context ingestion permissions are separate from
workspace access.
Neither permission authorizes Microsoft 365 access.

## Apply and migrate

Run `npm run deploy` from `synthetic-tests/`. It deploys these models first, from the
same root config the workers mount, then the workers; `npm run deploy -- --plan`
previews locally with no Azure changes. The command passes the template the config
plus the TypeScript-resolved `reportingGroups`, so do not apply
`health-model/infra/main.bicep` with `az deployment` directly: that would omit the
group aggregation. See [deployment](../docs/deployment.md#deploy-with-one-command).

Incremental ARM deployment does **not** delete omitted entities, relationships,
models, query bindings or worker apps. Compare paginated live inventories with
the exact selected catalog; remove only owned obsolete relationships/entities
and references after review. Never delete by a `-planned-` name prefix, and do
not use complete mode on a shared resource group. Retain all three deployed
OneDrive IDs above.

### Grouping Exchange under Mail and Calendar

1. Deploy the updated model with `npm run deploy` and the same root config. It creates
   the selected `exchange-mail`/`exchange-calendar` parents and routes the existing
   journeys through them. Journey/step IDs, direct-report destinations, observation
   queries and worker schedules are unchanged by grouping alone. The separate
   attachment/reply migration below does require updated workers.
2. Verify each new parent has its selected children and native dependency rollup.
   Then remove only the old direct relationships named
   `<root-model-name>-exchange-to-<journey-entity>` for Exchange journey IDs
   actually present before grouping (or the selected subset in the deployment).
   Incremental deployment does not remove these old shortcuts automatically.
3. Keep the service root, all retained journeys and steps, and the new
   parent-to-journey relationships. When enabled, Service Health stays directly
   under Exchange Experience and remains impact-suppressed.

### Splitting attachment delivery and reply delivery

The attachment journey retains its ID and send/verify child IDs. Provision a
retained received reply seed for each target (`npm run setup:reply-seeds` does, into `.env`)
and deploy `exchange-reply` with its two business-step children before updated
workers send reports there. After old workers stop, explicitly retire only the
attachment journey's old reply/confirm children and their relationships. See the
[ordered scenario/fixture migration](../synthetic-tests/exchange/README.md#provision-and-test-attachment-and-reply-separately).

### Single-user Exchange conversion

1. Stop all old Exchange worker revisions/jobs before changing the target inventory.
   Keep one independent `{ id, mailbox }` target for every case-insensitively unique
   former sender **and recipient**, preserving existing sender IDs and account-based
   reporting-group membership. All five journeys share one aligned minute.
2. Explicitly re-provision incompatible paired seeds with
   `npm run setup:reply-seeds -- -Reprovision`. The received self-addressed fixture
   must be in that user's own Inbox, not the old peer mailbox. The command keeps
   old retained seeds; review those artifacts separately under retention policy.
3. Deploy the matching catalogue/model and worker image from the same root config.
   Retain `exchange-global`, `exchange-draft`, `exchange-attachment`,
   `exchange-reply`, `exchange-recurring` and all their current step IDs. Mail and
   Calendar remain native rollup parents; Calendar now means own calendar only.
4. Compare paginated inventories with `serviceModelInventories`. Incremental
   deployment does not delete the removed branches below. After verifying no old
   image reports to them, review these exact owned retirement sets:

   - `exchange-distribution`, `exchange-distribution-send-group-mail`,
     `exchange-distribution-confirm-group-delivery`.
   - `exchange-meeting`, `exchange-meeting-create-meeting`,
     `exchange-meeting-confirm-invitation`,
     `exchange-meeting-verify-attendee-calendar`,
     `exchange-meeting-accept-meeting`, `exchange-meeting-confirm-acceptance`,
     `exchange-meeting-cancel-meeting`.

   Remove each journey-to-child relationship (`<parent>-to-<child>`) before its
   child entity, and `exchange-mail-to-exchange-distribution` /
   `exchange-calendar-to-exchange-meeting` before their journey entities.
   Also retire any older service-root shortcut pointing at these removed journeys.
   `deployment.retireEntities` can list the reviewed entities; deploy only with
   explicit operator approval. Do not remove Mail, Calendar, retained journeys,
   provider context or unrelated resources. This source conversion does not
   deploy or delete existing resources.

### Consolidating Service Health: ordered handoff

1. Deploy the matching model template first, with the same root config the
   workers use. Existing parent entities become the single destination of the
   combined signals; do **not** delete old children yet.
2. Deploy one immutable image containing the matching reporters and collectors
   to all selected workers, together with the matching root config.
   Retain independently scheduled 300-second provider lanes and explicit live/
   beta approvals. For OneDrive, enable stable `serviceHealth`; it inherits the
   tenant's existing federated read-only `providerClientId`. Verify that the explicitly
   selected OneDrive worker managed identity has its own federation trust.
   Existing `ServiceHealth.Read.All` is sufficient; no additional Graph
   permissions or OneDrive beta grant is needed.
3. Deactivate every old worker revision/job using the old reporter or template.
   Verify active image digests and actual ingestion to the three parent
   destinations before pruning. Otherwise old images can keep writing retired
   destinations and an old template can recreate children. Source validation alone
   does **not** verify live ingestion.
4. Compare **paginated** live inventories with deployment outputs
   `rootEntityNames`, `rootRelationshipNames`, and `serviceModelInventories`
   (each includes exact entity and relationship names). Retire only the 14
   relationships below **before** their 14 child entities. The model suffix
   identifies which service model owns each pair; retain the Service Health
   parents and their relationships only when root `serviceHealth.enabled` is true.
5. Observe at least another provider interval plus collection/publication time.
   Verify no retired IDs reappear, no reports use retired destinations, and
   enabled stable/beta signals appear on the single supporting entity. Verify
   suppression and notification/ingestion monitoring separately; HTTP 204 is
   not end-to-end alert proof.

The exact per-API retirement set (relative to
`Microsoft.CloudHealth/healthmodels/<root>-<service>`) is:

| Model suffix | Retired entity | Retired relationship |
| --- | --- | --- |
| `exchange` | `exchange-service-health-health-overviews` | `exchange-service-health-to-exchange-service-health-health-overviews` |
| `exchange` | `exchange-service-health-issues` | `exchange-service-health-to-exchange-service-health-issues` |
| `exchange` | `exchange-service-health-getConnectivityMetricsForExchange` | `exchange-service-health-to-exchange-service-health-getConnectivityMetricsForExchange` |
| `exchange` | `exchange-service-health-getMessageVolumeMetricsForEmailDelivery` | `exchange-service-health-to-exchange-service-health-getMessageVolumeMetricsForEmailDelivery` |
| `exchange` | `exchange-service-health-getActiveUserMetricsForOutlookWebByReadEmail` | `exchange-service-health-to-exchange-service-health-getActiveUserMetricsForOutlookWebByReadEmail` |
| `exchange` | `exchange-service-health-getActiveUserMetricsForOutlookWebByAppOpening` | `exchange-service-health-to-exchange-service-health-getActiveUserMetricsForOutlookWebByAppOpening` |
| `exchange` | `exchange-service-health-getActiveUserMetricsForEmailByModernAuthentication` | `exchange-service-health-to-exchange-service-health-getActiveUserMetricsForEmailByModernAuthentication` |
| `teams` | `teams-service-health-health-overviews` | `teams-service-health-to-teams-service-health-health-overviews` |
| `teams` | `teams-service-health-issues` | `teams-service-health-to-teams-service-health-issues` |
| `teams` | `teams-service-health-getUsageMetricsForTeamsByMeetingsJoined` | `teams-service-health-to-teams-service-health-getUsageMetricsForTeamsByMeetingsJoined` |
| `teams` | `teams-service-health-getUsageMetricsForTeamsByLaunch` | `teams-service-health-to-teams-service-health-getUsageMetricsForTeamsByLaunch` |
| `teams` | `teams-service-health-getMessageVolumeMetricsForTeamsChat` | `teams-service-health-to-teams-service-health-getMessageVolumeMetricsForTeamsChat` |
| `teams` | `teams-service-health-getAudioStreamQoEMetricsForTeams` | `teams-service-health-to-teams-service-health-getAudioStreamQoEMetricsForTeams` |
| `teams` | `teams-service-health-getAudioStreamsOverUdpMetricsForTeams` | `teams-service-health-to-teams-service-health-getAudioStreamsOverUdpMetricsForTeams` |

OneDrive has **no per-API child retirement**. Its stable collection uses the
existing `onedrive-service-health` entity when opted in. With all scenarios and Service Health enabled the new
desired inventory is exactly 60 entities / 56 relationships:
root references, three service roots, three supporting entities, two Exchange
parent journeys, 10 executable journeys and
38 business steps. Historical active OneDrive `-planned-` IDs are retained.

The Teams scenario key migrates to `channel-conversation`; the old misleading
key is rejected. Select only `channel-conversation`/`scheduled-meeting`, and only
the three OneDrive scenarios above. Delete removed service/scenario keys and
their execution lanes from the config. Redeploy source/models/workers
coherently; do not route reports to an undeployed replacement ID.

### Switching reporting mode

Deploy the model and matching workers from the same root configuration. On a
`true` → `false` switch, the template explicitly sends `azureLogAnalytics: null`
on every retained journey and business step, removing native query bindings
rather than relying on omission. It leaves external definitions ingestion-created
and preserves dependencies, suppression, group members and entity IDs.
Group lists are likewise cleared with null when no user-defined groups apply;
the API does not accept an empty group array.

Incremental deployment does not delete old `workspace-query` authentication
settings, workspace role assignments, saved searches or pipeline resources just
because they are now conditional. Verify numeric direct reports and group
membership through the live model first, then review and retire only owned obsolete
query access and pipeline resources. Do not remove the root identity's nested-model
Reader grants or provider ingestion access. Likewise, verify actual query evaluation
when enabling the pipeline; compilation alone cannot establish a live handoff.
The default 15-minute TTL removes expired reports; it does not guarantee an
Unhealthy state or alert. Independently monitor execution, ingestion and notifications.

## Local validation

From the repository root, with the Azure CLI's Bicep tooling available:

```sh
npm --prefix synthetic-tests run catalog:check
az bicep build --file health-model/infra/main.bicep --stdout > /dev/null
az bicep build --file health-model/infra/service.bicep --stdout > /dev/null
az bicep build --file synthetic-tests/infra/main.bicep --stdout > /dev/null
```

These commands check the generated catalogue and compile/lint the templates
without deploying resources. There are no Python template tests or unit-test
suites. After setup supplies required `.env` bindings,
`npm --prefix synthetic-tests run deploy -- --plan` validates the selected config
and prints a local plan. Neither compilation nor the plan proves Azure access,
live report ingestion, model propagation or notification delivery.
