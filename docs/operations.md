# Operations and safety

## Simple execution boundary

Each service process runs its selected journeys and aggregates only the settled lane cycle's results by journey/action. It publishes success-percentage and mean-duration health reports through **External Reports**, independently of optional OTEL. **No journey history, cross-cycle health state or user-token cache is stored.** Twelve journeys reuse three Container Apps (one per enabled tenant and service); the default family has four models, 67 entities, 63 relationships and 46 business-step entities, including Exchange's Mail and Calendar rollup parents. Enabling Service Health adds three entities and relationships.

Exchange, Teams, and OneDrive use separate cadences (each service's `execution` settings) and separate Container Apps. Use the [shared hosting guide](../synthetic-tests/infra/README.md) for single-revision rollout with 0.25 CPU/0.5 GiB per app, explicit managed identities and config-hash revisions. Only selected live Teams calls expose an authenticated HTTPS callback; other workers remain private.

Use the [shared worker guide](../synthetic-tests/utils/README.md) for commands and strict config fields. Each service under `synthetic-tests/` owns its entry, actions/journey and tests; shared code and Node tooling also live in that project, while the single root [monitoring.config.json](../monitoring.config.json) holds all configuration. The checked-in config uses simulation: console diagnostics and report previews make no live mutations or Azure calls.

## Scheduling and shutdown

- First run is immediate; reusable independent lanes follow fixed-rate cadence within each worker. Exchange mail defaults to 60 seconds and other Exchange journeys to 300 seconds.
- Live Exchange attempts have a hard 15-second execution ceiling, including custom lanes. Timeouts report Unhealthy; bounded cleanup can finish afterward and elapsed durations are not clamped. Other services retain their configured deadlines.
- Each lane never overlaps itself. Independent lanes/targets/journeys run concurrently; dependent business steps remain sequential. Missed slots log lane/first slot/count, not catch-up bursts. Slow lanes cannot block fast-lane reporting.
- Lane reports update only observed journeys, not empty/Unknown reports for sibling lanes; provider status remains separate suppressed context.
- Config changes require a restart.
- SIGINT/SIGTERM stop new runs, cancel current work, and allow bounded probe cleanup and report publication.
- Restarting loses transient execution/report data, not a persisted health history; none exists.
- Run one authoritative instance per target set. Statelessness does not prevent duplicate test emails across replicas.

## Identity and permission gates

Do not enable live mode against real-user resources.

1. Obtain dedicated approved targets and an owner. Use the [mailbox administrator request](../MAILBOX-SYNTHETIC-ACCESS.md) for Exchange.
2. Scope Exchange `Application Mail.ReadWrite`, `Application Mail.Send`, and calendar journeys' `Application Calendars.ReadWrite` to only approved participants using Exchange RBAC for Applications. Audit broader grants and test allowed/denied access.
3. For OneDrive, use `Files.SelectedOperations.Selected` with explicit write grants on approved folders and separately approved `Files.ReadWrite.AppFolder`. Use the separate administrator [bulk setup](./onedrive-setup.md) to create folders/grants and save real drive/folder IDs; runtime has no broad permission or root-discovery fallback.
4. For hosted Graph, supply explicit UUID `AZURE_CLIENT_ID` for the approved same-tenant UAMI. There is no certificate, CLI, secret or host-identity fallback. Explicit Graph `certificate` mode uses `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_CERTIFICATE_PATH`; local certificate-backed health reports independently use `AZURE_*`. Protect/ignore private keys.
5. Set `execution.mode: "live"` and independently opt in with `deployment.enableLiveProbes: true`; hosted workers then receive `ENABLE_LIVE_M365=true` and a local run exports it. See the [live gates](./deployment.md#live-execution-gates).
6. Use `--once` first and inspect operation and cleanup outcomes.

Teams defaults to an installed managed-identity bot in a dedicated standard channel.
Supply `BOT_TENANT_ID`/`BOT_CLIENT_ID` for the bot UAMI and matching
`AZURE_TENANT_ID`. A separate same-tenant Entra application holds team-scoped
`ChannelMessage.Read.Group`; service `teamsReadbackClientId` selects it through
worker-UAMI federation. The manifest's `webApplicationInfo.id` references this
application, not the UAMI. See [bot setup](../synthetic-tests/teams/README.md#primary-setup-unattended-bot).
No runtime user MFA/cache or certificate is needed. Bot-only meeting calls require
two distinct explicit UAMIs with approved `Calls.JoinGroupCall.All` and root-owned
`{ id, tenantId, meetingThreadId, organizerUserId, peerBotClientId }` targets.
The organizer is owner metadata, never a participant/token identity. Success requires
both established legs, matching meeting metadata, both identities in both
rosters and both verified departures. No audio upload, playback or recording is
required, and connectivity does not prove received audio, bidirectional audio or
call quality.
The existing Teams app attaches the approved peer through
`tenants[].services.teams.access.{botPeerClientId,botPeerManagedIdentityResourceId}`; no runtime
grants or extra app/host are created.

Live workers require scoped health-report permission on their own service model, independently of Graph/mailbox permissions; see the [model guide](../health-model/README.md). Default bot/mail/file journeys need no user password, interactive sign-in or Blob access. Calling's tenant-wide application permission is a separate approved exception, not a scoped recipient grant. Optional provider collection requires separately approved read-only application permissions; it never grants them.

Explicit certificate-backed cross-tenant Graph is supported; generic cross-tenant
managed-identity federation is not. The Teams readback federation above is same-tenant.
The Graph client uses public-cloud endpoints only. Do not add tenant-wide Entra
Graph mail application grants: Exchange authorization is mailbox-scoped RBAC for Applications.

## Direct health reporting

The [root configuration](../monitoring.config.json) is the only source for service/scenario selection, account/target metadata, health-report destination/policy and each service's independent mode/cadence/authentication/provider settings (`execution`); redundant `enabled`, `targets` and obsolete `telemetry` fields are rejected inside `execution`.

Live workers submit aggregated external health reports and retain structured console diagnostics. Live probes mutate only their approved targets. Simulation prints report previews only; it must not publish simulated cloud health.

Report success is `100 * successful executed samples / executed samples`; mean duration includes failed executed samples. Evaluate each action separately and the whole journey separately. Skipped actions have no fabricated sample and receive Unknown reports without values. Defaults are below 99%/95% success or above 15/60 seconds mean duration; these are demo thresholds, not per-action SLOs. Reports cover one complete cycle, not a rolling historical window.

With more than one tenant in the config, each tenant's worker publishes every overall signal as `tenant-<tenant id>--<signal>` (one tenant keeps the plain names; group signals are `group-<id>--tenant-<tenant id>--<signal>`), so tenants share a service model without overwriting each other. Adding a second tenant renames every overall signal at once: deploy models and workers together with `npm run deploy`, point freshness and report checks at the new names, and expect reports under the old names to expire after the report TTL.

The reporter uses the service identity and ARM audience, with bounded requests/retries and a 30-second batch budget. It never substitutes provider health for synthetic reports. Publication failures are explicit; startup configuration/credential validation can still prevent execution. Check `health-report-failed` and `service-cycle-failed`; one-shot reporting errors return nonzero. A 204 acknowledges ingestion, not model propagation or notification delivery.

Valid-but-incomplete live runtime setup is an observed monitoring failure, not a reason to manufacture simulated health. With usable report credentials, initialization exceptions publish an unsuccessful/unexecutable journey and keep unexecuted action signals Unknown; workers retry on their service cadence. Inspect `service-initialization-failed`, its bounded diagnostic category, and the actual stage before attributing the failure to Microsoft 365. One-shot commands still fail. Unsafe schemas and unusable report credentials can stop publication and need independent platform/freshness detection.

Incomplete/cancelled cycles log `health-report-skipped-incomplete-cycle`; they do not publish a healthy partial aggregate. Reports have a 15-minute default TTL; expiry **removes external signals**, not a guaranteed Unhealthy state or alert. Monitor last successful ingestion and actual execution independently, with detection targets shorter than the TTL and measured publication/propagation delays. Incremental deployment does not delete old bindings/resources; follow the [migration procedure](../health-model/README.md#apply-and-migrate).

Each attempt contributes one binary success observation (1 or 0); executed business actions contribute their own success/duration observations. Failed prerequisites block later actions without invented samples. Token acquisition and cleanup remain internal and unreported as steps. Cleanup still runs after mutation using an independent ten-second budget. Cleanup failure preserves earlier successful action observations but makes overall success zero.

[Shared measurement semantics](../synthetic-tests/utils/README.md#measurement-semantics) explain per-cycle aggregates and reporting gaps. Reports are not a full metrics store, percentile history, or arbitrary logs query interface; cross-cycle weighted statistics cannot be inferred from means alone. Crashes/network failures can lose observations, with no durable outbox or exactly-once guarantee. Alert configuration and notification delivery are separate from report acceptance.

## Optional OpenTelemetry

OTEL is disabled by default and configured only at root. If enabled, monitor `telemetry-initialization-failed`, `telemetry-output-failed` and `telemetry-export-failed` separately from journey and direct-report failures. Export flush/shutdown are bounded; failures still allow direct report attempts and make one-shot execution fail. An OTEL diagnostic-recording error does not rewrite an observed provider status as a Graph collection failure. No disk buffer/outbox or replay is added. Azure ingestion acceptance is not proof of query evaluation or model propagation. Verify both paths end to end, approve ingestion authentication and retention/cost, and retain independent stopped/stalled-worker and notification tests. See [optional export semantics](../synthetic-tests/utils/README.md#console-otel-and-reliability).

## Optional Microsoft provider context

Simulation keeps providers off; live examples enable stable Service Health, with beta still separately gated. `serviceHealth: true` requires `ServiceHealth.Read.All` and reads v1.0 health overviews/issues. Its independent provider lane runs despite missing synthetic targets/bot credentials. Approved operational/degradation/interruption states report directly to the product's single suppressed `${service}-service-health` entity: **100 healthy, 50 degraded, 0 interruption**. Stable status, issues and approved beta members share its native External Reports group; there are no per-API child entities. OneDrive matches its distinct `OneDriveForBusiness` / `Microsoft OneDrive` entry, not SharePoint. Failed/missing/stale/unapproved states produce Unknown without a value; diagnostic counts without thresholds stay Unknown even when numeric. Supporting context never changes journey evidence or Experience rollup. See [destinations and units](./provider-monitoring.md).

Exchange/Teams `serviceActivity.enabled: true` additionally needs `ENABLE_BETA_SERVICE_ACTIVITY=true` and approved `ServiceActivity-Exchange.Read.All`/`ServiceActivity-Teams.Read.All`. Each supports five functions. Explicit customer thresholds report latest fresh buckets directly on suppressed Service Health; raw counts/QoE-coverage/UDP otherwise remain diagnostic, never automatic call quality or Experience/journey evidence. Beta remains unsupported for production; OneDrive has no beta collector. See [provider setup and deployment approval](./provider-monitoring.md).

Each source runs per independent provider-lane cycle (`providerIntervalSeconds`, default 300), bounded to 30 seconds and five exact-origin/version/path pages. Check `m365-provider-collection-failed` and `service-provider-summary.providers.failed`; successful journeys can coexist with provider failures. Missing/invalid/stale provider samples report Unknown, distinct from synthetic timeout failure/Unhealthy. Simulation skips sources without fabricated Microsoft health. No provider value enters synthetic/step measurements.

See the [strict schema, limits, diagnostics and first-party references](../synthetic-tests/utils/README.md#optional-provider-collectors). Provider issue metadata/history is tenant-sensitive approved context, not email/channel/file content; apply diagnostic retention and access controls. Do not sum overlapping report windows as request counts. There is no watermark/checkpoint or deduplication guarantee.

## Timing, retries, and cleanup

- A cycle has a bounded execution budget (`cycleTimeoutSeconds`, default 170); size target lists and report TTL accordingly.
- By default three probes execute concurrently **per lane** (`maxConcurrentProbes`, configurable 1-20; default Exchange has two lanes). Runtime Graph requests time out at fifteen seconds, and safe operations retry within a bounded budget. Administrator bulk setup uses a separate bounded request/retry budget.
- Configured probe timeouts cancel work and count as failure/0/Unhealthy. Cleanup receives ten seconds and settlement twelve seconds. Late responses cannot overwrite a published result. An internal cycle deadline yields failure results for queued attempts; external shutdown does not start queued work.
- Draft creation/send are not retried after ambiguous responses. Reads/idempotent deletes can retry; long Retry-After requests fail explicitly rather than retry too soon.
- `durationMs` is total attempt time **through cleanup**, distinct from confirmed delivery time.
- Exchange `sendDurationMs` measures the Graph draft-send request until response/error, excluding draft creation, polling, and cleanup. Failed sends retain timing; no attempted send means no send sample.
- Exchange `deliveryDurationMs` runs from send initiation to matching Inbox observation, including send-request/polling latency, not exact transport latency.
- Teams measures Connector request time and Graph-confirmed publication time separately. Only the bot's known created activity is deleted; ambiguous sends are not retried.
- OneDrive verifies file bytes and actual prior-version content. File/version, attendee-calendar and channel-message pagination are bounded to their exact approved collections.
- Cleanup uses only known IDs or exact unguessable correlation subjects/paths. Never purge by date, mailbox, or library.
- A delivery arriving after cleanup can leave an artifact. Agree on an ownership-checked review/retention process before scale-out.
- An ambiguous Teams creation response can leave an activity without a cleanup ID. This is reported as cleanup failure; the owner must reconcile it before repeatedly running the test.
- Cleanup failures are explicit; confirmed delivery can coexist with failed cleanup. Do not erase the delivery measurement or pretend overall success.

## Privacy, retention, and costs

Console result/step diagnostics contain opaque configured/correlation IDs, mode, timings, and bounded diagnostics. Reports aggregate by fixed service/journey/business-step destinations, not target inventories. No raw mailbox address, message body/subject/ID, token, Graph response, or private key belongs in diagnostics or reports.

Synthetic content is fixed boilerplate or a generated correlation ID. Protect dedicated mailbox/channel/file artifacts under their own retention rules. Normal deletion can leave Deleted Items/recycle-bin or compliance-retained copies.

Do not enable HTTP-body/token logging, disable TLS validation, or export business content. Approve console access, any external diagnostic retention, and budget. One target every minute can produce approximately 43,200 console result records per thirty-day month plus health reports; the worker does not persist them.

## Disablement and teardown

1. Stop the service process and verify no new tests run; allow bounded cleanup and reporting.
2. Check independent execution/report freshness so absent measurements are not interpreted as success.
3. Revoke only approved application permissions and credentials under the tenant owner's procedure.
4. Review/remove only confirmed synthetic artifacts, respecting retention.
5. Remove dedicated cloud resources only after owner approval. Never delete a shared resource group or unrelated resources.

## Enterprise reliability acceptance gate

Container Apps is a reasonable default for these lightweight API tests, not an assurance that the complete monitoring system is production-ready. The small single-region proof of concept does not meet an enterprise availability commitment.

Agree on a detection target before production, for example “page when no Exchange result has been observed for five minutes.” Include execution time, report acceptance/model propagation, notification delivery, planned maintenance, and measured worst cases in that target. A one-minute schedule or hosting SLA does not guarantee one-minute detection.

Independent monitoring must cover:

| Failure | Required detection |
| --- | --- |
| Container crashes/restarts or has no available replica | Container Apps platform metrics/diagnostics, outside the process |
| Process hangs, stops testing, loses permission, or cannot report | Independent last execution/report-acceptance checks and platform diagnostics; do not rely on external-signal expiry alone |
| Health-report ingestion/model reference authorization fails | Sanitized publication failures, independently observed external-signal freshness and service/root propagation checks |
| Alert rules are disabled, lose authorization, or notification delivery breaks | Alert-configuration monitoring and periodic end-to-end notification tests |
| Azure region or the common monitoring/identity dependency is unavailable | Separately placed observer and an agreed out-of-band notification/escalation path |

Another check sharing the same report/model/alerting dependency is not independent protection against that dependency failing. Do not rely only on Exchange email or Teams notifications while monitoring Microsoft 365; arrange an approved alternative such as a separate incident/paging channel.

The default is service-level monitoring, not individual-mailbox coverage. One active target can keep service reports arriving while another stops. That limitation must be accepted for this simple default; it is not solved by labeling an aggregate as complete coverage. Optional [reporting groups](./monitoring-groups.md) give per-group views, but a group with no fresh reports reads Unknown rather than Unhealthy, so the independent freshness checks above still apply.

For higher availability, evaluate independently placed probe instances with explicit opaque identities and distinct target assignments. Zone redundancy requires a suitable environment and enough replicas to span failure domains; simply adding a replica can duplicate tests. Regional redundancy, active revisions, rollouts, and replica ownership must be designed without introducing worker health state. Do not claim that `minReplicas: 1` is high availability.

Stateless, in-memory aggregation/publication cannot preserve every result through a crash/network partition. Missing-data detection and redundant observation reduce blind spots but do not reconstruct lost samples. If a future requirement demands durable lossless delivery, it conflicts with an entirely stateless no-outbox worker and needs an explicit architecture decision.

Before operational sign-off, deliberately test process termination, an alive-but-stalled probe, bad credentials/certificate expiry, denied health-report ingestion, stale/expired reports, broken cross-model references, and a disabled/broken alert path. Measure detection, notification, recovery, duplicates, and gaps. Keep a named owner, escalation, runbook, and tested manual disablement procedure.

These platform alerts, external observers, redundant deployments, and notification tests are **requirements, not deployed functionality**. Budget them separately from the earlier single-replica compute estimate.
