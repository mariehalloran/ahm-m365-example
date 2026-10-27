# Journey and business-step health models

The [root configuration](../monitoring.config.json) selects executable journeys.
The root health model references one independent model each for Exchange, Teams
and OneDrive. The [shared catalogue](../synthetic-tests/utils/src/catalog.ts) contains only retained
journeys and their business steps; there is no optional proposal catalog or
planned-entity deployment switch.
Bicep reads its generated JSON projection; use `npm run catalog:generate` from
`synthetic-tests/` after changing metadata.

## Selected topology

Every service model contains:

- One service Experience root and its selected journeys; Exchange inserts Mail
  and Calendar parent user journeys.
- An impact-suppressed `${service}-service-health` supporting entity only when
  root `serviceHealth.enabled` is explicitly `true`.
- Business-step children for every selected journey.
- **External Reports** on each journey/business step, plus optional OTEL sources.

The supporting entity's **External Reports** group contains stable overview and
issue-count signals, plus that product's approved beta activity signals.
Exchange and Teams each have seven members; OneDrive has two stable members and
no approved beta endpoint. There are **no per-API child entities or relationships**.
Provider context never supplies synthetic samples or Experience health.

Exchange groups its existing journeys under two parents:

| Parent user journey | Child journeys |
| --- | --- |
| Mail (`exchange-mail`) | Send/receive, draft, attachment delivery, reply delivery, distribution-list delivery |
| Calendar (`exchange-calendar`) | Recurring event, meeting invitation |

These parents roll up child health with native `WorstOf` dependencies; they do
not receive synthetic reports or OTEL signals. A parent is omitted when none of
its children are selected. Teams and OneDrive retain their direct journey children.

The selected root profile and shared catalogue determine the model inventory.
Explicit root `"serviceHealth": { "enabled": true }` adds one supporting entity
and relationship per selected service and permits configured provider collection.
The default and omission are off; there are no provider calls, provider lanes or
provider reports while off.

Disabling a service or every one of its scenarios excludes its nested model and
root reference from the desired deployment. Individual scenario switches remove
that journey and its steps from the desired inventory, plus its parent when the
last selected child is removed.

### Stable journey IDs

| Service | Root scenario → journey entity |
| --- | --- |
| Exchange | `send-receive-mail` → `exchange-global`; `edit-reopen-draft` → `exchange-draft`; `attachment-mail` → `exchange-attachment`; `reply-mail` → `exchange-reply`; `distribution-list-mail` → `exchange-distribution`; `recurring-calendar` → `exchange-recurring`; `meeting-invitation` → `exchange-meeting` |
| Teams | `channel-conversation` → `teams-global`; `scheduled-meeting` → `teams-call` |
| OneDrive | `user-drive-roundtrip` → `onedrive-planned-user-drive-roundtrip`; `app-folder-lifecycle` → `onedrive-planned-app-folder-lifecycle`; `document-versions` → `onedrive-planned-document-versions` |

OneDrive's historical `-planned-` names already receive real reports and **must
not be renamed or deleted because of that substring**. Its semantic steps map to
the existing `step-1`…`step-4` child IDs. Other child IDs are
`<journey-entity>-<semantic-step>`. The optional OneDrive byte-restore step is
suppressed when no selected target enables `restoreVersion`.

Only journeys and their Mail/Calendar parents use the native `UserFlow` icon.
Authentication and generic cleanup are internal—not extra entities. Explicit draft/file deletion,
calendar cancellation and call departure remain measured business steps.

