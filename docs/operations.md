# Operations and safety

## Simple execution boundary

Each service process runs its configured test and emits raw results plus OTel measurements. It has **no Blob/file history, aggregate health policy, or health-report API client**.

OpenTelemetry runs in that **same process/container**. Deploying a separate telemetry worker, Collector, or AKS cluster is not required for the selected Application Insights export path. Exchange, Teams, and SharePoint use separate configs/cadences and are intended for separate Container Apps. Container hosting is not deployed yet.

Use the [shared worker guide](../utils/README.md) for commands and strict config fields. Each root service owns its entry, actions/journey, config, tests and queries. Checked-in configs use simulation/console mode and make no live mutations or Azure exports.

## Scheduling and shutdown

- First run is immediate; each worker follows its own fixed-rate cadence.
- Runs do not overlap within a process. Missed slots are skipped and logged, not replayed in bursts.
- Config changes require a restart.
- SIGINT/SIGTERM stop new runs, cancel current work, allow bounded probe cleanup, and flush/shut down telemetry.
- Restarting loses only transient execution/telemetry buffers, not a persisted health history; none exists.
- Run one authoritative instance per target set. Statelessness does not prevent duplicate test emails across replicas.

## Identity and permission gates

Do not enable live mode against real-user resources.

1. Obtain dedicated approved targets and an owner. Use the [mailbox administrator request](../MAILBOX-SYNTHETIC-ACCESS.md) for Exchange.
2. Scope Exchange `Application Mail.ReadWrite` and `Application Mail.Send` to only approved mailboxes using Exchange RBAC for Applications. Audit broader grants and test allowed/denied access.
3. For SharePoint, use `Sites.Selected` and an explicit write grant to the approved site. The handler verifies drive/site ownership.
4. For hosted Graph, supply explicit UUID `AZURE_CLIENT_ID` for the approved same-tenant UAMI. `graphAuthentication` defaults to `managed-identity`, using only that identity; no certificate, CLI, secret or host-identity fallback. For local live development only, opt into `certificate` and supply `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_CERTIFICATE_PATH`. Protect/ignore the private key.
5. Set the config to `mode: live` and independently opt in through `ENABLE_LIVE_M365=true`.
6. Use `--once` first and inspect operation and cleanup outcomes.

Teams also needs an already registered/installed bot and a dedicated standard channel, plus a Graph observer with team-scoped `ChannelMessage.Read.Group`. Supply separate `BOT_TENANT_ID`, `BOT_CLIENT_ID`, `BOT_CLIENT_CERTIFICATE_PATH` and expected `AZURE_TENANT_ID`; bot/observer/target tenants must match even with Graph MI. The bot stays certificate-backed; Graph MI does not authorize bot posting automatically. Use only validated installation metadata. The worker does not request migration permissions, create a bot, or bypass user sign-in policies.

Default journey-only workers need no user password, interactive mailbox sign-in, directory-wide permission, `ServiceHealth.Read.All`, health-model ingestion access, or Blob access. Optional provider collection requires its separately approved read-only application permissions; it never grants them.

The mailbox identity and telemetry destination are independent. Approve cross-tenant telemetry flow and retention; hosted cross-tenant Graph credential loading is not implemented. The current Graph client uses public-cloud endpoints only. Do not add tenant-wide Entra Graph mail application grants: Exchange authorization is mailbox-scoped RBAC for Applications.

## Export and downstream analysis

`telemetry: console` keeps output local. `telemetry: azure-monitor` uses `APPLICATIONINSIGHTS_CONNECTION_STRING` for a workspace-based Application Insights resource linked to Log Analytics. This does not change simulation/live behavior: a live probe with console output still mutates its approved target.

Each attempt exports one OTel result log, a success sample of 1 or 0, and durations. Every executed named action also exports `synthetic.step.success` (1/0) and `synthetic.step.duration` (seconds). Failed prerequisites block later actions, reported as skipped with no fabricated metric. Cleanup still runs after mutation using an independent ten-second budget. A cleanup failure preserves earlier successful step observations but makes overall success zero. No application-side sampling is applied. The SDK uses bounded memory buffers, not a persistent outbox; offline disk storage is disabled. Failed/missing exports are not service successes. Crashes/network failures can lose telemetry, with no exactly-once guarantee.

