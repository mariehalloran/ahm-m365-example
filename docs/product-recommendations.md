# Service patterns and next steps

## Keep measurement simple

The worker performs a bounded journey, cleans up its artifacts, and aggregates this cycle's executed samples by journey/action. It sends evaluated success-percentage and mean-duration health reports directly to Azure Monitor Health Models, without storing cross-cycle history or a durable outbox. Console diagnostics always remain available. Root-configured OTEL is optional and disabled by default; it adds in-process export without replacing direct reports.

The [root configuration](../monitoring.config.json) selects services, supported journey scenarios, account/target metadata and report policy. All supported services/scenarios default to enabled, while safe simulation defaults and separate live/beta gates remain. Each service has its own config/process and independent cadence. Separate Azure Container Apps reuse one image, explicit managed identities and configuration-hash rollouts. Only selected live Teams calls expose an authenticated HTTPS callback; other apps stay private.

The [shared utilities guide](../synthetic-tests/utils/README.md#measurement-semantics) documents measurement semantics; each service under `synthetic-tests/` owns its worker, configuration, journey/actions and tests. Reusable helpers remain in `synthetic-tests/utils/`, and model infrastructure remains in root `health-model/`. Provider status and monitor failures remain distinguishable from actual service results. Authentication failure skips send/read steps rather than fabricating service-operation failures.

## Optional Microsoft-reported providers

Service-owned collectors reuse the existing container with an independent provider lane (default 300 seconds), credential and cadence, regardless of synthetic targets/initialization. Optional `providerClientId` selects the separate federated read-only application. Safe profiles keep providers off; live examples enable stable context, with beta still separately gated. Scoped synthetic grants never silently expand to tenant provider permissions; denied calls remain explicit diagnostics/Unknown context.

Stable health overviews and issue history need `ServiceHealth.Read.All` admin consent and remain **context-only/impact-suppressed**. Exact live v1.0 overview status reports directly to `${service}-service-health` as `microsoft-reported-service-status`: 100 healthy, 50 degraded, 0 interruption. Failed/missing/unknown overview status yields Unknown without a numeric value and with failure context. The existing trial observes Graph 403 pending consent. Issues/history never populate journey health.

Exchange and Teams each support five approved beta functions in independent provider lanes inside their existing containers. They need explicit `ENABLE_BETA_SERVICE_ACTIVITY=true`, approved application permissions and actual tenant eligibility. Counts and Teams percentages remain diagnostic absent explicit customer thresholds; configured fresh-bucket reports feed only suppressed Service Health, never Experience/journey health or automatic call quality. Beta remains unsupported for production; SharePoint supports stable collection only. See [provider setup and exact contracts](./provider-monitoring.md).

Basic tenants can run the API-backed synthetics and stable Service Health with the subscribed services/appropriate Teams SKU and approved access. Do not promise beta reports on Basic: API permission documentation does not explicitly confirm Basic entitlement. The separate [advanced Microsoft 365 monitoring feature](https://learn.microsoft.com/microsoft-365/enterprise/microsoft-365-monitoring) requires at least 5,000 qualifying Office 365/Microsoft 365 E3/E5 licenses and 50 monthly active users for a core service. That published feature threshold is not a verified beta API licensing rule; tenant report eligibility must still be checked.

Provider issue/history and beta observations remain structured console diagnostics, never synthetic/step samples. Bounded UTC historical windows overlap; do not count each repeated snapshot as new requests or derive synthetic success rates from it. Explicit source failure/no-data/truncation diagnostics accompany independent summary counts; no empty healthy fallback is used. Simulation skips provider I/O and credentials. See the [exact configuration/diagnostic contract](../synthetic-tests/utils/README.md#optional-provider-collectors). Local mocked validation proves neither live access nor tenant eligibility and grants no permission.

## Teams: bot-backed channel journey

[Teams](../synthetic-tests/teams/README.md) implements bot publication/replies,
Graph correlation/author readback, optional owned-message cleanup and individual
call placement/wait/hang-up. The default bot uses a same-tenant UAMI; a separate
Entra readback application uses team-scoped RSC and worker-UAMI federation.
These journeys have [recorded live acceptance](./deployment.md#deployment-status-and-order);
validate every new deployment's resources, grants and actual reports independently.

| Candidate | Requirements / limitations |
| --- | --- |
| Read approved team/channel metadata | Lightweight API reachability only, not messaging/calls |
| Implemented post/reply/readback | Separate Connector/Graph identities, exact correlation and expected author, optional bot-owned cleanup; not human-to-human receipt |
| Implemented individual calls | Approved `Calls.Initiate.All`, root-selected users, authenticated callback and verified termination; not recipient answer or media proof |
| Future meeting/answered-call/media journeys | Additional supported APIs/permissions, answering/media implementation, appropriate hosting, privacy and cleanup; see the [capability catalog](./m365-automation-capabilities.md) |

Do not block initial Exchange work on a full media synthetic or bypass controls with password/browser automation.

## Exchange and SharePoint

Exchange creates a correlated draft, sends to the dedicated mailbox, confirms Inbox delivery, and cleans up known copies. Record delivery duration separately from total duration; neither proves Outlook rendering or external delivery.

The recorded hosted Exchange acceptance used the same-tenant UAMI with mailbox-scoped Exchange RBAC for Applications; do not add tenant-wide Entra Graph mail application grants. Explicit certificate-backed Graph access now supports a different M365 tenant without changing Azure managed-identity health reporting. This new cross-tenant path still needs live acceptance; see the [administrator setup and credential migration guide](./cross-tenant-access.md).

SharePoint verifies the approved site/drive with bounded pagination, uploads a uniquely named synthetic file, downloads/verifies its content, and deletes only its own artifact. Upload/readback phases have separate timings. This does not test coauthoring, document rendering, desktop sync, or every user population.

Use scoped permissions and dedicated resources. One mailbox/site tests an integration, not tenant-wide availability. Labels do not change the execution location; regional claims require actually placed runners.

## Per-cycle reporting and its limits

- Choose success-rate denominators explicitly and show unexecutable attempts separately.
- Use the cycle's mean duration; don't mislabel it as p95 or promise historical weighted statistics from means alone.
- Independently track execution and accepted-report freshness, allowing for cadence/publication/propagation delay. No mailbox inventory is required.
- Keep simulation out of live availability calculations.
- Treat reports as current-cycle aggregates, not a full metrics store, percentile history or arbitrary logs query interface.
- Use model dependencies for rollup and keep Microsoft-reported provider context separate.
- Reuse service-owned named business actions and attribute their measurements to fixed journey/step IDs. Token acquisition and cleanup remain internal; their failures can explain the overall result without emitting standalone steps or rewriting successful business-action observations.

The [model templates](../health-model/README.md) create four models, 61 entities and
57 relationships with all services/scenarios selected. Eleven journeys receive
whole-journey reports; 40 business-step children receive action reports.
**External Reports** always remains; Azure OTEL optionally adds **OpenTelemetry**.
Reports replace the previous cycle with a TTL; expiry removes signals, not a
guaranteed Unhealthy state or alert. Aggregates do not identify individual missing
mailboxes, and workers preserve no last-healthy state or durable outbox.

## Recommended sequence

1. Establish the root and selected service model topology from the reviewed root config.
2. Run one stateless simulated service locally and verify its console result/report-preview shape; never publish simulated cloud health.
3. Containerize each selected service independently in Azure Container Apps and mount root/service configs.
4. Obtain approved live resources and scoped Graph plus service-model report-ingestion permissions.
5. Verify separate journey/step reports, suppressed provider reports and root propagation, including Unknown/skipped cases and report failure/expiry.
6. Choose report-only or optional Azure OTEL using the same root profile; review [telemetry migration](../health-model/README.md#apply-and-migrate), verify the selected export/query path if enabled, and independently detect execution/report gaps.
7. Validate selected Teams messaging and placement/hang-up journeys before recurrence; treat employee UI, answered calls and media as separate future coverage.

Production acceptance still needs actual live evidence, safe cleanup, report-ingestion/failure tests, retention/cost approval, credential rotation, stopped/stalled-worker detection, and end-to-end notification tests.
