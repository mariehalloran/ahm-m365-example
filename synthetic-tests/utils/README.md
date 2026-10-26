# Shared utilities and stateless service execution

**Root selection, independent cadences, no saved history.** Each worker runs its configured journey, aggregates this cycle's attempts by journey/action, publishes direct health reports, and waits for its next scheduled slot.

The [root config](../../monitoring.config.json) supplies service/journey switches, accounts/targets, model destination, report policy, and optional OTEL. Each service keeps a separate cadence/config. [project-config.ts](./src/project-config.ts) validates and combines these nonoverlapping inputs; [health-reports.ts](./src/health-reports.ts) evaluates current-cycle success/mean duration and calls the Health Report Ingestion API. There is no checkpoint file/blob or aggregation history.

The intended deployment is one Azure Container App per service. Structured console diagnostics and direct live health reports are always available; optional OTEL export runs in the same process. There is no separate telemetry worker, collector, or Kubernetes requirement.

## Run

Run from the `synthetic-tests/` project directory:

```sh
npm run exchange -- --once
npm run exchange
# Separate process, separate cadence:
npm run onedrive
npm run teams -- --once
```

Each entry reads `../monitoring.config.json`, or `--project-config <file>`, then that project's selected service `configFile`. Its path is relative to the project config. Optional `--config <file>` overrides the service file, relative to the process working directory, **not** root selection/targets/report policy. Another service's config is rejected before runtime initialization. `--once` limits execution to one cycle; inspect individual result outcomes rather than interpreting process completion as proof that a service works. There is no generic all-service CLI or process launcher.

Production utilities do not import service implementations. Each service's `src/worker.ts` supplies its selected journey handler to [worker.ts](./src/worker.ts). [runner.ts](./src/runner.ts) executes that handler (or deterministic simulation), validates the version 2.0 result, and records console observations for cycle aggregation.

Shared code also includes [auth](./src/auth.ts), [config validation](./src/service-config.ts), [Graph](./src/graph.ts), [HTTP](./src/http.ts), [Bot Connector](./src/teams.ts), [step measurement](./src/steps.ts), and [console results](./src/results.ts). Service-specific API actions remain under that service's `src/steps.ts`.

The [runner](./src/runner.ts) separates cancellation deadlines, probe-batch execution, and cycle publication into named functions. [Health reporting](./src/health-reports.ts) separates sample collection and threshold evaluation from bounded HTTP publication. The [worker](./src/worker.ts) owns scheduling and shutdown, with a separate function coordinating each journey/provider cycle.

First execution is immediate. The fixed-rate schedule never overlaps its own previous cycle; missed slots are skipped and logged. Configs are read only at startup. SIGINT/SIGTERM stop scheduling, cancel active work, and permit bounded probe cleanup and reporting.

Separate service processes do not block each other. Keep one authoritative instance per target set; statelessness is not a distributed lock, and replicas can otherwise duplicate emails.

## Config

