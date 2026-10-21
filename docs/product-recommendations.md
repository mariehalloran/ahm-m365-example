# Service patterns and next steps

## Keep measurement simple

The worker performs a bounded journey, cleans up its artifacts, and aggregates this cycle's executed samples by journey/action. It sends evaluated success-percentage and mean-duration health reports directly to Azure Monitor Health Models, without storing cross-cycle history. OTEL/Log Analytics is optional historical evidence, not a prerequisite for reporting.

The [root configuration](../monitoring.config.json) selects services, supported journey scenarios, account/target metadata, OTEL and report policy. All supported services/scenarios and OTEL default to enabled, while safe simulation/console defaults and separate live/beta gates remain. Each service has its own config/process and independent cadence, with an optional embedded OTel SDK. Azure Container Apps is the intended host; separate Container Apps reuse the same program. There is no separate telemetry worker or Kubernetes requirement.

The [shared utilities guide](../synthetic-tests/utils/README.md#measurements-and-queries) documents measurement semantics; each service under `synthetic-tests/` owns its worker, configuration, journey/actions, tests and `queries/analytics` plus `queries/health-model`. Reusable helpers remain in `synthetic-tests/utils/`, and model infrastructure remains in root `health-model/`. No generic runner or separate telemetry source component is needed. Provider status and monitor failures remain distinguishable from actual service results. Authentication failure skips send/read steps rather than fabricating service-operation failures.

## Optional Microsoft-reported providers

Service-owned collectors now reuse the existing process, Graph identity and embedded SDK, once per service cycle independently of target count. Stable `serviceHealth` and beta `serviceActivity` both default off; scoped synthetic access must not silently expand to tenant provider permissions.

Stable health overviews and issue history need `ServiceHealth.Read.All` and remain **context-only/impact-suppressed**. Only fresh exact live v1.0 overview records can supply the separate context signal; issues/history never populate journey health.

Exchange's verified beta report is `getConnectivityMetricsForExchange`; Teams' is `getMessageVolumeMetricsForTeamsChat`. They need explicit `ENABLE_BETA_SERVICE_ACTIVITY=true`, service-specific approved application permissions and tenant eligibility/enablement. Beta is experimental, unsupported for production, and **diagnostic-only—never bubbles into Experience or journey health**. No verified SharePoint report exists, so enabling it is rejected rather than substituting OfficeApps. Optional/unverified functions are not exposed.

Basic tenants can run the API-backed synthetics and stable Service Health with the subscribed services/appropriate Teams SKU and approved access. Do not promise beta reports on Basic: API permission documentation does not explicitly confirm Basic entitlement. The separate [advanced Microsoft 365 monitoring feature](https://learn.microsoft.com/microsoft-365/enterprise/microsoft-365-monitoring) requires at least 5,000 qualifying Office 365/Microsoft 365 E3/E5 licenses and 50 monthly active users for a core service. That published feature threshold is not a verified beta API licensing rule; tenant report eligibility must still be checked.

When OTEL is enabled for Azure, provider observations use ordinary Logger-only AppTraces, not synthetic/step metrics; with OTEL off they remain structured console diagnostics. Bounded UTC historical windows overlap; do not count each repeated snapshot as new requests or derive synthetic success rates from it. Explicit source failure/no-data/truncation diagnostics accompany independent summary counts; no empty healthy fallback is used. Simulation skips provider I/O and credentials. See the [exact configuration/diagnostic contract](../synthetic-tests/utils/README.md#optional-provider-collectors). Local mocked validation proves neither live access nor tenant eligibility and grants no permission.

## Teams: bot-backed channel journey

[Teams](../synthetic-tests/teams/README.md) implements bot channel publication, Graph correlation/author readback, and deletion of the bot's own activity. HTTP-level tests assume approved access. Real resources, bot installation/metadata, credentials, and live validation are still required. Graph defaults to an explicitly selected same-tenant UAMI; Bot Connector remains independently certificate-backed.

| Candidate | Requirements / limitations |
| --- | --- |
| Read approved team/channel metadata | Lightweight API reachability only, not messaging/calls |
| Implemented bot post/readback/delete | Separate Connector and Graph identities, exact correlation and expected author, only bot-owned cleanup; not human-to-human receipt |
| Meeting/call/media | Supported calling APIs, licensed identity, endpoint/network placement, privacy, and cleanup |

Do not block initial Exchange work on a full media synthetic or bypass controls with password/browser automation.

## Exchange and SharePoint

Exchange creates a correlated draft, sends to the dedicated mailbox, confirms Inbox delivery, and cleans up known copies. Record delivery duration separately from total duration; neither proves Outlook rendering or external delivery.

The confirmed hosted Exchange path uses the same-tenant UAMI with mailbox-scoped Exchange RBAC for Applications; do not add tenant-wide Entra Graph mail application grants. Certificate Graph credentials are explicit local-live opt-in, not a hosted fallback.

SharePoint verifies the approved site/drive with bounded pagination, uploads a uniquely named synthetic file, downloads/verifies its content, and deletes only its own artifact. Upload/readback phases have separate timings. This does not test coauthoring, document rendering, desktop sync, or every user population.

Use scoped permissions and dedicated resources. One mailbox/site tests an integration, not tenant-wide availability. Labels do not change the execution location; regional claims require actually placed runners.

## Per-cycle reporting and optional historical evaluation

- Choose success-rate denominators explicitly and show unexecutable attempts separately.
- Use weighted mean duration for the simple metric path; don't mislabel it as p95.
- Independently track execution and accepted-report freshness, allowing for cadence/publication/propagation delay; optionally also monitor OTEL reporting gaps. No mailbox inventory is required.
- Keep simulation out of live availability calculations.
- Configure query-based model signals only after validating actual ingested tables and query results.
- Use model dependencies for rollup and keep Microsoft-reported provider context separate.
- Reuse service-owned named actions and attribute executed step 1/0/duration measurements to the fixed journey/step IDs. A cleanup failure changes only its own step and the overall attempt, not earlier successful action observations.

The [model templates](../health-model/README.md) create a root model referencing separate enabled service models. User Journey/action entities receive direct external reports; enabling root OTEL adds corresponding query signals on those same entities. Cloud rollout is independent of local validation; the isolated development model family and [shared worker deployment](../synthetic-tests/infra/README.md) are intended to verify real failure reporting before successful Microsoft 365 access is available. Reports replace the previous cycle with a TTL; expiry removes external signals rather than necessarily overriding remaining query evidence. Service aggregates do not identify individual missing mailboxes, and no “last healthy” state is preserved in a worker.

## Recommended sequence

1. Establish the root and selected service model topology from the reviewed root config.
2. Run one stateless simulated service locally and verify its result/metric shape.
3. Containerize each selected service independently in Azure Container Apps and mount root/service configs.
4. Obtain approved live resources and scoped Graph plus service-model report-ingestion permissions.
5. Verify direct reports and root propagation **with OTEL disabled**, including Unknown/skipped cases and report failure/expiry.
6. Optionally enable Application Insights/Log Analytics and same-entity queries; independently detect execution/report gaps either way.
7. Validate the bot-backed Teams journey against approved resources before enabling live Teams producers or considering employee/call/media journeys.

Production acceptance still needs actual live evidence, safe cleanup, ingestion/failure tests, retention/cost approval, credential rotation, and monitoring of stopped workers.
