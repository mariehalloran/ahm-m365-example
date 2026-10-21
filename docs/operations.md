# Operations and safety

## Simple execution boundary

Each service process runs its selected journeys and aggregates only that cycle's results by journey/action. It publishes success-percentage and mean-duration health reports to separate journey and business-step entities, with **External Reports** as their only signal group. **No Blob/file history or cross-cycle health state is stored**. Two journeys per product use the same three Container Apps; the full family has four models, 34 entities, 30 relationships and 18 business-step entities.

Exchange, Teams, and SharePoint use separate configs/cadences and separate Container Apps. Use the [shared hosting guide](../synthetic-tests/infra/README.md) for the no-ingress, single-revision rollout with 0.25 CPU/0.5 GiB per app, explicit managed identities and config-hash revisions.

Use the [shared worker guide](../synthetic-tests/utils/README.md) for commands and strict config fields. Each service under `synthetic-tests/` owns its entry, actions/journey, config and tests; shared code and Node tooling also live in that project. Checked-in configs use simulation: console diagnostics and report previews make no live mutations or Azure calls.

## Scheduling and shutdown

- First run is immediate; each worker follows its own fixed-rate cadence.
- Runs do not overlap within a process. Missed slots are skipped and logged, not replayed in bursts.
- Config changes require a restart.
- SIGINT/SIGTERM stop new runs, cancel current work, and allow bounded probe cleanup and report publication.
- Restarting loses transient execution/report data, not a persisted health history; none exists.
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

Live workers require scoped health-report permission on their own service model, independently of Graph/mailbox permissions; see the [model guide](../health-model/README.md). They need no user password, interactive mailbox sign-in, directory-wide permission, `ServiceHealth.Read.All`, or Blob access. Optional provider collection requires its separately approved read-only application permissions; it never grants them.

Hosted cross-tenant Graph credential loading is not implemented. The current Graph client uses public-cloud endpoints only. Do not add tenant-wide Entra Graph mail application grants: Exchange authorization is mailbox-scoped RBAC for Applications.

## Direct health reporting

The [root configuration](../monitoring.config.json) is the only source for service/scenario selection, account/target metadata, and health-report destination/policy. Service files retain independent mode/cadence/authentication/provider settings; redundant `enabled`, `targets` and obsolete `telemetry` fields are rejected, including with `--config`.

Live workers submit aggregated external health reports and retain structured console diagnostics. Live probes mutate only their approved targets. Simulation prints report previews only; it must not publish simulated cloud health.

Report success is `100 * successful executed samples / executed samples`; mean duration includes failed executed samples. Evaluate each action separately and the whole journey separately. Skipped actions have no fabricated sample and receive Unknown reports without values. Defaults are below 99%/95% success or above 15/60 seconds mean duration; these are demo thresholds, not per-action SLOs. Reports cover one complete cycle, not a rolling historical window.

The reporter uses the service identity and ARM audience, with bounded requests/retries and a 30-second batch budget. It never substitutes provider health for synthetic reports. Publication failures are explicit; startup configuration/credential validation can still prevent execution. Check `health-report-failed` and `service-cycle-failed`; one-shot reporting errors return nonzero. A 204 acknowledges ingestion, not model propagation or notification delivery.

Valid-but-incomplete live runtime setup is an observed monitoring failure, not a reason to manufacture simulated health. With usable report credentials, initialization exceptions publish an unsuccessful/unexecutable journey and keep unexecuted action signals Unknown; workers retry on their service cadence. Inspect `service-initialization-failed`, its bounded diagnostic category, and the actual stage before attributing the failure to Microsoft 365. One-shot commands still fail. Unsafe schemas and unusable report credentials can stop publication and need independent platform/freshness detection.

