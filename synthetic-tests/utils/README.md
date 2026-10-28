# Shared utilities and stateless service execution

The root configuration selects journeys/targets and report policy. Each service
entry supplies its real handlers; shared code owns strict contracts, HTTP/auth,
execution lanes, measurements, direct reports and optional in-process OTEL.
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
Every target of that tenant's service runs; [reporting groups](../../docs/monitoring-groups.md)
only add group-named journey signals and need no flag. `--once` settles selected
synthetic/provider lanes, not proof of successful service operations. Other service
types are rejected. `npm run deploy` (`utils/src/deploy.ts`) is the single deployment
command; see [deployment](../../docs/deployment.md#deploy-with-one-command).

## Config

`project-config.ts` reads the single root document. `bindings.ts` fills in the `.env`
IDs, then `references.ts` (`expandReferences`) expands resource names to resource IDs and
applies the defaults ([names and defaults](../../docs/deployment.md#what-the-config-holds)).
The expanded document is what deploy mounts into workers, and expanding it again changes
nothing. Each `tenants[].services.<service>.execution` block is then validated with
`service-config.ts`:

| `execution` field | Contract |
| --- | --- |
| `mode` / `scenario` | `simulation` or explicitly gated `live`; optional deterministic simulation scenario |
| `intervalSeconds` / `timeoutSeconds` | Other services: 1–86,400 second cadence and 1–120 second execution budget. Exchange: one 60-second lane, fixed per-journey 15-second execution deadline (30 for SELF-REPLY) |
| `maxConcurrentProbes` | Other products: 1-20 concurrent attempts per lane, default 3; not an Exchange journey cap |
| `maxConcurrentRequests` / `maxConcurrentRequestsPerMailbox` | Exchange actual Graph-request permits, defaults 32 global / 2 per mailbox, covering retries, polls and cleanup; queued waits share the journey deadline |
| `cycleTimeoutSeconds` | Other products: 1-86,400 second execution budget, default 170. Exchange bounds execution/settlement, reports and flush inside its aligned minute |
| `executionLanes` | Optional complete array of unique `{ name, intervalSeconds, timeoutSeconds, journeys }` assignments; scenario switches still own selection |
| `cohort` | Opaque result grouping label, not health policy |
| `graphAuthentication` | Explicit UAMI by default; `certificate` uses separate `M365_*` credentials |
| `healthReportAuthentication` | Independent UAMI by default; explicit local certificate uses `AZURE_*` |
| `teamsAuthentication` / `botAuthentication` | Only `bot` / `managed-identity`; obsolete user/certificate participant modes are rejected |
| `teamsReadbackClientId` | Teams Graph readback application using worker-UAMI federation; requires managed-identity Graph |
| `providerClientId` | Optional per-service override of the tenant's `providerClientId`, the independently federated provider application that every service with `serviceHealth` or `serviceActivity` inherits; not a synthetic identity override |
| `exchangeCleanupEnabled` | Default true; false retains mail artifacts for diagnostics; deliberate draft and private-series deletion remain mandatory |
| `teamsCleanupEnabled` | Default true; false retains owned channel posts/replies, never calls |
| `teamsCallingCallbackUrl` / `teamsCallingPort` | Public HTTPS exact `/api/calls`, written to `.env` by `npm run setup`; default port 8080 |
| `teamsCallingAnswerTimeoutSeconds` | Default 20, bounded 1–30; execution budget must allow this plus five seconds |
| `serviceHealth` / `providerIntervalSeconds` | Optional stable collection for each service, simulation default off / independent 300-second lane |
| `serviceActivity` | Optional separately gated five-function Exchange/Teams beta collection and explicit customer thresholds |

`enabled`, `targets`, report settings and obsolete `telemetry` fields are
rejected inside `execution`. Selection, scenario keys and target fields are
strict; removed workloads/modes cannot reappear via compatibility defaults.
Scenario switches derive from the shared catalogue, and typed execution settings pass
directly into runtime validation without serializing probe inventories or numeric
settings through environment variables. Beside `execution`, each service block has
`access` (nonsecret certificate references and, for Teams, bot, peer bot and peer
identity names), `worker` (Container App name, identity and size) and, for OneDrive, `setup`.
The scheduled meeting is connectivity-only with five measured business steps and
needs no audio upload, playback or recording.
OneDrive stable collection matches its distinct `OneDriveForBusiness` /
`Microsoft OneDrive` entry, never SharePoint. It rejects beta activity settings.

`utils/src/catalog.ts` is the authoritative service, journey, business-step and
provider catalogue. Runtime contracts derive from it; Bicep reads its generated
`utils/src/catalog.json` projection. After changing metadata, run
`npm run catalog:generate` from `synthetic-tests/`. Typechecking, builds and
`npm run deploy` reject stale projections.

Default lanes are one aligned-minute Exchange lane for all five single-user journeys,
one Teams lane for both journeys, and three OneDrive lanes. Other products and
providers start immediately; Exchange continuous execution starts at the next
wall-clock minute boundary (`--once` is immediate). A lane never overlaps itself; independent
lanes run concurrently. Missed slots are logged/skipped without catch-up bursts.
Configuration changes require restart. SIGINT/SIGTERM stop scheduling, cancel
work and permit bounded cleanup/publication. One authoritative instance per
target set avoids duplicate traffic; statelessness is not a distributed lock.

## Credentials and report publication

Hosted Graph/reporting explicitly selects `ManagedIdentityCredential({clientId})`
using `AZURE_CLIENT_ID`. Teams Connector explicitly selects `BOT_CLIENT_ID`
with matching `BOT_TENANT_ID`/`AZURE_TENANT_ID`. Meeting access additionally
selects `TEAMS_CALLING_PEER_CLIENT_ID`; no CLI, secret, certificate or guessed
identity fallback exists for bot participants.

Readback/provider application federation uses `api://AzureADTokenExchange`.
Only the selected application receives exchanged Graph tokens; other identity
paths remain independent. Exchange's approved explicit certificate Graph mode
uses `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_CERTIFICATE_PATH`.
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
Deliberate draft/file deletion, calendar cancellation and call departure are
business actions. Timed-out attempts fail rather than becoming Unknown.

`measureStep` records a bounded observation and rethrows the failure.
Dependent actions are skipped; owned cleanup gets an independent ten-second
signal. Runner settlement grace is twelve seconds. Other products default to a
170-second cycle and three concurrent attempts per lane. Exchange starts all
selected mailbox/journey attempts concurrently and limits actual requests instead;
at most 42 seconds of execution/settlement, 12 seconds of reports and 5 seconds
of flush fit inside a minute. Per-reporting-group `exchange-minute-capacity`
diagnostics expose expected/started/completed/timed-out attempts and request-permit
waiting separately from Exchange availability. Live OneDrive configurations must budget for all selected accounts,
and report TTL must cover the configured cycle plus cadence/publication.
See [bulk setup and sizing](../../docs/onedrive-setup.md).
Exchange send/confirmed-delivery and Teams send/confirmed-publication durations
remain distinct from total journey time.

Each settled lane publishes only its observed journeys. Every journey/action
uses the fixed `synthetic-success-percentage` / `synthetic-mean-duration` signals;
with more than one tenant in the config each is named `tenant-<tenant id>--<signal>`
(group signals: `group-<id>--tenant-<tenant id>--<signal>`).
OneDrive maps semantic actions to deployed `step-1`…`step-4` IDs; its historical
`onedrive-planned-*` names are retained, not proposal nodes. There are no
per-target signal inventories. Skipped actions receive Unknown without a value.

Valid-but-incomplete live setup produces unsuccessful/unexecutable journey
evidence when reporting credentials are usable. Unsafe schemas/reporting
credentials can prevent publication and require independent freshness checks.
Publication uses bounded retries and a five-second request budget; the synthetic
Exchange batch has 12 seconds, other batches 30. A 204 is ingestion acceptance, not evaluated rollup or notification.
TTL expiry removes signals; it is not a guaranteed Unhealthy alert.

## Optional provider collectors

Providers run independently of synthetic initialization in the same service
containers. Stable observations for all three services and approved Exchange/Teams
beta observations report directly to each product's single impact-suppressed
Service Health entity. OneDrive has no beta collector. Provider failures,
counts and thresholds cannot change synthetic success or Experience rollup.
One rejected source cannot erase sibling observations.
See [permissions, exact endpoints and bounded contracts](../../docs/provider-monitoring.md).

## Console, OTEL and reliability

Console diagnostics always include labeled mode, opaque test/correlation IDs,
bounded category, executed/skipped actions and durations; never target addresses,
message bodies, credentials or raw HTTP failures. Direct reports always accompany
live result publication. Root OTEL is optional, disabled by default and runs in
the same process, with live-only model queries when Azure export is selected.
Its step and result records additionally carry the test accounts and reporting group
(`monitoring.user`, `monitoring.peer`, `monitoring.group`, `monitoring.group_name`)
for the administrator searches; see
[Log Analytics for administrators](../../docs/operations.md#log-analytics-for-administrators).
Azure export uses Microsoft's OpenTelemetry exporters directly, retaining
observable export callbacks and bounded flush/shutdown. The distribution would
hide these failures behind its own processors. No automatic instrumentation,
live metrics or additional standard metrics are enabled.

No in-memory cycle can survive every crash/network partition. There is no
exactly-once or lossless-delivery guarantee. Independently verify stopped/stalled
workers, fresh accepted reports, model propagation and notifications; do not rely
on the worker to detect its own loss. See
[enterprise acceptance](../../docs/operations.md#enterprise-reliability-acceptance-gate).
