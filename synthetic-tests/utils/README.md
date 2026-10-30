# Shared utilities and stateless service execution

The root configuration selects journeys/targets and report policy. Each service
entry supplies its real handlers; shared code owns strict contracts, HTTP/auth,
execution lanes, measurements, generic observations and optional provider diagnostics.
Only journey metadata is imported by shared contracts, not service execution.
No durable outbox, aggregation history, user-token cache or state service exists.

## Run

From `synthetic-tests/`:

```sh
npm run exchange -- --once
npm run teams -- --once
npm run onedrive -- --once
```

Each entry reads the repository-root `monitoring.config.json` (`--config <file>`
reads another file) and the `.env` beside it, whose looked-up and generated IDs fill the
matching fields ([generated IDs](../../docs/deployment.md#generated-ids-in-env)),
and runs the selected tenant's service. Pass `--tenant <id>`
when the config has several tenants; it is optional only when there is exactly one.
Every unique target of that tenant's service runs; Exchange/OneDrive
[user groups](../../docs/monitoring-groups.md) add group-named journey signals and
need no flag. Teams stays ungrouped. `--once` settles selected
synthetic/provider lanes, not proof of successful service operations. Other service
types are rejected. `npm run deploy` (`utils/src/deploy.ts`) is the single deployment
command; see [deployment](../../docs/deployment.md#deploy-with-one-command).

## Config

`project-config.ts` reads the single root document. `bindings.ts` fills in the `.env`
IDs, then `references.ts` (`expandReferences`) expands resource names to resource IDs and
applies the defaults ([names and defaults](../../docs/deployment.md#what-the-config-holds)).
The expanded document is what deploy mounts into workers, and expanding it again changes
nothing. `.env` supplies generated bindings, not generic process environment
variables; local live/beta approvals and credential variables must still be exported.
Exchange/OneDrive `targets` are keyed `{ userGroupName, users }` groups.
`selectTenant` flattens and deduplicates their users once for the runtime while
retaining service-local group membership; Teams target arrays are unchanged.
Root `healthModel` holds report policy and optional
[action-group alert references](../../health-model/README.md#root-health-alerts).
Each `tenants[].services.<service>.execution` block is then validated with `service-config.ts`:

| `execution` field | Contract |
| --- | --- |
| `mode` / `scenario` | `simulation` or explicitly gated `live`; optional deterministic simulation scenario |
| `intervalSeconds` / `timeoutSeconds` | Other services: 1–86,400 second cadence and 1–120 second execution budget. Exchange: one 60-second lane, fixed live per-journey 15-second execution deadline (30 for SELF-REPLY) |
| `maxConcurrentProbes` | Other products: 1-20 concurrent attempts per lane, default 3; not an Exchange journey cap |
| `maxConcurrentRequests` / `maxConcurrentRequestsPerMailbox` | Exchange actual Graph-request permits, defaults 32 global / 2 per mailbox, covering retries, polls and cleanup; queued waits share the journey deadline |
| `cycleTimeoutSeconds` | Other products: 1-86,400 second execution budget, default 170. Exchange bounds execution/settlement, reports and flush inside its aligned minute |
| `executionLanes` | Optional complete array of unique `{ name, intervalSeconds, timeoutSeconds, journeys }` assignments; scenario switches still own selection |
| `cohort` | Opaque result grouping label, not health policy |
| `graphAuthentication` | Explicit UAMI by default; `certificate` uses separate `M365_*` credentials |
| `healthReportAuthentication` | Independent UAMI by default; explicit local certificate uses `AZURE_*` |
| `teamsAuthentication` / `botAuthentication` | Only `bot` / `managed-identity`; obsolete user/certificate participant modes are rejected |
| `teamsReadbackClientId` | Teams Graph readback application using worker-UAMI federation; requires managed-identity Graph |
| `providerClientId` | Optional per-service override of the tenant's `providerClientId`, inherited by enabled health/messages/activity sources; not a synthetic identity override |
| `exchangeCleanupEnabled` | Default true; false retains mail artifacts for diagnostics; deliberate draft and private-series deletion remain mandatory |
| `teamsCleanupEnabled` | Default true; false retains owned channel posts/replies, never calls |
| `teamsCallingCallbackUrl` / `teamsCallingPort` | Public HTTPS exact `/api/calls`, written to `.env` by `npm run setup:ids`; default port 8080 |
| `teamsCallingAnswerTimeoutSeconds` | Default 20, bounded 1–30; execution budget must allow this plus five seconds |
| `serviceHealth` / `providerIntervalSeconds` | Optional stable collection, default off; existing independent provider lane, default 60 seconds |
| `serviceMessages` | Default-off Message Center collection through the same provider identity/lane; requires separately approved `ServiceMessage.Read.All` |
| `serviceActivity` | Separately gated beta collection: all nine Exchange or five Teams methods by default, with optional function selection and explicit customer thresholds |

`enabled`, `targets`, report settings and obsolete `telemetry` fields are
rejected inside `execution`. Selection, scenario keys and target fields are
strict; removed workloads/modes cannot reappear via compatibility defaults.
Scenario switches derive from the shared catalogue, and typed execution settings pass
directly into runtime validation without serializing probe inventories or numeric
settings through environment variables. Beside `execution`, each service block has
`access` (nonsecret certificate references), `worker` (Container App name, identity
and size), Teams `botPairs` (distinct bot/identity and peerBot/peerIdentity per pair)
and, for OneDrive, `setup`. All pairs exercise every selected Teams target;
generated client IDs select per-pair clients without extra workers.
See [architecture and reporting diagrams](../../docs/architecture.md).
The scheduled meeting is connectivity-only with five measured business steps and
needs no audio upload, playback or recording.
OneDrive stable collection matches its distinct `OneDriveForBusiness` /
`Microsoft OneDrive` entry, never SharePoint. It rejects beta activity settings.

`utils/src/catalog.ts` is the authoritative service, journey, business-step and
provider catalogue. Runtime contracts derive from it; Bicep reads its generated
`utils/src/catalog.json` projection. After changing metadata, run
`npm run catalog:generate` from `synthetic-tests/`. Typechecking, builds and
`npm run deploy` reject stale projections.

The checked-in configuration uses one aligned-minute Exchange lane for all five
single-user journeys, one Teams lane for both journeys, and three explicit
OneDrive lanes. Without `executionLanes`, non-Exchange services use one lane for all
their journeys at the service's cadence/deadline. Other products and
providers start immediately; Exchange continuous execution starts at the next
wall-clock minute boundary (`--once` is immediate). A lane never overlaps itself; independent
lanes run concurrently. Missed slots are logged/skipped without catch-up bursts.
Configuration changes require restart. SIGINT/SIGTERM stop scheduling, cancel
work and permit bounded cleanup/publication. One authoritative instance per
target set avoids duplicate traffic; statelessness is not a distributed lock.

## Credentials and report publication

Hosted Graph/reporting explicitly selects `ManagedIdentityCredential({clientId})`
using `AZURE_CLIENT_ID`. Teams Connector explicitly selects each configured
pair's primary client ID with matching `BOT_TENANT_ID`/`AZURE_TENANT_ID`.
Meeting access additionally selects that pair's peer client ID; no CLI, secret, certificate or guessed
identity fallback exists for bot participants.

Readback/provider application federation uses `api://AzureADTokenExchange`.
Only the selected application receives exchanged Graph tokens; other identity
paths remain independent. Exchange's approved explicit certificate Graph mode
uses `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_CERTIFICATE_PATH`.
`providerClientId`, including an inherited tenant value, requires managed-identity
Graph authentication and cannot be combined with certificate mode.
Reporting uses the ARM audience and separately approved ingestion permission.

`ENABLE_LIVE_M365=true` is required independently of live mode.
Beta service activity requires `ENABLE_BETA_SERVICE_ACTIVITY=true` separately,
including explicitly beta-enabled simulation. Hosted workers receive them from
`deployment.enableLiveProbes` and `deployment.enableBetaServiceActivity`; local
runs export them. Tokens do not imply permission.
See [access setup](../../docs/cross-tenant-access.md).

## Measurement semantics

Each schema-2.0 attempt contributes success **1 or 0** and total elapsed time.
Executed actions contribute their own binary success/duration; skipped actions
have no duration/sample. Internal authentication/generic cleanup are filtered
from published business steps, but their failures can fail a journey.
Deliberate draft/file and private-series deletion, and call departure, are
business actions. Timed-out attempts contribute failure rather than becoming
Unknown; aggregate thresholds determine the resulting entity health.

`measureStep` records a bounded observation and rethrows the failure.
Dependent actions are skipped; owned cleanup gets an independent ten-second
signal. Runner settlement grace is twelve seconds. Other products default to a
170-second cycle and three concurrent attempts per lane. Exchange starts all
selected mailbox/journey attempts concurrently and limits actual requests instead;
at most 42 seconds of execution/settlement, 12 seconds of reports and 5 seconds
of flush fit inside a minute. Per-reporting-group `exchange-minute-capacity`
diagnostics expose expected/started/completed/timed-out attempts and request-permit
waiting separately from Exchange availability. Live OneDrive configurations must budget for all selected accounts,
and the signal window must cover the configured cycle plus cadence/publication.
See [bulk setup and sizing](../../docs/onedrive-setup.md).
Exchange send/confirmed-delivery and Teams send/confirmed-publication durations
remain distinct from total journey time.

Each complete lane cycle publishes only its observed journeys. An incomplete
cycle skips observation publication and emits `observations-skipped-incomplete-cycle`
rather than presenting a partial cohort as complete. Every journey/action
contributes success and duration measurements. Reports use the fixed
`observed-success-percentage` / `observed-mean-duration` signals;
with more than one tenant in the config each is named `tenant-<tenant id>--<signal>`
(group signals: `group-<id>--tenant-<tenant id>--<signal>`).
OneDrive maps semantic actions to deployed `step-1`…`step-4` IDs; its historical
`onedrive-planned-*` names are retained, not proposal nodes. There are no
per-target signal inventories. Skipped actions contribute no sample.

Valid-but-incomplete live setup produces unsuccessful/unexecutable journey
evidence when reporting credentials are usable. Unsafe schemas/reporting
credentials can prevent publication and require independent freshness checks.
Reporting uses bounded retries: the synthetic Exchange batch has 12 seconds,
other batches 30. With Log Analytics off, the container publishes aggregated health
reports directly. When enabled, the Function forwards raw observations through the
DCR Logs Ingestion API. Acceptance is not evaluated rollup or notification delivery.
Queries deduplicate event IDs and preserve no-data Unknown. Direct reports expire
after their TTL; expiry is not guaranteed Unhealthy or an alert.

## Optional provider collectors

Providers run independently of synthetic initialization in the same service
containers. Root `serviceHealth.enabled` must be true before health, messages or beta
source switches take effect. Stable observations for all three services and approved
Exchange/Teams beta observations report directly to each product's single impact-suppressed
Service Health entity. OneDrive has no beta collector. Provider failures,
counts and thresholds cannot change synthetic success or Experience rollup.
One rejected source cannot erase sibling observations.
The same reporting stage publishes minute-by-minute Data annotations on the
existing Service Health entity: bounded recent source changes, explicit quiet
snapshots or source unavailability. Full active counts are independent of the
90-second update window. Annotation history provides bounded duplicate
suppression, not a durable cursor or exactly-once guarantee.
Every enabled selected beta source creates `microsoft-activity-<function>` external signals on that
existing entity through ingestion; Bicep does not predeclare them or add activity
nodes. Without explicit thresholds, numeric activity measurements have `Unknown`
health. Missing, denied, stale or invalid data produces explicit Unknown without
a numeric value; the enabled signal remains visible with diagnostic context.
See [permissions, exact endpoints and bounded contracts](../../docs/provider-monitoring.md).

## Reporting modes and reliability

Console diagnostics always include labeled mode, opaque test/correlation IDs,
bounded category, optional value-free failure hints, executed/skipped actions and
durations; never target addresses, message bodies, credentials or raw HTTP failures.
`logAnalytics.enabled` is the only reporting-mode toggle. Off sends aggregated
journey/action health reports directly from each container, with no logging pipeline.
On uses the shared [publisher](./src/observation-publisher.ts) and
[generic contract](./src/observations.ts), optional Capture, and the
[Function](../ingestion/src/index.ts), which preserves invalid/exhausted records
in private quarantine and submits valid batches to DCR ingestion. Only this enabled
mode retains mailbox/UPN and reporting-group arrays in observations; Teams stays ungrouped. See
[Log Analytics for administrators](../../docs/operations.md#log-analytics-for-administrators).
Provider diagnostics remain console output; provider supporting reports are direct
and suppressed in either mode. No additional exporter or instrumentation switch exists.

No in-memory cycle can survive every crash/network partition. There is no
exactly-once or lossless-delivery guarantee. Independently verify stopped/stalled
workers, fresh accepted reports, model propagation and notifications; do not rely
on the worker to detect its own loss. The log-based freshness alert exists only
when Log Analytics is enabled and shares that workspace dependency. Direct mode
does not provide this independent watchdog. See
[enterprise acceptance](../../docs/operations.md#enterprise-reliability-acceptance-gate).