Journey guides define exact evidence and API boundaries:
[Exchange](../synthetic-tests/exchange/README.md#journeys-and-scheduling),
[Teams](../synthetic-tests/teams/README.md#journeys-and-evidence),
[OneDrive](../synthetic-tests/onedrive/README.md#journeys-and-exact-endpoints).
Graph bot readback is not a second bot's receipt, and verified meeting
connectivity is not received-audio proof.

## Health reports target signals

Each journey/business step receives `synthetic-success-percentage` and
`synthetic-mean-duration` through its **External Reports** group.
Whole journeys aggregate attempts; children aggregate only executed actions.
Success is `100 * succeeded / executed`; mean duration includes failed executed
samples. A skipped action produces Unknown without a value, never a failed or
invented successful request.

Default Degraded/Unhealthy rules are below 99%/95% success or above
15,000/60,000 ms mean duration; equality does not breach. A timed-out attempt
contributes success 0 and is Unhealthy, while unexecuted dependent actions remain
unobserved. Cleanup/credential failures can fail the journey without inventing
failed business actions.

The existing `teams-call` entity also has four immediate call-specific signals:
connection/disconnection success and duration. No audio-quality entity or
placeholder quality members are deployed by default.
Only explicitly selected keys in root `healthModel.callQualityThresholds` add
quality members to its External Reports group. Configure those keys only after
the [opt-in audio feasibility test](../synthetic-tests/teams/README.md) confirms
the corresponding metrics are actually returned for the selected bots.
Quality collection uses actual returned call-chain IDs and publishes only
observed metric values, including real zeros. Missing, denied or pending
measurements stay in diagnostics, not placeholder entity reports.
These measurements do not add journeys or business-step entities.

Live ingestion uses the
[Health Report Ingestion API](https://learn.microsoft.com/azure/azure-monitor/health-models/health-report-ingestion)
with `2026-05-01-preview`; entity definitions use `2026-10-01-preview` for grouped
signals. Reports create named external signals on **existing** entities.
A 204 acknowledges ingestion, not propagation or alert delivery. Reports replace
the prior cycle's aggregates; they are not historical metrics or percentiles.

### Direct-report units: platform limitation

Units accompany every report in JSON `additionalContext.unit`, including Unknown
reports: `Percent`, `Milliseconds`, `Count`, or categorical `status-score`.
The ingestion request schema does not support `dataUnit`, and external signal
definitions are read-only. Native unit labels therefore cannot be written by
this reporter; optional query-backed signals have native units.

## Microsoft-reported Service Health

This section applies only when root `serviceHealth.enabled` is `true`. Existing
service-file source switches, cadences, permissions and live/beta approvals still
apply. The root configuration includes a `$comment` explaining advanced monitoring's
documented 5,000 qualifying E3/E5 license / 50 monthly-active-user requirements and
the need to confirm beta API eligibility. Stable Service Health has no such minimum.

All provider reports for a product target **`${service}-service-health` itself**:

| Source | Signal |
| --- | --- |
| Stable `serviceAnnouncement.healthOverviews` | `microsoft-reported-service-status` |
| Stable `serviceAnnouncement.issues` | `microsoft-reported-issue-count` |
| Each approved beta activity function | `microsoft-activity-<activity-function>` |

The stable list collector selects exact product service names: `Exchange Online`,
`Microsoft Teams`, and `Microsoft OneDrive`. OneDrive additionally requires
overview ID `OneDriveForBusiness`; it is **not** the `SharePoint Online` service.
Use the list endpoints, not an individual overview lookup: the verified hosted
provider identity can list OneDrive while the individual-ID endpoint returns 403.
OneDrive issues are filtered by exact `Microsoft OneDrive` service name. Denied
or missing OneDrive data produces no health report; no beta permission or invented OneDrive
activity call is introduced.

Native grouping uses the `2026-10-01-preview`
[ARM `signalAggregationGroups` contract](https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/2026-10-01-preview/healthmodels/entities#signalaggregationgroup):
one `external-reports` group, display name **External Reports**, `WorstOf`, and
`members` containing **signal-name strings**, not entity names or signal
definitions. Ingestion creates external signals; the template does not write
read-only external signal definitions or invent `signalGroups.externalReports`.
Predeclared members without reports are unresolved/Unknown. Each report retains
its source and API version in `additionalContext`, so grouping does not conflate
stable status with beta activity. Under native `WorstOf`, Unknown has the lowest
severity; `ignoreUnknown: false` does not make a missing signal override a known
signal. Inspect individual signals rather than treating a known group state as
proof that every source succeeded.

Only approved stable status mappings are automatic: operational 100/Healthy,
degradation 50/Degraded, interruption 0/Unhealthy. Missing, denied, malformed,
unknown or stale data produces no report, not even an Unknown placeholder or a
fallback 50. Collection failures remain diagnostic; any previous report ages out
at its configured TTL rather than being refreshed. Issues report observed counts
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

## Optional OTEL signals

Root `otel.enabled` defaults to false. Only enabled `destination: "azure-monitor"`
with a selected journey creates Log Analytics and workspace-backed Application
Insights, plus **OpenTelemetry** query groups on journeys/business steps.
`destination: "console"` is a local export preview, not Azure infrastructure.
External Reports and topology remain intact; providers stay external-report-only.

[synthetic.kql](./queries/synthetic.kql) binds the Application Insights resource,
service, journey and action. It uses live schema-2.0 observations within 15 minutes;
skipped/internal actions, simulation and provider logs are excluded. Query
refresh is one minute; its rolling window/ingestion latency can differ from
current-cycle direct reports. No data is not a healthy fallback.

Service-model identities receive workspace-scoped Reader/query authentication.
The root identity receives scoped Reader on selected nested models for native
references. Worker identities separately receive ingest-only permissions.
Neither permission authorizes Microsoft 365 access.

## Apply and migrate

Commands run from the repository root using the **same reviewed private root**
as the workers:

```sh
az deployment group what-if --subscription '<subscription>' \
  --resource-group '<resource-group>' --template-file health-model/infra/main.bicep \
  --parameters projectConfig=@/approved/path/monitoring.private.json

az deployment group create --subscription '<subscription>' \
  --resource-group '<resource-group>' --template-file health-model/infra/main.bicep \
  --parameters projectConfig=@/approved/path/monitoring.private.json
```

Incremental ARM deployment does **not** delete omitted entities, relationships,
models, query bindings or worker apps. Compare paginated live inventories with
the exact selected catalog; remove only owned obsolete relationships/entities
and references after review. Never delete by a `-planned-` name prefix, and do
not use complete mode on a shared resource group. Retain all three deployed
OneDrive IDs above.

### Grouping Exchange under Mail and Calendar

1. Deploy the updated model with the same reviewed root configuration. It creates
   the selected `exchange-mail`/`exchange-calendar` parents and routes the existing
   journeys through them. Journey/step IDs, direct-report destinations, optional
   OTEL queries and worker schedules are unchanged by grouping alone. The separate
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
root-owned received reply fixture and deploy `exchange-reply` with its two
business-step children before updated workers send reports there. After old
workers stop, explicitly retire only the attachment journey's old reply/confirm
children and their relationships. See the [ordered scenario/fixture migration](../synthetic-tests/exchange/README.md#provision-and-test-attachment-and-reply-separately).

### Retiring Teams audio testing

The `teams-call` journey keeps its ID and five connectivity business steps.
Audio playback is no longer a prerequisite or a reported step.

1. Deploy the matching model and worker image/configuration. Remove
   `teamsCallingPlaybackEnabled`/`teamsCallingPlaybackTimeoutSeconds` and
   `TEAMS_CALLING_PLAYBACK_*` environment settings from private profiles; stop
   all old Teams worker revisions so they cannot refresh retired reports.
2. In the Teams service model, remove only the owned
   `teams-call-to-teams-call-play-audio` relationship, then the
   `teams-call-play-audio` entity. Incremental deployment does not delete them.
   Keep `teams-call` and its five retained business steps. There is no separate
   audio-quality entity.
3. The updated journey External Reports group omits
   `teams-call-playback-success-percentage`, `teams-call-mean-playback-duration`
   and unselected quality measurements. Quality members require explicitly
   configured thresholds for verified metrics; the checked-in thresholds are
   empty. Stop old workers that refresh placeholder reports, allow retired
   reports to expire at their configured TTL, and verify fresh connectivity
   reports and the evaluated rollup. Do not write read-only external signal
   definitions or assume that a source change repairs live health.

### Consolidating Service Health: ordered handoff

1. Deploy the matching model template first, with the same reviewed root profile
   used to prepare workers. Existing parent entities gain their combined signal
   group; do **not** delete old children yet.
2. Deploy one immutable image containing the matching reporters and collectors
   to all selected workers, together with the matching root/service files.
   Retain independently scheduled 300-second provider lanes and explicit live/
   beta approvals. For OneDrive, enable stable `serviceHealth` and select the
   existing federated read-only `providerClientId`; verify that the explicitly
   selected OneDrive worker managed identity has its own federation trust.
   Existing `ServiceHealth.Read.All` is sufficient; no additional Graph
   permissions or OneDrive beta grant is needed.
3. Deactivate every old worker revision/job using the old reporter or template.
   Verify active image digests and actual ingestion to the three parent
   destinations before pruning. Otherwise old images can keep writing retired
   destinations and an old template can recreate children. Source tests alone
   do **not** verify live ingestion.
4. Compare **paginated** live inventories with deployment outputs
   `rootEntityNames`, `rootRelationshipNames`, and `serviceModelInventories`
   (each includes exact entity and relationship names). Retire only the 14
   relationships below **before** their 14 child entities. The model suffix
   identifies which service model owns each pair; retain the Service Health
   parents and their relationships only when root `serviceHealth.enabled` is true.
5. Observe at least another provider interval plus collection/publication time.
   Verify no retired IDs reappear, no reports use retired destinations, and
   enabled stable/beta members resolve on the single supporting entity. Verify
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
desired inventory is exactly 70 entities / 66 relationships:
root references, three service roots, three supporting entities, two Exchange
parent journeys, 12 executable journeys and
46 business steps. Historical active OneDrive `-planned-` IDs are retained.

The Teams scenario key migrates to `channel-conversation`; the old misleading
key is rejected. Select only `channel-conversation`/`scheduled-meeting`, and only
the three OneDrive scenarios above. Delete removed service/scenario keys from
private profiles and their execution lanes. Redeploy source/models/workers
coherently; do not route reports to an undeployed replacement ID.

When disabling OTEL, explicitly retire owned stale query bindings, permissions,
settings and telemetry resources after review. A default 15-minute TTL removes
expired reports; it does not guarantee an Unhealthy state or alert.
Independently monitor execution, ingestion and notifications.

## Local validation

```sh
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s health-model/tests -v
```

Contracts compile Bicep locally and compare final catalog metadata with runtime
root selection, test types, step mappings and actual report aggregation.
Offline Bicep snapshots verify the Mail/Calendar hierarchy, selected/empty parents,
native rollup and unchanged Teams/OneDrive topology without deploying resources.
Snapshot checks require Bicep CLI 0.41.2 or later.
They reject removed service/planned branches in compiled output.
These checks prove source consistency, not live cloud acceptance.