| Field | Meaning |
| --- | --- |
| `type` | `exchange`, `sharepoint`, `teams`, or `onedrive` |
| `intervalSeconds` | Start-to-start cadence, 1-86,400 seconds |
| `timeoutSeconds` | Probe execution timeout, up to 120 seconds; cleanup has a separate bounded budget |
| `executionLanes` | Optional array of `{ name, intervalSeconds, timeoutSeconds, journeys }`; unique lanes assign every supported service journey exactly once. Exchange defaults to mail/extended lanes; OneDrive explicitly configures three independent 300-second lanes; other services default to one lane |
| `mode` | `simulation` or `live` |
| `graphAuthentication` | `managed-identity` by default for same-tenant Graph; explicit `certificate` uses `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_CERTIFICATE_PATH` for hosted cross-tenant or local access |
| `teamsAuthentication` | Default `bot`; `user-delegated` is explicitly opt-in and requires approved human bootstrap |
| `botAuthentication` | Independently defaults to `managed-identity`, explicitly selecting `BOT_CLIENT_ID` and same-tenant `BOT_TENANT_ID`; optional `certificate` requires `BOT_CLIENT_CERTIFICATE_PATH` |
| `teamsReadbackClientId` | Optional same-tenant Entra application for bot Graph readback through worker-UAMI federation; requires Teams bot mode and managed-identity Graph authentication |
| `healthReportAuthentication` | Independently defaults to `managed-identity` using `AZURE_CLIENT_ID`; explicit local `certificate` uses `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_CERTIFICATE_PATH` |
| `exchangeCleanupEnabled` | Default `true`; `false` retains mail/drafts and skips draft deletion; owned calendar deletion/cancellation stays mandatory |
| `teamsCleanupEnabled` | Default `true`; set `false` in the Teams service file to retain channel posts and replies for inspection |
| `teamsCallingCallbackUrl` | Required for selected live calls: real public HTTPS URL with exact `/api/calls` path; only the Teams app gets ingress |
| `teamsCallingPort` | Callback listener port, default 8080 |
| `teamsCallingPlaybackEnabled` | Explicit approval for two-bot meeting playback; false by default, required true for selected live calls; no human or signaling-only fallback |
| `teamsCallingAnswerTimeoutSeconds` | Established-call deadline, default 20 seconds (1–30); unanswered attempts fail |
| `teamsCallQuality` | Optional Teams-only bounded post-call collection; disabled by default, 30-second budget / 5-second polling, requires separate `CallRecords.Read.All` approval |
| `teamsCallingPlaybackTimeoutSeconds` | POST + authenticated operation-completion deadline, default 10 seconds (2–30); live timeout must allow both budgets plus 5 seconds; hang-up never disabled by message retention |
| `serviceHealth` | Optional boolean, default `false`; stable Microsoft service health context only; OneDrive rejects enabled collection rather than aliasing a provider |
| `providerIntervalSeconds` | Independent provider lane start-to-start cadence, default 300 seconds (1–86,400); no extra container |
| `serviceActivity` | Optional strict beta settings, default disabled; all five approved service functions, optional explicit direct-report thresholds; see [provider setup](../../docs/provider-monitoring.md) |
| `scenario` | Optional deterministic simulation scenario |
| `cohort` | Configured grouping label for results; not a worker health policy |

The service-file parser rejects unknown fields, invalid types/limits, and redundant root-owned `enabled`, `targets`, and obsolete `telemetry` keys. Root config validates target types and duplicates. Invalid schemas and disabled selections do not execute probes. Valid-but-incomplete live resources fail runtime initialization and, when the independent report publisher is usable, produce observed unexecutable journey reports rather than silently stopping monitoring.

The obsolete per-service `reportToHealthModel` field remains rejected: live worker commands always report health. Root `healthModel` configures the destination, thresholds, and TTL. Root service and supported journey-scenario switches control enablement; service files do not define another target list or enablement gate.

## Per-cycle health reports

For each settled lane cycle, report each observed journey to its own entity and each business action to `<journey-entity>-<step>`. OneDrive maps semantic action names to its already-deployed `step-1`…`step-4` IDs and preserves `onedrive-planned-*` root IDs while promoting their metadata to active. Both signals use `synthetic-success-percentage`/`synthetic-mean-duration` in **External Reports**, independent of optional OTEL. Success counts only executed samples; duration includes executed failures. Token acquisition/generic cleanup remain internal; deliberate deletion/cancellation are business steps. Retention skips cleanup rather than claiming success. Current root selection has twelve active journeys and 47 active business steps; account attempts aggregate into shared journey/step entities. See [OneDrive boundaries and persistence](../onedrive/README.md).

Independent lanes execute concurrently; at most three attempts per lane run at once, with dependent actions sequential. Each lane waits for completed/deadline results before aggregation/publication, never overlaps itself, and emits `service-slots-skipped` instead of replaying missed slots. Slow-lane execution/reporting does not hold the fast lane. A fast-lane report contains **only observed journeys**, not empty reports overwriting slow-lane entities. Provider reports remain a separate suppressed branch with their own independent provider lane. A rejected attempt does not cancel siblings.

Per-attempt timeouts actively cancel work and count as failed **0** samples/Unhealthy, not Unknown/unexecutable. Cleanup has ten seconds, runner settlement grace twelve seconds; late completion cannot overwrite a settled result. A 170-second internal lane cycle deadline produces failed results even for selected queued attempts; skipped dependent actions remain unexecuted. On external shutdown queued work is not started.

