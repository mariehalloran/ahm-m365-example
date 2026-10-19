# Service patterns and product recommendation

## What this implementation demonstrates

The reusable boundary is a versioned synthetic result, not a Graph response. Exchange and SharePoint use the same generic worker and execution/reporting components, but each has its own config, process, targets, and cadence. Simulation also uses the normalized result and policy flow.

The single root npm package separates `health-model/`, `probes/exchange/`, `probes/sharepoint/`, `probes/teams/`, `runner/` and `shared/`. **The health model is deployed first.** Azure Container Apps is the intended worker host, but hosting is not implemented or deployed. Each config-driven worker executes its service handlers in-process on an independent cadence.

The hierarchy should represent customer journeys. Provider status and integration health are distinguishable from those journeys. A provider incident is informative without being proof of tenant impact; a provider-operational response cannot erase failed tenant probes.

These are design findings, not measurements from a production tenant. No supplied mailbox, site, Dan's PoC or real-user study was available.

## Teams: deliberately staged

**NOT IMPLEMENTED:** [the Teams folder](../probes/teams/README.md) contains a disabled config, not a Teams handler or simulated journey. Enabling the unsupported service fails explicitly; an empty Teams model entity must not imply healthy experience.

| Stage | Journey | Requirements / limitations |
| --- | --- | --- |
| First candidate | Read a dedicated team's metadata/channel through Graph | Approved dedicated team and app permissions; no cleanup; indicates API reachability only |
| Second candidate | Send/read/delete a uniquely correlated chat or channel message | Confirm supported application vs delegated permissions for the exact endpoint, licensing, retention, and identity; do not assume app-only chat send is generally available |
| Later | Join a meeting or establish media | Licensed test identity, supported bot/calling APIs, endpoint/media hosting, network placement, meeting policy, cleanup and recordings/privacy controls |

A metadata read must be labeled a lightweight control-plane availability proxy, not “Teams calls work.” Teams admin consent, licensing and endpoint requirements are not resolved by Azure managed identity alone. Do not ship broad message permissions or a browser-password automation script as a shortcut.

The next implementation should select one approved lightweight journey and validate permission support before adding a handler. Do not block the Exchange MVP on full call/media simulation.

## SharePoint / OneDrive pattern

Implemented handler:

1. Authenticate with the workload's approved identity.
2. Confirm the configured drive belongs to the approved site.
3. Upload a small uniquely named test file into an existing dedicated folder.
4. Read the exact correlation-only payload.
5. Delete the known item (or exact generated path after an ambiguous upload response).
6. Return the same normalized contract and bounded cleanup status.

Use a dedicated site/library, selected permissions, and a separately provisioned cohort entity. Validate retention and recycle-bin behavior. Office document rendering, browser collaboration, sync, OneDrive desktop clients and document coauthoring are **not** covered by this API-level test. Update/write verification is a later journey extension.

## Cohort policy questions for the spike

- Three configured probes are a mechanism demonstration, not statistical evidence for 99% tenant availability. Repeated use of one mailbox is not three independent user populations.
- Geography/office labels do not change execution location. Deploy separately governed runners near the actual networks before calling this regional evidence.
- Define minimum independent identities, coverage, weighting and fresh-window size using observed data.
- The current p95 is nearest-rank over one execution cycle; it is not a historical SLO percentile.
- Consecutive failures/recoveries reduce flapping but introduce detection/recovery delay. Validate each service's configured cadence against customer expectations, including skipped slots when a cycle overruns.
- Unknown must override historical health immediately. Unsupported or unavailable telemetry should never be silently treated as healthy.
- Decide whether partial regional impact degrades or makes the tenant unhealthy. Keep that dependency policy in AHM.

## Recommended product sequence

1. **Health model first.** Establish and validate the [isolated model](../health-model/README.md), its dependencies, suppressed provider context and missing-evidence behavior before deploying or integrating a runner.
2. **Curated external-synthetic contract next.** Versioned schemas, expiring evidence, correlation/drill-down references, execution diagnostics and explicitly separate provider annotations.
3. **AHM-owned cohort/temporal evaluation.** First-class coverage, freshness, minimum samples, percentile thresholds and stabilization should avoid each customer writing a second policy engine.
4. **Curated Exchange and SharePoint templates.** Guided dedicated-resource setup, permission-scoping validation, cleanup verification, cost estimates, and safe disablement.
5. **ACA runner only after model validation, tenant-consent and placement design.** Implement hosting and explicit authentication separately. A future runner may execute independent probe processes and validate normalized results; arbitrary customer code creates a substantially larger isolation, identity, network, supply-chain and operational support burden.
6. **Teams/media later.** Only after supported identity, licensing, endpoints and actual journey semantics are established.

Do not start with a Marketplace listing or claim managed M365 monitoring based solely on this PoC. After model validation, a real Exchange cohort should demonstrate provider-operational/tenant-failing evidence and verified missing-evidence behavior after the runner stops.

## Future evidence and OTel summaries

Retain structured per-email/per-probe results with opaque correlation/test/cohort identifiers, outcome, diagnostic category, send/delivery timings and cleanup status. OTel success counters and response-time histograms should complement, not replace, those results. Keep service/cohort/outcome labels low-cardinality; never use addresses, email/message/correlation IDs or per-run test IDs as metric labels.

Prefer a delivery-duration histogram in seconds from send initiation to matching Inbox observation, explicitly including send-request and polling latency. Keep send-accepted time, overall probe, authentication and cleanup measurements separate. Authentication failure means the test was unexecutable, not that mail delivery failed. Do not fabricate a delivery-duration sample for an unobserved delivery.

The runner should export metric summaries to an approved telemetry backend and **separately** evaluate evidence and submit expiring health reports to Azure Monitor Health Models. OTel is not a direct Health Models ingestion path; provider context remains separate and absent evidence is never Healthy. Process execution, OTel SDK/exporters and additional timing fields are future design only. See [full event and metric semantics](./operations.md#future-process-and-otel-boundary-not-implemented).

## What AHM should store vs reference

Store entity health, expiration, small cohort summaries, provider issue IDs and opaque correlation IDs. Keep execution details and failure stages in the telemetry store; content remains only in approved test workloads. A future portal drill-down can resolve a correlation ID to an authorized telemetry query without copying sensitive details into the health graph.

M365 consumers should consume an authorized, scoped health view of a curated customer model rather than the runner's message/document data. Required tenant consent, access boundaries and schema stability remain product-design work.