Incomplete/cancelled cycles log `health-report-skipped-incomplete-cycle`; they do not publish a healthy partial aggregate. Reports have a 15-minute default TTL; expiry **removes external signals**, not a guaranteed Unhealthy state or alert. Monitor last successful ingestion and actual execution independently, with detection targets shorter than the TTL and measured publication/propagation delays. Incremental deployment does not delete old bindings/resources; follow the [migration procedure](../health-model/README.md#apply-and-migrate).

Each attempt contributes one binary success observation (1 or 0); executed business actions contribute their own success/duration observations. Failed prerequisites block later actions without invented samples. Token acquisition and cleanup remain internal and unreported as steps. Cleanup still runs after mutation using an independent ten-second budget. Cleanup failure preserves earlier successful action observations but makes overall success zero.

[Shared measurement semantics](../synthetic-tests/utils/README.md#measurement-semantics) explain per-cycle aggregates and reporting gaps. Reports are not a full metrics store, percentile history, or arbitrary logs query interface; cross-cycle weighted statistics cannot be inferred from means alone. Crashes/network failures can lose observations, with no durable outbox or exactly-once guarantee. Alert configuration and notification delivery are separate from report acceptance.

## Optional Microsoft provider context

Simulation configs keep providers off; live examples enable stable Service Health, with beta still off. `serviceHealth: true` requires `ServiceHealth.Read.All` admin consent and reads v1.0 health overviews and issue/history data. Provider initialization is independent of missing journey targets/bot credentials and collection runs once per service cycle. Exact overview status reports directly to `${service}-service-health` as `microsoft-reported-service-status`: **100 healthy, 50 degraded, 0 interruption**. Failed, missing, or unknown overviews publish Unknown without a numeric value and include failure context. The existing trial observes Graph 403 pending consent. Stable Service Health has `impactSuppressed`, so it is supporting context, not journey evidence or Experience rollup.

Exchange/Teams `serviceActivity.enabled: true` additionally needs `ENABLE_BETA_SERVICE_ACTIVITY=true` and separately approved `ServiceActivity-Exchange.Read.All`/`ServiceActivity-Teams.Read.All`. Beta is experimental, unsupported for production, and **diagnostic-only: never used for Experience/journey health**. Confirm tenant eligibility/enablement; an HTTP failure is not evidence of a service outage. SharePoint beta is rejected rather than silently skipped or mapped to an OfficeApps report.

Each configured source runs once per worker cycle, independently bounded to 30 seconds and five exact-origin/version/path pages. Check `m365-provider-collection-failed` console diagnostics and `service-cycle-summary.providers.failed`; successful journeys can coexist with provider failures. Simulation records skipped sources without Graph credentials/network or fabricated Microsoft health. Issue/history and all historical beta values remain console diagnostics; no provider value enters synthetic or step measurements.

See the [strict schema, limits, diagnostics and first-party references](../synthetic-tests/utils/README.md#optional-provider-collectors). Provider issue metadata/history is tenant-sensitive approved context, not email/channel/file content; apply diagnostic retention and access controls. Do not sum overlapping report windows as request counts. There is no watermark/checkpoint or deduplication guarantee.

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

Console result/step diagnostics contain opaque configured/correlation IDs, mode, timings, and bounded diagnostics. Reports aggregate by fixed service/journey/business-step destinations, not target inventories. No raw mailbox address, message body/subject/ID, token, Graph response, or private key belongs in diagnostics or reports.

Synthetic content is fixed boilerplate or a generated correlation ID. Protect dedicated mailbox/site artifacts under their own retention rules. Normal deletion can leave Deleted Items/recycle-bin or compliance-retained copies.

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

The default is service-level monitoring, not individual-mailbox coverage. One active target can keep service reports arriving while another stops. That limitation must be accepted for this simple default; it is not solved by labeling an aggregate as complete coverage.

For higher availability, evaluate independently placed probe instances with explicit opaque identities and distinct target assignments. Zone redundancy requires a suitable environment and enough replicas to span failure domains; simply adding a replica can duplicate tests. Regional redundancy, active revisions, rollouts, and replica ownership must be designed without introducing worker health state. Do not claim that `minReplicas: 1` is high availability.

Stateless, in-memory aggregation/publication cannot preserve every result through a crash/network partition. Missing-data detection and redundant observation reduce blind spots but do not reconstruct lost samples. If a future requirement demands durable lossless delivery, it conflicts with an entirely stateless no-outbox worker and needs an explicit architecture decision.

Before operational sign-off, deliberately test process termination, an alive-but-stalled probe, bad credentials/certificate expiry, denied health-report ingestion, stale/expired reports, broken cross-model references, and a disabled/broken alert path. Measure detection, notification, recovery, duplicates, and gaps. Keep a named owner, escalation, runbook, and tested manual disablement procedure.

These platform alerts, external observers, redundant deployments, and notification tests are **requirements, not deployed functionality**. Budget them separately from the earlier single-replica compute estimate.