No executed samples means Unknown without a numeric value, not 100% success or zero duration. Skipped actions are excluded rather than failed. Cleanup failures affect cleanup and the whole journey, not earlier successful actions. The default policy uses below 99/95% success and above 15,000/60,000 ms mean duration; threshold equality does not breach. There is no rolling window, sample minimum, cross-cycle smoothing, or persisted state.

Simulation logs previews only and acquires no report credential. Live reports use the independently selected **Azure report identity**, never the Graph selector or `M365_*` certificate, a separate `https://management.azure.com/.default` token, and `POST .../entities/<entity>/ingestHealthReport?api-version=2026-05-01-preview`. Only 204 acknowledges ingestion. Requests are bounded to 5 seconds, at most two attempts and three concurrent sends, with a 30-second batch budget. All signals are attempted; failures are sanitized and make a one-shot command fail. There is no durable outbox or exactly-once guarantee.

Graph certificate mode previously read `AZURE_*`; migrate it to `M365_*` explicitly. No credential fallback occurs. Providers always use the explicitly selected **application** Graph credential. Teams defaults to an installed bot with independent `botAuthentication: "managed-identity"` and `https://api.botframework.com/.default`; bot/target/observer share a tenant, and bot MI additionally matches `AZURE_TENANT_ID`. Certificate Graph uses `M365_TENANT_ID`; MI Graph uses explicit `M365_TENANT_ID` when supplied, otherwise `AZURE_TENANT_ID`. Optional delegated journeys use account-bound public-client tokens and never pass them to providers or ARM; per-account encrypted-at-rest Blob caches are provisioned only for selected live delegated mode. Missing/expired auth for one account does not block healthy users. See [bot setup](../teams/README.md#primary-setup-unattended-bot) or the [optional bootstrap guide](../../docs/teams-user-bootstrap.md).

Console diagnostics accompany execution and publication failures. Incomplete externally cancelled cycles skip synthetic health publication rather than present healthy partial aggregates; deadline-complete cycles publish all failed/successful attempts. Stable provider reporting remains a separate, impact-suppressed branch.

Each report replaces the same entity/signal with a TTL (default 15 minutes). Live config requires TTL to exceed cadence plus the bounded execution/report budget: 212 seconds with OTEL off, or 224 seconds including optional export lifecycle work. Expiry removes the signal, **not a guaranteed Unhealthy state or alert**. Independent execution/report-freshness monitoring is required. Model references, permissions and migration are documented in the [model guide](../../health-model/README.md).

### Observed initialization failures

Live workers with a configured report destination retry initialization on the normal service cadence. A real setup/credential initialization exception emits `service-initialization-failed` and one unsuccessful structured result per configured attempt, with stage `initialization`. Configuration errors use `configuration-failure`; other errors retain their bounded category. Direct journey reports include the observed diagnostic categories; no failed action sample is invented for actions that never executed.

The original error remains a failed cycle, and `--once` exits unsuccessfully after reporting. No Microsoft 365 operation or simulation is substituted for missing resources. Diagnostics remain console records. Invalid root/service schemas or unusable report credentials can still fail before this reporting path is available; independent execution/report-freshness monitoring must cover that gap. See the [model guide](../../health-model/README.md) for permissions and migration.

Example live target:

```json
{ "id": "exchange-probe-001", "mailbox": "dedicated-synthetic@example.invalid" }
```

```json
{ "id": "sharepoint-probe-001", "siteId": "approved-site", "driveId": "approved-drive", "folderId": "approved-folder" }
```

```json
{
  "id": "teams-probe-001",
  "userPrincipalName": "test-user-1@constosuites.onmicrosoft.com",
  "tenantId": "11111111-1111-4111-8111-111111111111",
  "teamId": "22222222-2222-4222-8222-222222222222",
  "channelId": "approved-standard-channel-id"
}
```

Optional delegated Teams needs no `serviceUrl`; its public client/cache metadata follows the [human bootstrap guide](../../docs/teams-user-bootstrap.md). Default bot mode requires an approved `serviceUrl`, including the documented public-cloud `https://smba.trafficmanager.net/teams/` proactive endpoint. Provisioning these resources is an administrator action, not a periodic test.

One target now produces useful measurements; there is no worker-side three-sample minimum or stabilization counter.

## Optional OpenTelemetry

Root `otel` defaults to `{ "enabled": false, "destination": "console" }`, including when omitted from an older private config. Disabled workers never construct OTEL providers/exporters or require an ingestion connection string. This is not a separate enablement gate for direct health reports.

Set `enabled: true` with:

- `destination: console`: emit OTEL `otel-log` and `probe-metrics` records in addition to existing console diagnostics and direct reports/previews. No Azure exporter or credential is initialized.
- `destination: azure-monitor`: use explicit `APPLICATIONINSIGHTS_CONNECTION_STRING` to send OTEL logs/metrics to workspace-backed Application Insights. No credential or console-export fallback is attempted. The [shared hosting template](../infra/README.md#optional-otel-export) supplies this as a Container Apps secret, not a root/service config value.

[otel.ts](./src/otel.ts) uses explicit providers, not global auto-instrumentation. `synthetic-result` logs contain schema version 2.0, service, journey, opaque probe/cohort/correlation IDs, mode, success/outcome, observation time and durations. `synthetic-step` logs contain only business actions and retain explicit skipped status without fabricated duration. Histograms `synthetic.probe.success`/`synthetic.step.success` contain binary 1/0 executed samples; corresponding `.duration` histograms use seconds. Phase duration instruments remain separate. Metric dimensions are bounded to service/journey/action/mode/outcome, not individual targets or correlation IDs.

Provider diagnostics are exported only as allowlisted logs; they never add synthetic metrics or OTEL journey/step health evidence. Simulation is labeled `probe.mode=simulation`, and model queries accept only live observations. Selecting Azure export explicitly can export simulated diagnostics, but never turns them into live model health.

[azure-monitor.ts](./src/azure-monitor.ts) validates the connection string without echoing it, disables offline disk storage, retries and Statsbeat, bounds HTTP requests to five seconds, and accepts only HTTP 200 ingestion (not partial acceptance or throttling). Both streams flush after every cycle, even after journey/report errors, and shut down on exit. Flush/shutdown each have a bounded 5.5-second lifecycle budget. Export callbacks, timeouts and initialization errors remain explicit; direct reports are attempted before export failures fail a cycle. Export initialization failures require correcting settings and restarting the worker.

The exporter uses Application Insights connection-string ingestion, independently of the explicit Graph/ARM identity. The optional sample infrastructure enables Application Insights local ingestion authentication; review authentication/network policy, tenant-sensitive provider metadata, retention and cost before enabling it. It does not add Microsoft 365 permissions or platform console-log forwarding.

OTEL stable SDK packages are pinned to a compatible patched release family. A scoped package override aligns the Azure beta exporter's log-SDK type dependency with that release, avoiding its obsolete vulnerable transitive SDK. In-memory and real-exporter/mock-transport tests cover compatibility; they do not establish live ingestion.

See the [model query contract](../../health-model/README.md#optional-otel-signals). Its rolling 15-minute queries may differ from current-cycle reports; no worker history or durable outbox is added.

## Optional provider collectors

The service entry supplies journey dispatch and its [service-owned provider wrapper](../exchange/src/providers.ts); shared worker/runtime code does not import service implementations. Each container has an independent `provider-context` lane (`providerIntervalSeconds`, default 300). Missing synthetic targets/bot credentials do not prevent provider Graph access, and a slow provider cannot block synthetic cadence/publication. Providers introduce no persisted watermark, last-seen cache, extra container or mandatory Log Analytics dependency. See the [short provider setup and all ten exact beta endpoints](../../docs/provider-monitoring.md).

All fields are optional and default to:

```json
{
  "serviceHealth": false,
  "providerIntervalSeconds": 300,
  "serviceActivity": {
    "enabled": false,
    "aggregationIntervalMinutes": 15,
    "lookbackMinutes": 30,
    "maxAgeMinutes": 60,
    "thresholds": {}
  }
}
```

`serviceHealth` must be boolean. `serviceActivity` is strict: aggregation is **5, 10, 15, or 30 minutes**; lookback is an integer multiple up to **1,440 minutes**. Optional `functions` selects 1–5 unique approved identifiers; omission selects all five for that service. `maxAgeMinutes` (5–1,440, default 60) controls source-bucket freshness independently of polling. Every selected function directly reports to its own Service Health child entity. Without thresholds, valid values remain diagnostic with Unknown health and no evaluation rules. Optional `thresholds.<function>: { degradedBelow, unhealthyBelow }` enables evaluated health for that context measurement only:

| Service | Beta coverage | Additional application permission |
| --- | --- | --- |
| Exchange | Connectivity percentage, delivered-message count, web-read/app-opening/modern-authentication active-user counts | `ServiceActivity-Exchange.Read.All` |
| Teams | Meeting-join/launch/chat counts, QoE telemetry-coverage and UDP percentages (not call quality) | `ServiceActivity-Teams.Read.All` |
| SharePoint | None | `enabled: true` or any nonempty `functions` is rejected |

Unknown functions, URLs, fields, duplicates, wrong-service functions, unsafe Int64 values and invalid windows are rejected. Beta requires **`ENABLE_BETA_SERVICE_ACTIVITY=true` before runtime/credentials/mutations**, including simulation; hosted parameter preparation requires `--enable-beta-service-activity` and mounts that environment setting. Live execution independently requires `ENABLE_LIVE_M365=true`. Beta APIs remain unsupported for production under their beta contract; confirm actual tenant eligibility and returned data.

**Business Basic versus enterprise:** API-backed synthetics and stable Service Health can use Basic when the required subscribed service/Teams SKU and approved administrator access exist. The beta API pages specify application permissions but do **not** explicitly establish Basic entitlement; do not promise beta availability. Microsoft's separate [advanced Microsoft 365 monitoring eligibility](https://learn.microsoft.com/microsoft-365/enterprise/microsoft-365-monitoring) is at least 5,000 qualifying Office 365/Microsoft 365 E3/E5 licenses plus 50 monthly active users for a core service. Do not automatically apply that UI feature's threshold as a verified beta API entitlement rule; confirm actual report enablement/availability for the tenant.

The beta window ends at the current UTC aggregation bucket floor and starts `lookbackMinutes` earlier, so it never requests a future or unbounded range. For example, at 18:32 UTC:

```text
GET https://graph.microsoft.com/beta/reports/serviceActivity/getConnectivityMetricsForExchange(inclusiveIntervalStartDateTime=2026-10-16T18:00:00Z,exclusiveIntervalEndDateTime=2026-10-16T18:30:00Z,aggregationIntervalInMinutes=15)
```

Stable collection uses [service-health.ts](./src/service-health.ts) and needs separately approved **`ServiceHealth.Read.All`** admin consent. It filters exact subscribed names: `Exchange Online`, `Microsoft Teams`, `SharePoint Online`; no guessed aliases or empty-service healthy default. Discovery/administrator verification of the tenant's actual subscribed names remains a prerequisite. Exact overview status reports directly to `${service}-service-health` as `microsoft-reported-service-status` in **External Reports**, with `impactSuppressed`: **100 healthy, 50 degraded, 0 interruption**. Failed collection, missing overview, or unknown status publishes Unknown without a numeric value and includes failure context. The existing trial observes Graph 403 pending consent. An empty valid issue list is zero issue records, not a healthy status; issues never drive the overview signal.

Each source has an independent **30-second budget**, bounded retries and at most **five pages**, each bounded to **2 MB**, on the exact Graph HTTPS origin/version/collection or function path. Stable pages allow 100 items; beta pages allow the requested bucket count (maximum 288), rejecting duplicate/out-of-window/unaligned intervals. Escaped/cyclic/over-budget continuation fails the source, never a partial healthy snapshot. Source failures do not stop siblings or successful journeys. `service-provider-summary.providers` records `configured`, `succeeded`, `failed`, `skipped`, and emitted `records`.

Provider console diagnostics are allowlisted and validated. They cannot add provider observations to synthetic/step aggregates:

| Diagnostic | Context |
| --- | --- |
| `m365-service-health-overview` | `provider.service`, `provider.mode=live`, `provider.api_version=v1.0`, `provider.collected_at`, `provider.source=serviceAnnouncement.healthOverviews`, `provider.service_id`, `provider.service_name`, raw `provider.status` |
| `m365-service-health-issue` | Same service/mode/version/collection time; `provider.source=serviceAnnouncement.issues`, `provider.issue_id`, `provider.service_name`, `provider.status`, bounded JSON `provider.issue`, boolean `provider.truncated` |
| `m365-service-activity` | Service/mode/collection time; `provider.api_version=beta`, `provider.source` and `provider.function`, `provider.interval_start`, `provider.interval_end` (sample bucket), `provider.aggregation_interval_minutes`, **either** `provider.percentage` **or** `provider.value` |
| `m365-provider-collection-failed` | Service/mode/version/source/collection time, `provider.observed_at`, sanitized `provider.category`, optional numeric `provider.http_status`; no error body/headers/token |
| `m365-provider-collection-skipped` | Service, `provider.mode=simulation`, version/source/collection time, `provider.skip_reason=simulation`; no Microsoft-reported status |

Log timestamp is collection time, not historical report time. Approved issue JSON preserves id, service, classification, status, title, impact description, feature/group, start/end/modified times, resolution flag and posts (created time/type/content type/content). It retains at most 10 posts and bounds strings/serialized JSON to 6,000 characters; both `provider.truncated` and JSON `truncated` explicitly flag reductions, with `postsTotal` preserving original post count. Unknown fields are discarded; raw HTTP failures and mailbox content are never logged. This provider metadata can still be tenant-sensitive: restrict console access and any external diagnostic retention accordingly.

Overlapping historical beta samples are snapshots: never sum active-user counts as distinct users or manufacture availability denominators. Stable context maps only approved operational/degradation/interruption states; investigation/recovery/unknown states are Unknown. Explicit beta thresholds report the latest complete fresh bucket as `microsoft-activity-<function>` on the same suppressed Service Health entity. Missing/invalid/stale data replaces prior health with Unknown without a value. Counts and Teams percentages stay diagnostic without explicit customer thresholds. Neither path populates synthetic or Experience health; no mandatory KQL path is introduced.

First-party references: [stable health overviews](https://learn.microsoft.com/graph/api/serviceannouncement-list-healthoverviews?view=graph-rest-1.0), [stable issues](https://learn.microsoft.com/graph/api/serviceannouncement-list-issues?view=graph-rest-1.0), [Exchange connectivity beta](https://learn.microsoft.com/graph/api/serviceactivity-getconnectivitymetricsforexchange?view=graph-rest-beta), [Teams chat volume beta](https://learn.microsoft.com/graph/api/serviceactivity-getmessagevolumemetricsforteamschat?view=graph-rest-beta), [serviceActivity catalog](https://learn.microsoft.com/graph/api/resources/serviceactivity?view=graph-rest-beta).

## Credentials and report publication

Hosted live Graph defaults to `ManagedIdentityCredential({ clientId })`, explicitly
selected by `AZURE_CLIENT_ID`. For bot readback, `teamsReadbackClientId` explicitly
selects an Entra application that trusts this UAMI through a federated identity
credential. Only this observer uses the exchanged application token; providers,
calling and health reporting keep their independently configured identities.
Neither path falls back to CLI, secrets, certificates or a guessed host identity.
Assign Exchange roles through mailbox-scoped Exchange RBAC for Applications,
not tenant-wide Entra Graph mail grants.

Explicit `graphAuthentication: "certificate"` local live Graph operations require:

- `M365_TENANT_ID`
- `M365_CLIENT_ID`
- `M365_CLIENT_CERTIFICATE_PATH`
- `ENABLE_LIVE_M365=true`, after the mailbox/site access checks

Do not store passwords or private keys in config files. Keep PEM files ignored and readable only by their owner. See the [administrator handoff](../../MAILBOX-SYNTHETIC-ACCESS.md).

Default Teams **bot mode** requires explicit `BOT_TENANT_ID` and `BOT_CLIENT_ID`, supplied from the hosted UAMI. Only `botAuthentication: "certificate"` additionally requires `BOT_CLIENT_CERTIFICATE_PATH`. The Connector token uses `https://api.botframework.com/.default`; application Graph observation uses `https://graph.microsoft.com/.default`. Bot, observer and target tenants must match; bot MI additionally matches the host tenant. Opt-in delegated mode instead requires public-client/cache metadata and the explicit same-tenant UAMI, never a password or bot fallback.

Live reports obtain a separate ARM-audience token from the explicitly selected identity, which needs scoped ingestion permission on its own service model independently of Graph grants. Cross-tenant application Graph supports explicitly selected M365 certificates; delegated Teams hosting requires the same tenant. Bot Connector defaults independently to managed identity, with certificate mode explicitly opt-in. Simulation and disabled configs initialize no credentials. See the [shared Container Apps deployment](../infra/README.md) for cloud hosting.

Advanced execution settings such as `POLL_INTERVAL_MS` remain environment variables. Report thresholds and TTL belong in root `healthModel`; persisted minimum-sample/consecutive-failure state, `AHM_MODEL_ID`, and `STATE_STORAGE_URL` are not part of this worker.

## Results and evaluated reports

Each attempt result has an outcome and measured durations, never a Healthy/Unhealthy state. It contributes **1 for success or 0 otherwise**, plus duration observations, to current-cycle aggregation. The report publisher evaluates those aggregates against the configured policy. Console diagnostics contain opaque correlation/test IDs for drill-down; reports use fixed journey/step destinations without target dimensions or inventories.

- A successful operation with successful cleanup is a successful probe.
- Journey authentication/authorization problems are identified as unexecutable rather than asserted to be Exchange delivery failures. Independent provider failures do not rewrite the journey result.
- A delivery timeout is a failed test with no confirmed delivery-duration sample.
- Exchange request timing is emitted when the send request was attempted, even if it failed. Send duration, confirmed delivery duration, and total duration are distinct.
- Teams records bot (or opt-in delegated-user) send-request time and confirmed channel-publication time. This is not a recipient read receipt or UI test.
- SharePoint records upload and verified-readback time, including failed attempted phases, as well as total time.
- A confirmed delivery followed by cleanup failure retains delivery timing but has a failed overall outcome.
- Simulation durations are modeled and always labeled as simulation.

Cycle observations and publication retries are transient memory, not persistent worker state. A process crash or network outage can lose observations. There is no exactly-once delivery guarantee or durable outbox.

## Measurement semantics

Reports summarize executed attempts/actions within one complete cycle: success percentage and mean elapsed milliseconds. The whole journey includes internal authentication and cleanup; individual business-step reports measure only that action. Exchange send-request time, confirmed delivery time, Teams send/publication time, and SharePoint upload/readback time remain distinct console observations. An unconfirmed operation has no fabricated confirmed-duration sample.

Reports replace the previous cycle, not a historical metrics store. They do not provide percentile history or arbitrary log queries, and means alone cannot reconstruct cross-cycle weighted means or percentiles. No service combines its aggregates with another service or publishes per-target dimensions/inventories.

`SyntheticResult` retains schema version `2.0`, existing phase timings, and a `steps` array (default `[]` for older diagnostics). Each published executed business step has bounded name, `succeeded`/`failed`, `observedAt`, and `durationMs`; failed steps add a bounded diagnostic category. Skipped steps instead have a nonsecret reason and no duration or executed sample. Authentication failure does not fabricate failed send/read operations. Cleanup failure fails the overall attempt while leaving earlier successes and measurements unchanged.

`measureStep` executes a supplied async action, times it with the supplied clock, records a normalized observation, and rethrows the original failure. Journeys stop prerequisites, then attempt only owned-artifact cleanup with a separate ten-second cancellation budget. Per-attempt mutable IDs remain ephemeral. There is no plugin registry, durable job, outbox, or state file.

Each attempt emits `synthetic-result`; reported business steps emit `synthetic-step` console diagnostics, including skipped status. Token acquisition and cleanup never appear as published steps. Logs permit opaque test/correlation IDs and retain milliseconds; messages, target IDs, tokens, raw responses and credentials are never published. Simulation is labeled modeled, not measured real latency, and stale timestamps propagate to its step records. Simulation prints health previews only, never simulated cloud health.

All-zero attempts give 0%, while no samples give Unknown without a numeric value, not invented 100%. Independent monitoring must distinguish continued failed execution from stopped execution and failed publication. A report acknowledgment is not model propagation or alert delivery. Set and test freshness/detection targets against cadence plus measured delays; see the [enterprise acceptance gate](../../docs/operations.md#enterprise-reliability-acceptance-gate).

## Build

```sh
npm run build
node dist/exchange/src/worker.js --once
node dist/teams/src/worker.js --once
node dist/sharepoint/src/worker.js --once
```

Run these commands from `synthetic-tests/`. Production builds include application code only, excluding tests. Workers execute handlers in-process; Container Apps packaging/deployment remain separate work. The package in that directory owns all four service entries and these shared utilities.
