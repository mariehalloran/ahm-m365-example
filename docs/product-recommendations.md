# Service patterns and next steps

## Keep measurement simple

The worker performs a bounded journey, cleans up its artifacts, and aggregates this cycle's executed samples by journey/action. It sends evaluated success-percentage and mean-duration health reports directly to Azure Monitor Health Models, without storing cross-cycle history or a durable outbox. Console diagnostics remain available; there is no separate telemetry export path.

The [root configuration](../monitoring.config.json) selects services, supported journey scenarios, account/target metadata and report policy. All supported services/scenarios default to enabled, while safe simulation defaults and separate live/beta gates remain. Each service has its own config/process and independent cadence. Azure Container Apps is the intended host; separate no-ingress apps reuse one image, with explicit managed identities, single-revision mode, 0.25 CPU/0.5 GiB each and configuration-hash rollouts.

The [shared utilities guide](../synthetic-tests/utils/README.md#measurement-semantics) documents measurement semantics; each service under `synthetic-tests/` owns its worker, configuration, journey/actions and tests. Reusable helpers remain in `synthetic-tests/utils/`, and model infrastructure remains in root `health-model/`. Provider status and monitor failures remain distinguishable from actual service results. Authentication failure skips send/read steps rather than fabricating service-operation failures.

## Optional Microsoft-reported providers

Service-owned collectors reuse the existing process and Graph identity, once per service cycle independently of target/journey count or journey-initialization success. Safe simulation configs keep providers off; live examples enable stable `serviceHealth`, while beta `serviceActivity` remains off. Scoped synthetic access must not silently expand to tenant provider permissions; denied provider calls remain explicit diagnostics.

Stable health overviews and issue history need `ServiceHealth.Read.All` admin consent and remain **context-only/impact-suppressed**. Exact live v1.0 overview status reports directly to `${service}-service-health` as `microsoft-reported-service-status`: 100 healthy, 50 degraded, 0 interruption. Failed/missing/unknown overview status yields Unknown without a numeric value and with failure context. The existing trial observes Graph 403 pending consent. Issues/history never populate journey health.

Exchange's verified beta report is `getConnectivityMetricsForExchange`; Teams' is `getMessageVolumeMetricsForTeamsChat`. They need explicit `ENABLE_BETA_SERVICE_ACTIVITY=true`, service-specific approved application permissions and tenant eligibility/enablement. Beta is experimental, unsupported for production, and **diagnostic-only—never bubbles into Experience or journey health**. No verified SharePoint report exists, so enabling it is rejected rather than substituting OfficeApps. Optional/unverified functions are not exposed.

Basic tenants can run the API-backed synthetics and stable Service Health with the subscribed services/appropriate Teams SKU and approved access. Do not promise beta reports on Basic: API permission documentation does not explicitly confirm Basic entitlement. The separate [advanced Microsoft 365 monitoring feature](https://learn.microsoft.com/microsoft-365/enterprise/microsoft-365-monitoring) requires at least 5,000 qualifying Office 365/Microsoft 365 E3/E5 licenses and 50 monthly active users for a core service. That published feature threshold is not a verified beta API licensing rule; tenant report eligibility must still be checked.

Provider issue/history and beta observations remain structured console diagnostics, never synthetic/step samples. Bounded UTC historical windows overlap; do not count each repeated snapshot as new requests or derive synthetic success rates from it. Explicit source failure/no-data/truncation diagnostics accompany independent summary counts; no empty healthy fallback is used. Simulation skips provider I/O and credentials. See the [exact configuration/diagnostic contract](../synthetic-tests/utils/README.md#optional-provider-collectors). Local mocked validation proves neither live access nor tenant eligibility and grants no permission.

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

## Per-cycle reporting and its limits

- Choose success-rate denominators explicitly and show unexecutable attempts separately.
- Use the cycle's mean duration; don't mislabel it as p95 or promise historical weighted statistics from means alone.
- Independently track execution and accepted-report freshness, allowing for cadence/publication/propagation delay. No mailbox inventory is required.
- Keep simulation out of live availability calculations.
- Treat reports as current-cycle aggregates, not a full metrics store, percentile history or arbitrary logs query interface.
- Use model dependencies for rollup and keep Microsoft-reported provider context separate.
- Reuse service-owned named business actions and attribute their measurements to fixed journey/step IDs. Token acquisition and cleanup remain internal; their failures can explain the overall result without emitting standalone steps or rewriting successful business-action observations.

The [model templates](../health-model/README.md) create a root model referencing separate enabled service models. Each of six journey entities receives whole-journey reports; 18 separate business-step child entities receive action reports. **External Reports** is their only signal group. The family has four models, 34 entities and 30 relationships. Cloud rollout is independent of local validation; the isolated development model family and [shared worker deployment](../synthetic-tests/infra/README.md#verified-report-only-deployment) have been redeployed report-only with all three apps ready/running. Telemetry cleanup is verified while the original PoC model remains without queries; normal workspace deletion has a 14-day recovery window, not a permanent purge. Fresh SharePoint provider Unknown/Graph 403 reporting is verified, but all-service end-to-end verification remains in progress. Reports replace the previous cycle with a TTL; expiry removes external signals, not a guaranteed Unhealthy state or alert. Service aggregates do not identify individual missing mailboxes, and no “last healthy” state is preserved in a worker.

## Recommended sequence

1. Establish the root and selected service model topology from the reviewed root config.
2. Run one stateless simulated service locally and verify its console result/report-preview shape; never publish simulated cloud health.
3. Containerize each selected service independently in Azure Container Apps and mount root/service configs.
4. Obtain approved live resources and scoped Graph plus service-model report-ingestion permissions.
5. Verify separate journey/step reports, suppressed provider reports and root propagation, including Unknown/skipped cases and report failure/expiry.
6. Complete [obsolete telemetry removal](../health-model/README.md#apply-and-migrate), redeploy report-only workers, and independently detect execution/report gaps.
7. Validate the bot-backed Teams journey against approved resources before enabling live Teams producers or considering employee/call/media journeys.

Production acceptance still needs actual live evidence, safe cleanup, report-ingestion/failure tests, retention/cost approval, credential rotation, stopped/stalled-worker detection, and end-to-end notification tests.
