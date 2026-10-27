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

Each entry reads `../monitoring.config.json`, or `--project-config <file>`,
then the selected `configFile` relative to that root profile.
`--config <file>` overrides only service execution settings, relative to the
working directory. `--once` settles selected synthetic/provider lanes, not proof
of successful service operations. Other service types are rejected.

## Config

`project-config.ts` combines root-owned selection/targets/policy with the
service-owned fields validated in `service-config.ts`:

| Service field | Contract |
| --- | --- |
| `type` | `exchange`, `teams`, `onedrive` |
| `mode` / `scenario` | `simulation` or explicitly gated `live`; optional deterministic simulation scenario |
| `intervalSeconds` / `timeoutSeconds` | 1–86,400 second cadence; 1–120 second execution budget |
| `maxConcurrentProbes` | 1-20 concurrent attempts **per lane**, default 3 |
| `cycleTimeoutSeconds` | 1-86,400 second total lane execution budget, default 170; queued attempts share it |
| `executionLanes` | Optional complete array of unique `{ name, intervalSeconds, timeoutSeconds, journeys }` assignments; root switches still own selection |
| `cohort` | Opaque result grouping label, not health policy |
| `graphAuthentication` | Explicit UAMI by default; `certificate` uses separate `M365_*` credentials |
| `healthReportAuthentication` | Independent UAMI by default; explicit local certificate uses `AZURE_*` |
| `teamsAuthentication` / `botAuthentication` | Only `bot` / `managed-identity`; obsolete user/certificate participant modes are rejected |
| `teamsReadbackClientId` | Teams Graph readback application using worker-UAMI federation; requires managed-identity Graph |
| `providerClientId` | Optional independently federated provider application; not a synthetic identity override |
| `exchangeCleanupEnabled` | Default true; false retains mail/drafts, but calendar cancellation/deletion remain mandatory |
| `teamsCleanupEnabled` | Default true; false retains owned channel posts/replies, never calls |
| `teamsCallingCallbackUrl` / `teamsCallingPort` | Public HTTPS exact `/api/calls`; default port 8080 |
| `teamsCallingAnswerTimeoutSeconds` | Default 20, bounded 1–30; execution budget must allow this plus five seconds |
| `teamsCallQuality` | Teams-only optional bounded known-ID call-record collection; disabled by default, separate permission approval |
| `serviceHealth` / `providerIntervalSeconds` | Optional stable collection for each service, simulation default off / independent 300-second lane |
| `serviceActivity` | Optional separately gated five-function Exchange/Teams beta collection and explicit customer thresholds |

Root `enabled`, `targets`, report settings and obsolete `telemetry` fields are
rejected in service files. Root selection, scenario keys and target fields are
strict; removed workloads/modes cannot reappear via compatibility defaults.
Root and service files share target schemas. Scenario switches derive from the
shared catalogue, and typed service settings pass directly into runtime validation
without serializing probe inventories or numeric settings through environment variables.
Remove retired `teamsCallingPlaybackEnabled`/`teamsCallingPlaybackTimeoutSeconds`
and `TEAMS_CALLING_PLAYBACK_*` settings; scheduled meetings test connectivity
without audio upload, playback or recording.
OneDrive stable collection matches its distinct `OneDriveForBusiness` /
`Microsoft OneDrive` entry, never SharePoint. It rejects beta activity settings.

`utils/src/catalog.ts` is the authoritative service, journey, business-step and
provider catalogue. Runtime contracts derive from it; Bicep reads its generated
`utils/src/catalog.json` projection. After changing metadata, run
`npm run catalog:generate` from `synthetic-tests/`. Typechecking, builds and
deployment preparation reject stale projections.

Default lanes are Exchange mail/extended, one Teams lane for both journeys, and three
OneDrive lanes. Each starts immediately and never overlaps itself; independent
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
including explicitly beta-enabled simulation. Tokens do not imply permission.
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
signal. Runner settlement grace is twelve seconds. Defaults are a 170-second cycle
budget and at most three concurrent attempts per lane; the service file can
increase both. Live OneDrive configurations must budget for all selected accounts,
and report TTL must cover the configured cycle plus cadence/publication.
See [bulk setup and sizing](../../docs/onedrive-setup.md).
Exchange send/confirmed-delivery and Teams send/confirmed-publication durations
remain distinct from total journey time.

Each settled lane publishes only its observed journeys. Every journey/action
uses fixed `synthetic-success-percentage` / `synthetic-mean-duration` signals.
OneDrive maps semantic actions to deployed `step-1`…`step-4` IDs; its historical
`onedrive-planned-*` names are retained, not proposal nodes. There are no
per-target signal inventories. Skipped actions receive Unknown without a value.

Valid-but-incomplete live setup produces unsuccessful/unexecutable journey
evidence when reporting credentials are usable. Unsafe schemas/reporting
credentials can prevent publication and require independent freshness checks.
Publication uses bounded retries, a five-second request budget and 30-second
batch budget. A 204 is ingestion acceptance, not evaluated rollup or notification.
TTL expiry removes signals; it is not a guaranteed Unhealthy alert.

## Optional Teams quality evidence

The scheduled meeting stays connectivity-only with five measured business
steps. Normal `teamsCallQuality` collection remains disabled by default and
bounded to its existing 1–60 second same-cycle budget; no cross-cycle pending
cache, queue or worker is added.

The separate [one-shot Teams pilot](../teams/README.md#one-shot-hosted-audio-feasibility-pilot)
uses an optional connected-call hook and a narrow callback extension on the
existing signed, tenant/audience-verified listener. It must own the configured
public callback route/port, not run alongside the normal worker or silently use
its listener. It closes both calls and the listener before a default finite
150-minute exact-ID readback, retries recent 404s and empty initial versions,
and requires `ENABLE_LIVE_M365=true` plus explicit
`--acknowledge-tenant-wide-call-records` for tenant-wide `CallRecords.Read.All`.
It grants nothing and is not live-proven by unit tests.

Quality reports contain only returned metrics with values, preserving zero;
missing, pending, failed-only and no-stream metrics produce no external reports.
Only existing `healthModel.callQualityThresholds` keys select model members and
publication; unselected actual measurements remain diagnostics. Thresholds,
stream coverage and Graph provenance are preserved, and partial coverage cannot
be called Healthy. The pilot publishes only with `--publish`, through the
existing Teams reporter/root destination; it never reports its failures as a
normal scheduled-meeting attempt or creates an audio entity/playback signal.

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
Azure export uses Microsoft's OpenTelemetry exporters directly, retaining
observable export callbacks and bounded flush/shutdown. The distribution would
hide these failures behind its own processors. No automatic instrumentation,
live metrics or additional standard metrics are enabled.

No in-memory cycle can survive every crash/network partition. There is no
exactly-once or lossless-delivery guarantee. Independently verify stopped/stalled
workers, fresh accepted reports, model propagation and notifications; do not rely
on the worker to detect its own loss. See
[enterprise acceptance](../../docs/operations.md#enterprise-reliability-acceptance-gate).
