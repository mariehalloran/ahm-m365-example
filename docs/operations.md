# Operations and safety

## Simple execution boundary

The coordinator Container App dispatches one Azure Function invocation per selected
journey/target case. Each execution Function reports business steps and the final
journey outcome directly. With `logAnalytics.enabled: false`, it publishes health
reports without a logging pipeline. With `true`, the Logs Ingestion API/DCR writes
observations to Log Analytics and Azure Monitor Health Models evaluates KQL.
Each service Function app has its own on-demand Flex Consumption plan; there is
no Premium or always-ready baseline. Persistent journals fence duplicate execution.
The model family has five models, 75 entities, 70 relationships and 51
business-step entities before supporting context, including Exchange's Mail and
Calendar rollup parents. Enabled Service Health adds four entities and
relationships. SharePoint contributes three journeys and 13 business steps;
configuration and administrative grants do not establish live worker acceptance.

Exchange, Teams, OneDrive and enabled SharePoint use their own `execution` settings
and separate Function apps. The coordinator stays scheduled at one replica with
0.25 CPU/0.5 GiB. See the [hosting guide](../synthetic-tests/infra/README.md) for
explicit identities, dispatch authentication and Teams callback routing.

Use the [shared worker guide](../synthetic-tests/utils/README.md) for commands and strict config fields. Each service under `synthetic-tests/` owns its entry and journeys; shared code and Node tooling also live in that project. Root [monitoring.config.json](../monitoring.config.json) and its referenced service files hold user configuration; discovered IDs live in the adjacent gitignored `.env` ([details](./deployment.md#generated-ids-in-env)). Simulation makes no live mutations or Azure calls.

## Scheduling and shutdown

- Every selected Exchange, Teams, OneDrive and SharePoint journey runs every 600 seconds on aligned ten-minute boundaries. Five Exchange journeys across 100 mailboxes produce 500 case starts every ten minutes. Local `--once` is an immediate single-cycle diagnostic. Providers retain independent schedules (60 seconds in the checked-in config).
- All live journeys have a 240-second execution deadline for the entire journey, not each step. Genuine journey deadline expiry contributes failure; worker cancellation and cleanup-only failure instead report Unknown without a numeric sample. Latency thresholds remain 15000 ms Degraded / 60000 ms Unhealthy, independently of execution deadlines. Actual Exchange Graph HTTP requests, including retries, polls and cleanup, share unchanged global/per-mailbox permits (32/two); there is no Exchange probe-count ceiling.
- Every synthetic lane bounds initialization, execution, cleanup and publication before its next slot (599 seconds with the current margin). Exchange reserves 12 seconds for cleanup settlement and 12 for publication, with an execution budget at most 275 seconds. Teams/OneDrive/SharePoint allow 12 seconds for settlement and 30 for publication, with a 252-second execution budget. Initialization and late starts cannot extend the four-minute journey deadline or overlap the next slot.
- Non-Exchange capacity validation covers every selected lane, even small Teams cohorts, and rejects budgets that cannot cover all attempts or fit the cadence. The checked-in Teams lane runs six pair/target attempts at concurrency six; each OneDrive lane runs two accounts at default concurrency three. This is bounded capacity planning, not live throughput proof.
- SharePoint has independent document, version-history and list-item lanes, each with a 240-second journey deadline, 600-second cadence, default concurrency three and 252-second cycle budget. Review real completion/cleanup before increasing targets.
- `exchange-cycle-capacity` emits expected/started/completed/timed-out/inconclusive attempts and permit waiting once per reporting group, separately from observed Exchange failures. This is not a live throughput guarantee.
- Each lane never overlaps itself. Independent lanes/targets/journeys run concurrently; dependent business steps remain sequential. Missed slots log lane/first slot/count, not catch-up bursts. Slow lanes cannot block fast-lane reporting.
- Lane observations describe only executed journeys/actions, not fabricated failed or Unknown samples for sibling lanes; provider status remains separate suppressed context.
- Config changes require a restart.
- SIGINT/SIGTERM stop new runs, cancel current work, and allow bounded probe cleanup and observation publication.
- Restarting can lose unpublished results. Direct reports remain visible until their TTL; accepted logging-mode observations follow workspace retention.
- The journal conditionally fences each case before mutation. A newer slot may replace an older unclaimed `starting` or `accepted` record; a delayed older activity then fails ownership validation. Running and ambiguous mutations stay fenced and require settlement or operator reconciliation, never blind replay.

## Identity and permission gates

Do not enable live mode against real-user resources.

1. Obtain dedicated approved targets and an owner. Use the [Exchange permissions and administrator handoff](./exchange-permissions.md).
2. Scope Exchange `Application Mail.ReadWrite`, `Application Mail.Send`, and calendar journeys' `Application Calendars.ReadWrite` to only approved participants using Exchange RBAC for Applications. Audit broader grants and test allowed/denied access. After that one-time approval, maintain the complete inventory using [Exchange mailbox-scope maintenance](./exchange-permissions.md#maintain-the-approved-mailbox-scope).
3. For OneDrive, follow [worker/provisioner permissions](./onedrive-permissions.md): use `Files.SelectedOperations.Selected` with explicit write grants on approved folders and separately approved `Files.ReadWrite.AppFolder`. Use the separate administrator [bulk setup](./onedrive-setup.md) (not part of `npm run setup:ids` or `npm run setup:reply-seeds`) to create folders/grants and save real drive/folder IDs to `.env`; runtime has no broad permission or root-discovery fallback.
4. For hosted Graph, supply explicit UUID `AZURE_CLIENT_ID` for the approved same-tenant UAMI. There is no CLI, secret or host-identity fallback. Live managed-identity runs need an Azure host with that identity attached; follow the [tenant-binding requirements](./cross-tenant-access.md).
5. Set `execution.mode: "live"` and independently opt in with `deployment.enableLiveProbes: true`; hosted workers then receive `ENABLE_LIVE_M365=true` and a local run exports it. See the [live gates](./deployment.md#live-execution-gates).
6. Use `--once` first and inspect operation and cleanup outcomes.

SharePoint requires manually prepared dedicated site/library/test-folder/list
fixtures and application `Sites.Selected` plus an administrator-approved site
`write` grant on the explicit worker UAMI. Run read-only
`npm run setup:ids -- -SharePointOnly` to launch a read-only PowerShell job as
that identity and save existing bindings, then verify all three real flows. No delegated sign-in,
certificate, secret, broad-permission fallback or automatic grants are available.
See [SharePoint permissions](./sharepoint-permissions.md). Keep it
disabled with empty targets until those approvals and resources exist.

Teams defaults to an installed managed-identity bot in a dedicated standard channel.
Supply the root `botPairs` inventory and generated per-pair client-ID bindings,
with matching hosted `BOT_TENANT_ID` and `AZURE_TENANT_ID`.
A separate same-tenant Entra application holds team-scoped
`ChannelMessage.Read.Group`; service `teamsReadbackClientId` selects it through
worker-UAMI federation. The manifest's `webApplicationInfo.id` references this
application, not the UAMI. See [Teams permissions and bot setup](./teams-permissions.md).
No runtime user MFA/cache or certificate is needed. Bot-only meeting calls require
two distinct explicit UAMIs with approved `Calls.JoinGroupCall.All` and root-owned
`{ id, meetingThreadId, organizer }` call targets (setup looks up the organizer's user ID
and both client IDs of each configured bot pair).
The organizer is owner metadata, never a participant/token identity. Success requires
both established legs, matching meeting metadata, both identities in both
rosters and both verified departures. No audio upload, playback or recording is
required, and connectivity does not prove received audio, bidirectional audio or
call quality.
The existing Teams worker attaches every `botPairs[].identity` and `peerIdentity`;
each pair exercises every selected channel and meeting. No runtime
grants or extra app/host are created.

Live workers require scoped service-model report and private configuration Blob reader
roles, independently of Graph/mailbox permissions. Direct mode uses those report
permissions for synthetic journey/action health as well as provider context.
Logs Ingestion DCR permissions are required when Log Analytics is enabled; see the
[model guide](../health-model/README.md). Default bot/mail/file journeys need no user
password or interactive sign-in. Calling's tenant-wide application permission is a
separate approved exception, not a scoped recipient grant. Optional provider collection
requires separately approved read-only application permissions; it never grants them.

The [documented managed-identity setup](./cross-tenant-access.md) requires tenant-local
bindings; generic cross-tenant synthetic federation is not implemented.
The Graph client uses public-cloud endpoints only. Do not add tenant-wide Entra
Graph mail application grants: Exchange authorization is mailbox-scoped RBAC for Applications.

## Observation publication and health evaluation

The single root `logAnalytics.enabled` toggle selects the reporting path:

- **Off:** execution Functions publish observed current-cycle results as direct
  health reports. Both success percentage and mean duration use conclusive attempts;
  worker cancellations and cleanup-only failures report Unknown without a numeric
  sample, and skipped/internal actions contribute no sample. Reports expire after
  `healthModel.signalWindowMinutes`. There is no Event Hub, ingestion Function,
  DCR ingestion or Log Analytics query dependency in this mode.
- **On:** the observation pipeline described below retains per-attempt history and
  evaluates the rolling window in KQL. `minimumSamples` applies in both modes.

The [root configuration](../monitoring.config.json) owns service/scenario selection,
account metadata, observation resources and model policy. Each service retains its
independent execution cadence, authentication and provider settings.

Execution Functions submit raw journey and executed-step observations through the
Logs Ingestion API and DCR to `M365Synthetic_CL` using their selected managed identities.
There is no Event Hub, Capture or intermediary ingestion Function. Publication
failures are explicit; simulation prints counts and does not publish cloud health.

Health Models queries the table, deduplicates `EventId`, separates journey and step
records, and applies root-configured thresholds over `signalWindowMinutes`. The
`minimumSamples` gate and no-data queries produce Unknown rather than fabricated
Healthy. Success is `100 * successful conclusive attempts / conclusive attempts`;
latency includes conclusive failed attempts but excludes worker cancellations and
cleanup-only failures. An all-Unknown cohort stays Unknown. Skipped/internal
actions emit no success/failure sample. Defaults
remain below 99%/95% success or above 15/60 seconds mean duration.

Each observation retains tenant, account, journey, step, duration, failure category,
safe error detail, run/correlation IDs and reporting-group arrays. Group membership
does not duplicate observations. Queries preserve tenant separation and user-named
journey aggregation groups; Teams and SharePoint stay ungrouped. SharePoint adds
site/library/folder/list dimensions, not a synthetic-user identity. Configured target-region labels
are separate from `ExecutionRegion` and do not establish backend placement.

Publication remains bounded to 12 seconds for Exchange and 30 seconds for other
synthetic batches. Check `observations-published`, `observation-publication-failed`
and `service-cycle-failed`. API acceptance does not prove table ingestion, model
propagation or notification delivery; deployment verifies the actual destination.

If observations stop, inspect coordinator `httpStatus` diagnostics, Function
rejection reasons, Durable queue processing, ownership journals and indexed
functions, not just host Running state. An `EACCES` error indicates unreadable package
contents. The packager normalizes archive directories to `0755`, files to `0644`
and executables to `0755`, keeping the local staging root private (`0700`).
Redeploy the repaired Function package without deleting journals or queues, then
verify fresh `ingestion_time()` values and model queries returning data. Each app
must have its own Flex plan and the same resolved Durable task hub in its runtime
and trigger-scaling configuration.

Initialization failures retain journey diagnostics when Azure publication is
usable; cancellations are Unknown, while genuine authentication/configuration
failures remain failed. Unexecuted steps are not invented. Workers retry on their
cadence. Unsafe schemas or unusable Azure publication credentials can prevent
observations and require independent platform/freshness detection.

Incomplete cycles log `service-cycle-incomplete` and still publish settled results.
There is no result outbox; a crash before Logs Ingestion acceptance can lose
unpublished observations. Durable acceptance and execution journals prevent blind
replay, but do not make reporting exactly once or lossless.

Each conclusive attempt contributes one binary success observation (1 or 0).
Worker cancellations and cleanup-only failures retain diagnostic observations
with `value: null` and `dimensions.outcome: "unknown"`, and do not enter success
or latency denominators. Console results use `outcome: "unknown"` and `success: null`;
direct Unknown reports omit `value` and evaluation rules. `minimumSamples` counts
only conclusive samples in both modes.
Executed business actions retain their own conclusive success/duration
observations; failed prerequisites block later actions without invented samples.
Token acquisition and cleanup remain internal and unreported as steps. Cleanup
still runs after mutation using an independent ten-second budget. Cleanup-only
failure makes the journey Unknown without erasing confirmed business steps; an
earlier genuine service failure remains a failed journey even if cleanup also fails.

[Shared measurement semantics](../synthetic-tests/utils/README.md#reporting-model)
apply to raw observations. Log Analytics can now calculate percentiles and weighted
cross-cycle statistics from individual attempts rather than precomputed means.
The watchdog and logging-mode freshness alert allow two configured schedule
intervals plus three watchdog check intervals: currently 1,380 seconds / 23 minutes
for synthetic lanes and five minutes for provider journal checks. Watchdog metric
alerts evaluate every minute. The complete-coverage log alert evaluates every five
minutes because Azure does not support one-minute evaluation for this query shape.
Allow another evaluation interval plus processing/notification lag.
The logging rule also detects five minutes without a watchdog completion heartbeat;
its query window uses a supported Azure alert granularity (currently 30 minutes).
The logging rule requires every configured target to have a fresh journey report,
across independent case-level run IDs. One active target cannot mask a stopped target.
The 30-minute model window/direct-report TTL provides execution and ingestion
headroom beyond the ten-minute cadence; it is not the freshness-alert target. The freshness rule shares
the workspace dependency and does not detect every workspace/region/notification outage.
That rule is retired when logging is turned off. Direct report expiry becomes
Unknown rather than guaranteed Unhealthy; independent stopped/stalled-worker and
publication-loss detection remains an operational acceptance requirement in direct mode.

Root-configured `healthModel.alertActionGroupIds` connects existing Azure Monitor
action groups to the main model's root: Degraded alerts at Sev 2 and Unhealthy at
Sev 1. Manage recipients in those groups, not in the project configuration.
See [deployment](./deployment.md#deploy-with-one-command) and
[notification checks](#enterprise-reliability-acceptance-gate). These state-change alerts do not replace independent
worker/report-freshness monitoring or prove notification delivery.

## Log Analytics for administrators

Only with `logAnalytics.enabled: true`, `npm run deploy` creates or reuses `law-<model>`, `appi-<model>` and the
`M365Synthetic_CL` Analytics table. Six saved searches in **M365 Synthetic Monitoring**
cover failures, affected users/groups, inconclusive outcomes, success rate, step latency and ingestion volume.
Their KQL is in [`health-model/queries/admin/`](../health-model/queries/admin/).
Administrators need Log Analytics Reader. Data remains pay-as-you-go, with 30-day
queryable retention; Capture retention is separately configured at root.

| Saved search | File | Output columns, live records only |
| --- | --- | --- |
| Synthetic failures by group and user | `failures-by-group.kql` | Failed journey/step observations with group, user, error, correlation and kind |
| Impacted users by group | `impacted-users-by-group.kql` | `Group`, `User`, `Failures`, `Journeys`, `Errors`, `FirstFailure`, `LastFailure`: most affected first |
| Unknown synthetic outcomes by group and user | `inconclusive-by-group.kql` | No-sample diagnostics with group, user, category, detail and correlation |
| Success rate by group and journey | `success-by-group.kql` | Deduplicated conclusive attempts, Unknown count, success percentage and latency percentiles |
| Latency and failures by journey step | `latency-by-step.kql` | Step mean, P95/max duration and failures |
| Observation ingestion volume and duplicates | `ingestion-volume.kql` | Records, unique event IDs and billed GB by service/kind |

A record without a reporting group shows `(no group)` and one without a user `(n/a)`.
The table preserves the generic envelope (`Timestamp`, `Category`, `Subject`,
`Period`, `Unit`, `Version`, `Value`) and dimensions. `Kind` distinguishes journey,
executed step and measured Teams call phase; do not combine them into one failure-rate
denominator. Always deduplicate `EventId` before health or reliability aggregation.
Worker cancellation and cleanup-only diagnostics remain queryable but are not
failed service operations. Health and administrator queries also exclude legacy
zero-valued rows with those inconclusive categories from failure rates and latency.
The following legacy attribute names correspond to the normalized columns:

| Attribute | Meaning |
| --- | --- |
| `monitoring.tenant` | `TenantAlias`: the tenant alias in the config |
| `monitoring.user` | `SyntheticUser`: the configured Exchange mailbox or OneDrive UPN; empty for Teams bots and SharePoint locations |
| `monitoring.peer` | Not populated by single-user Exchange journeys |
| `monitoring.group`, `monitoring.group_name` | `GroupIds`/`GroupNames`: aligned arrays of user-defined groups; empty for Teams and SharePoint |
| `monitoring.group_duplicate` | Not needed in the new table: one event carries all memberships |
| `probe.service`, `probe.journey`, `probe.step`, `probe.step_status`, `probe.diagnostic_category` | What ran, and how the step ended |
| `probe.detail` | Failed steps only: a short hint from the integration error, truncated to 200 characters, never message or Graph content |
| `probe.http_status`, `probe.failed_step` | Result rows only |
| `probe.correlation_id`, `probe.id`, `probe.mode`, `probe.success`, `probe.duration_ms` | Correlation, target, mode and outcome |

For SharePoint, filter `Service == "sharepoint"` and inspect
`Dimensions.siteUrl`, `Dimensions.libraryName`, `Dimensions.folderName` and
`Dimensions.listName`. `TestAccountId` is the derived location key, not a user.
Keep these approved resource URLs/names within the same private diagnostic boundary.
Ingestion and model evaluation are asynchronous. With the checked-in 30-minute
signal window, a failure can influence health until it ages out. Queries do not
silently convert missing data to Healthy. Records contain dedicated test-account
UPNs; protect workspace/archive access. Use `TenantAlias`/`M365TenantId` for the
monitored tenant; Log Analytics reserves `TenantId` for its workspace metadata.
They are API-backed observations, not proof
of employee UI, real-time message receipt or received audio.

## Optional Microsoft provider context

Simulation keeps providers off; live examples enable stable Service Health, with beta still separately gated. `serviceHealth: true` requires `ServiceHealth.Read.All` and reads v1.0 health overviews/issues. Its independent provider lane runs despite missing synthetic targets/bot credentials. Approved operational/degradation/interruption states report directly to the product's single suppressed `${service}-service-health` entity: **100 healthy, 50 degraded, 0 interruption**. Stable status, issues and approved beta signals are all reported on that one entity, ungrouped; there are no per-API child entities. OneDrive matches its distinct `OneDriveForBusiness` / `Microsoft OneDrive` entry, not SharePoint. Failed/missing/stale/unapproved states produce Unknown without a value; diagnostic counts without thresholds stay Unknown even when numeric. Supporting context never changes journey evidence or Experience rollup. See [destinations and units](./provider-monitoring.md).

Exchange/Teams `serviceActivity.enabled: true` additionally needs `ENABLE_BETA_SERVICE_ACTIVITY=true` and approved `ServiceActivity-Exchange.Read.All`/`ServiceActivity-Teams.Read.All`. Exchange supports nine functions and Teams five. Explicit customer thresholds report latest fresh buckets directly on suppressed Service Health; raw counts/QoE-coverage/UDP otherwise remain diagnostic, never automatic call quality or Experience/journey evidence. Beta remains unsupported for production; OneDrive and SharePoint have no beta collector. SharePoint's stable overview is `SharePoint` / `SharePoint Online`, distinct from OneDrive. See [provider setup and deployment approval](./provider-monitoring.md).

Each source runs per independent provider-lane cycle (`providerIntervalSeconds`, default 60), bounded to 30 seconds and five exact-origin/version/path pages. The whole provider cycle is bounded below its minute slot. Check `m365-provider-collection-failed` and `service-provider-summary.providers.failed`; successful journeys can coexist with provider failures. Missing/invalid/stale provider samples report Unknown, distinct from synthetic timeout failure/Unhealthy. Simulation skips sources without fabricated Microsoft health. No provider value enters synthetic/step measurements.

Optional `execution.serviceMessages` adds the separately approved Message Center
feed. Inspect **Data annotations** on the existing Service Health entity for new
or updated notices: one title-only Details field and a pretty JSON Description.
Quiet polls create no entries; counts and status still refresh every minute.
`service-communications-snapshot-failed` and the count signals' `annotation`
diagnostics identify publication failures. Older unresolved incidents remain in
active counts; an empty annotation interval is not proof of no ongoing incident.
Count diagnostics distinguish no unseen changes from unavailable sources. See
[timeline bounds and permissions](./provider-monitoring.md#notice-update-data-annotations).

See the [provider endpoints, diagnostics and references](./provider-monitoring.md#exact-endpoints-and-units). Provider issue metadata/history is tenant-sensitive approved context, not email/channel/file content; apply diagnostic retention and access controls. Do not sum overlapping report windows as request counts. There is no watermark/checkpoint or deduplication guarantee.

## Timing, retries, and cleanup

- A non-Exchange cycle has a bounded execution budget (`cycleTimeoutSeconds`, default 252); initialization, execution, cleanup and publication must fit its 600-second cadence, not a longer TTL.
- By default three probes execute concurrently **per lane** for Teams, OneDrive and SharePoint (`maxConcurrentProbes`, configurable 1-20); the checked-in Teams lane uses six for its six attempts. Exchange starts all selected attempts together and limits actual HTTP requests instead. Runtime Graph requests have a separate bounded request/retry budget. Administrator bulk setup uses its own request/retry budget.
- Genuine expiry of a journey's execution deadline is a failed attempt. Enclosing worker/cycle cancellation and cleanup-only failure are Unknown. Cleanup receives ten seconds and settlement twelve seconds. Late responses cannot overwrite a published result. External shutdown does not start queued work.
- Draft creation/send are not retried after ambiguous responses. Reads/idempotent deletes can retry; long Retry-After requests fail explicitly rather than retry too soon.
- `durationMs` is total attempt time **through cleanup**, distinct from confirmed delivery time.
- Exchange `sendDurationMs` measures the Graph draft-send request until response/error, excluding draft creation, polling, and cleanup. Failed sends retain timing; no attempted send means no send sample.
- Exchange `deliveryDurationMs` runs from send initiation to matching Inbox observation, including send-request/polling latency, not exact transport latency.
- Teams measures Connector request time and Graph-confirmed publication time separately. Only the bot's known created activity is deleted; ambiguous sends are not retried.
- OneDrive and SharePoint verify exact file bytes and actual prior-version content. SharePoint also verifies persisted list Title revisions. File/version/list, attendee-calendar and channel-message pagination are bounded to their exact approved collections.
- SharePoint validates pinned site/library/folder/list bindings before mutation. It deletes only the current nonce folder or Title-correlated item, never the configured roots. A definite folder-name conflict establishes no ownership; ambiguous creates are reconciled by exact nonce only.
- Cleanup uses only known IDs or exact unguessable correlation subjects/paths. Never purge by date, mailbox, or library.
- A delivery arriving after cleanup can leave an artifact. Agree on an ownership-checked review/retention process before scale-out.
- An ambiguous Teams creation response can leave an activity without a cleanup ID. This is reported as cleanup failure; the owner must reconcile it before repeatedly running the test.
- Cleanup failures are explicit; confirmed delivery can coexist with failed cleanup. Preserve the delivery evidence and report the cleanup-only journey outcome as Unknown, not success or a service failure.

## Privacy, retention, and costs

Console diagnostics contain derived target/correlation IDs, mode, timings and
bounded failure hints, never mailbox contents, credentials or full HTTP responses.
Private Log Analytics observations deliberately retain
dedicated test-account UPNs and reporting groups so administrators can identify impact.
No message bodies, file bytes, tokens or passwords belong in that pipeline. Restrict
archive/workspace access, use dedicated accounts and review retention and volume.

Synthetic content is fixed boilerplate or a generated correlation ID. Protect dedicated mailbox/channel/file artifacts under their own retention rules. Normal deletion can leave Deleted Items/recycle-bin or compliance-retained copies.

Do not enable HTTP-body/token logging, disable TLS validation, or export business content.
Health observations are unsampled and compact; no record is added for every retry,
poll or SDK operation. One journey/target every ten minutes produces about 4,320
journey observations per thirty-day month plus executed business steps.
Provider schedules are independent. Use ingestion-volume and platform billing
metrics before scaling; Azure SDK informational request logs are suppressed.

## Disablement and teardown

1. Stop the service process and verify no new tests run; allow bounded cleanup and reporting.
2. Check independent execution/report freshness so absent measurements are not interpreted as success.
3. Revoke only approved application permissions and credentials under the tenant owner's procedure.
4. Review/remove only confirmed synthetic artifacts, respecting retention.
5. Remove dedicated cloud resources only after owner approval. Never delete a shared resource group or unrelated resources.

## Enterprise reliability acceptance gate

The continuously scheduled coordinator and on-demand execution Functions do not
by themselves establish an enterprise availability commitment.

The current observation-silence target is 23 minutes per synthetic case, with
one-minute watchdog metric evaluation and five-minute complete-coverage log
evaluation, plus processing/notification lag; it does not guarantee a 23-minute page.
Include execution, ingestion, notification delivery, planned maintenance and
measured worst cases in the accepted target. A hosting SLA does not establish
end-to-end monitoring reliability.

Independent monitoring must cover:

| Failure | Required detection |
| --- | --- |
| Container crashes/restarts or has no available replica | Container Apps platform metrics/diagnostics, outside the process |
| Process hangs, stops testing, loses permission, or cannot report | Independent last execution/report-acceptance checks and platform diagnostics; do not rely on external-signal expiry alone |
| Health-report ingestion/model reference authorization fails | Sanitized publication failures, independently observed external-signal freshness and service/root propagation checks |
| Alert rules are disabled, lose authorization, or notification delivery breaks | Alert-configuration monitoring and periodic end-to-end notification tests |
| Azure region or the common monitoring/identity dependency is unavailable | Separately placed observer and an agreed out-of-band notification/escalation path |

Another check sharing the same report/model/alerting dependency is not independent protection against that dependency failing. Do not rely only on Exchange email or Teams notifications while monitoring Microsoft 365; arrange an approved alternative such as a separate incident/paging channel.

Model signals remain service/group aggregates. The independent logging-mode
freshness query checks complete target coverage, while the watchdog checks each
execution/publication journal. Optional [reporting groups](./monitoring-groups.md)
provide group views; missing model samples remain Unknown rather than fabricated
Healthy or Unhealthy.

For higher availability, evaluate independently placed probe instances with explicit opaque identities and distinct target assignments. Zone redundancy requires a suitable environment and enough replicas to span failure domains; simply adding a replica can duplicate tests. Regional redundancy, active revisions, rollouts, and replica ownership must be designed without introducing worker health state. Do not claim that `minReplicas: 1` is high availability.

Stateless, in-memory aggregation/publication cannot preserve every result through a crash/network partition. Missing-data detection and redundant observation reduce blind spots but do not reconstruct lost samples. If a future requirement demands durable lossless delivery, it conflicts with an entirely stateless no-outbox worker and needs an explicit architecture decision.

Before operational sign-off, deliberately test process termination, an alive-but-stalled probe, removed identity/federation grants, denied health-report ingestion, stale/expired reports, broken cross-model references, and a disabled/broken alert path. Measure detection, notification, recovery, duplicates, and gaps. Keep a named owner, escalation, runbook, and tested manual disablement procedure.

These platform alerts, external observers, redundant deployments, and notification tests are **requirements, not deployed functionality**. Budget them separately from the earlier single-replica compute estimate.