[Shared measurement semantics](../utils/README.md#measurements-and-queries) explain average success × 100, weighted mean duration and reporting gaps. Queries are service-owned: [Exchange](../exchange/queries/), [Teams](../teams/queries/), [SharePoint](../sharepoint/queries/), each with `analytics/` and `health-model/`. They never combine services, enumerate target IDs, or require raw-result joins. Filter simulation separately and keep unexecutable attempts visible.

Log Analytics does not analyze continuously just because it receives data. The model's query signals evaluate live-only data on a refresh schedule. Alert delivery is a separate configuration; a query signal alone does not notify anyone.

## Optional Microsoft provider context

Both provider switches default off in every config/template. `serviceHealth: true` requires `ServiceHealth.Read.All` and reads v1.0 health overviews and issue/history data. Exact service matching, missing-data failures and explicit truncation prevent an incomplete collection being presented as healthy. Stable ServiceHealth is **context-only and impact-suppressed**, not journey evidence.

Exchange/Teams `serviceActivity.enabled: true` additionally needs `ENABLE_BETA_SERVICE_ACTIVITY=true` and separately approved `ServiceActivity-Exchange.Read.All`/`ServiceActivity-Teams.Read.All`. Beta is experimental, unsupported for production, and **diagnostic-only: never used for Experience/journey health**. Confirm tenant eligibility/enablement; an HTTP failure is not evidence of a service outage. SharePoint beta is rejected rather than silently skipped or mapped to an OfficeApps report.

Each configured source runs once per worker cycle, independently bounded to 30 seconds and five exact-origin/version/path pages. Check `m365-provider-collection-failed` logs and `service-cycle-summary.providers.failed`; successful journeys can coexist with provider failures. Simulation records skipped sources without Graph credentials/network or fabricated Microsoft health. All historical beta values are Logger-only snapshots; no provider value enters synthetic or step measurements. `--once` flushes these logs and shuts down the same embedded SDK.

See the [strict schema, limits, exact AppTraces fields and first-party references](../utils/README.md#optional-provider-collectors). Provider issue metadata/history is tenant-sensitive approved context, not email/channel/file content; apply retention and access controls. Do not sum overlapping report windows as request counts. There is no watermark/checkpoint or deduplication guarantee.

## Timing, retries, and cleanup

- A cycle has a bounded execution budget; size target lists accordingly.
- At most three probes execute concurrently. Graph requests time out at fifteen seconds, and safe operations retry within a bounded budget.
- Configured probe timeouts cancel work. Cleanup receives its own ten-second budget.
- Draft creation/send are not retried after ambiguous responses. Reads/idempotent deletes can retry; long Retry-After requests fail explicitly rather than retry too soon.
- `durationMs` is total attempt time **through cleanup**, distinct from confirmed delivery time.
- Exchange `sendDurationMs` measures the Graph draft-send request until response/error, excluding draft creation, polling, and cleanup. Failed sends retain timing; no attempted send means no send sample.
- Exchange `deliveryDurationMs` runs from send initiation to matching Inbox observation, including send-request/polling latency, not exact transport latency.
- Teams measures Connector request time and Graph-confirmed publication time separately. Only the bot's known created activity is deleted; ambiguous sends are not retried.
- SharePoint measures upload and verified-readback phases separately. Site-drive and channel-message pagination are bounded to their exact approved collections.
- Cleanup uses only known IDs or exact unguessable correlation subjects/paths. Never purge by date, mailbox, or library.
- A delivery arriving after cleanup can leave an artifact. Agree on an ownership-checked review/retention process before scale-out.
- An ambiguous Teams creation response can leave an activity without a cleanup ID. This is reported as cleanup failure; the owner must reconcile it before repeatedly running the test.
- Cleanup failures are explicit; confirmed delivery can coexist with failed cleanup. Do not erase the delivery measurement or pretend overall success.

## Privacy, retention, and costs

Result/step logs contain opaque configured/correlation IDs, mode, timings, and bounded diagnostics. Overall/phase metrics use only service/journey/mode/outcome labels; steps add the bounded step name. No raw mailbox address, message body/subject/ID, token, Graph response, or private key belongs in either.

Synthetic content is fixed boilerplate or a generated correlation ID. Protect dedicated mailbox/site artifacts under their own retention rules. Normal deletion can leave Deleted Items/recycle-bin or compliance-retained copies.

Do not enable HTTP-body/token logging, disable TLS validation, or export business content. Approve workspace region, access, retention, and budget. One target every minute can produce approximately 43,200 result records per thirty-day month plus metric aggregates.

## Disablement and teardown

1. Stop the service process and verify no new tests run; allow cleanup/export shutdown.
2. Check service reporting gaps in Log Analytics so absent measurements are not interpreted as success.
3. Revoke only approved application permissions and credentials under the tenant owner's procedure.
4. Review/remove only confirmed synthetic artifacts, respecting retention.
5. Remove dedicated cloud resources only after owner approval. Never delete a shared resource group or unrelated workspace.

## Enterprise reliability acceptance gate

Container Apps is a reasonable default for these lightweight API tests, not an assurance that the complete monitoring system is production-ready. The small single-region proof of concept does not meet an enterprise availability commitment.

Agree on a detection target before production, for example “page when no Exchange result has been observed for five minutes.” Include execution time, ingestion delay, query evaluation, notification delivery, planned maintenance, and measured worst cases in that target. A one-minute schedule or hosting SLA does not guarantee one-minute detection.

Independent monitoring must cover:

| Failure | Required detection |
| --- | --- |
| Container crashes/restarts or has no available replica | Container Apps platform metrics/diagnostics, outside the process |
| Process hangs, stops testing, loses permission, or cannot export | Service-level last-seen and unexecutable-outcome checks, plus platform diagnostics |
| Application Insights ingestion or a Log Analytics query fails | Telemetry/query service diagnostics and an independent monitoring path |
| Alert rules are disabled, lose authorization, or notification delivery breaks | Alert-configuration monitoring and periodic end-to-end notification tests |
| Azure region or the common monitoring/identity dependency is unavailable | Separately placed observer and an agreed out-of-band notification/escalation path |

A second query in the same workspace is not independent protection against that workspace or alerting service failing. Do not rely only on Exchange email or Teams notifications while monitoring Microsoft 365; arrange an approved alternative such as a separate incident/paging channel.

The default is service-level monitoring, not individual-mailbox coverage. One active target can keep service metrics arriving while another stops. That limitation must be accepted for this simple default; it is not solved by labeling an aggregate as complete coverage.

For higher availability, evaluate independently placed probe instances with explicit opaque identities and distinct target assignments. Zone redundancy requires a suitable environment and enough replicas to span failure domains; simply adding a replica can duplicate tests. Regional redundancy, active revisions, rollouts, and replica ownership must be designed without introducing worker health state. Do not claim that `minReplicas: 1` is high availability.

Stateless, memory-buffered export intentionally cannot preserve every result through a crash/network partition. Missing-data detection and redundant observation reduce blind spots but do not reconstruct lost samples. If a future requirement demands durable lossless delivery, it conflicts with an entirely stateless no-outbox worker and needs an explicit architecture decision.

Before operational sign-off, deliberately test process termination, an alive-but-stalled probe, bad credentials/certificate expiry, blocked telemetry egress, ingestion/query failures, and a disabled/broken alert path. Measure detection, notification, recovery, duplicates, and gaps. Keep a named owner, escalation, runbook, and tested manual disablement procedure.

These platform alerts, external observers, redundant deployments, and notification tests are **requirements, not deployed functionality**. Budget them separately from the earlier single-replica compute estimate.
