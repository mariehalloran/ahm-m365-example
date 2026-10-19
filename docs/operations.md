# Operations and safety

## Current scope

The [sample health model](../health-model/README.md) is deployed. Config-driven workers run one service per process with an independent cadence. Azure Container Apps is the intended host, but container hosting and hosted Graph identity selection are not implemented.

Exchange and SharePoint have real handlers plus deterministic outcome simulation. [Teams](../probes/teams/README.md) has a disabled config only. There is no Microsoft 365 Service Health collector or global monitoring-pipeline producer in the active worker.

## Run one service

```sh
npm run probe -- --config probes/exchange/config.json --once
npm run probe -- --config probes/exchange/config.json
# Separate terminal/process:
npm run probe -- --config probes/sharepoint/config.json
```

The checked-in configs are simulation examples with reporting disabled. They generate no real email/files and make no Azure reporting calls. Change that service's config and restart its worker; there is no hot reload or shared master schedule.

First execution is immediate. Each worker skips and logs missed slots instead of overlapping its own cycles or building a backlog. SIGINT/Ctrl+C and SIGTERM cancel active work and allow bounded cleanup. Use one authoritative process per config/cohort: storage ETags detect conflicting writers but cannot prevent duplicate test sends.

See the [worker guide](../runner/README.md) for strict config fields, policy overrides, isolated state, and compiled startup.

## Identity and permission gates

Do not enable live mode against real-user resources.

1. Obtain approved dedicated mailbox/site resources and an accountable owner. For Exchange, use the [mailbox administrator request](../MAILBOX-SYNTHETIC-ACCESS.md).
2. Scope Exchange `Application Mail.ReadWrite` and `Application Mail.Send` through Exchange RBAC for Applications to only the approved mailbox. Audit broader Entra grants and verify allowed/denied access.
3. For SharePoint, use [Sites.Selected](https://learn.microsoft.com/en-us/graph/permissions-selected-overview) with an explicit write grant to the approved site. The handler enumerates the site's drives before using the configured folder.
4. Configure certificate-backed application authentication through `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_CERTIFICATE_PATH`; keep the PEM/private key ignored and readable only by its owner.
5. Set the file's `mode` to `live` and separately opt in with `ENABLE_LIVE_M365=true`.
6. Run one cycle with `--once` and inspect delivery/download and cleanup evidence before enabling a schedule.

No user's password, interactive mailbox sign-in, directory-wide read permission, or `ServiceHealth.Read.All` is needed by these workers. A future Service Health collector would request that permission separately.

Azure RBAC and Microsoft 365 authorization are separate. Being Azure Owner does not authorize mailbox operations. This sample uses public-cloud endpoints only; sovereign clouds and hosted cross-tenant authentication are not implemented.

## Reporting and state

`reportToHealthModel: false` disables Azure report submission, not live Microsoft 365 mutations. These are independent approvals. With reporting enabled, require an approved `AHM_MODEL_ID` and model-scoped ingestion access. Use separate simulation/live models.

Azure reporting uses the default Azure credential, which can select the same certificate environment variables used for Graph. Do not assume Azure CLI identity and mailbox identity are automatically separated.

Each worker reports only its configured cohort, with execution mode and modeled/measured duration meaning. It does not update shared provider, Graph-availability, or runner-heartbeat entities. One successful service must not make the whole pipeline appear healthy.

History is isolated by service, mode, config, and reporting destination. Optional Blob state requires appropriate storage access. Invalid and disabled configs do not acquire credentials, execute probes, or write state/reports.

The default policy requires three fresh samples and full configured-target coverage. One test resource is an integration check, not statistical evidence of tenant-wide availability. Do not weaken freshness/coverage just to make the model green.

Reporting requires `REPORT_TTL_SECONDS >= intervalSeconds + timeoutSeconds + 90` to leave room for cleanup, ingestion, and TTL rounding. Expired external signals are removed and entity health is recalculated; verify stopped-worker behavior against the final model rather than assuming expiration always becomes Unknown.

## Timeout, retries and cleanup

- A cycle is bounded at 170 seconds; size each target list to fit.
- At most three probes execute concurrently. Requests time out at 15 seconds; safe operations retry up to three times.
- Configured per-probe timeouts cancel requests and polling. Cleanup gets an independent ten-second budget.
- Draft creation and mail send are not retried after ambiguous responses. Reads, idempotent deletes, and same-path uploads can retry.
- Retry-After is honored within the bounded budget. A requested delay beyond ten seconds fails explicitly rather than retrying too early.
- Cleanup uses observed IDs or an exact UUID-containing subject/path, never a date range, whole mailbox, or whole library.
- Late delivery can arrive after cleanup and leave an artifact. Agree on an ownership-checked review/retention process before scaling.
- Cleanup failure is explicit and cannot produce a successful probe result. Normal deletion can retain data in Deleted Items/recycle bins or under retention policies.

## Data handling and retention

Structured results retain opaque probe/correlation IDs, timing, outcome, and bounded diagnostics. Mailbox addresses, bodies, subjects/message IDs, tokens, authorization headers, response bodies, and download URLs are not intended to enter logs or health reports.

Synthetic bodies contain fixed boilerplate or a generated correlation ID, not business data. Aggregation history contains states/counters/expiry rather than mailbox contents. The model-only deployment provisions no telemetry workspace; approve log retention and regional storage before hosting.

Do not enable HTTP-body/token logging or disable TLS validation. Keep development and production identities, models, and test resources separate.

## Future process and OTel boundary (not implemented)

Each independently launched worker currently executes its own handlers in-process. A child-probe launcher and OTel SDK/exporter are not implemented.

Retain every normalized result alongside future metric summaries. Current `durationMs` covers authentication and the journey **before cleanup**, not mail delivery alone. Additional phase measurements require a deliberate contract extension.

| Planned instrument | Definition |
| --- | --- |
| `synthetic.probe.runs` counter | One increment per run with bounded service/cohort/outcome labels. Authentication/authorization failures are unexecutable, not failed mail delivery. |
| `mailflow.delivery.duration`, histogram in seconds | Confirmed delivery only: send initiation immediately before the send request to matching Inbox observation. Includes request/polling latency, not exact transport time. |
| `synthetic.probe.duration`, histogram in seconds | Overall run through cleanup; unlike current `durationMs`, includes cleanup. |
| Authentication/cleanup duration histograms | Actual phase durations, emitted only when those phases execute. |

Never use email addresses, message/correlation IDs, or per-run test IDs as metric dimensions. Do not fabricate delivery-duration samples for timeouts or unexecutable tests. A confirmed delivery followed by cleanup failure retains delivery evidence and explicit failing cleanup.

**OTel is not direct Health Models ingestion.** Summaries complement evidence; the worker separately evaluates coverage/freshness and submits expiring states. Provider context remains separate, and missing/unexecutable data never becomes Healthy.

## Telemetry queries

For a separately configured workspace-based Application Insights deployment:

```kusto
AppTraces
| extend Event = parse_json(Message)
| where tostring(Event.event) in ("service-execution-failed", "service-cycle-failed", "probe-cleanup-failed")
| project TimeGenerated, Event
| order by TimeGenerated desc
```

```kusto
AppTraces
| extend Event = parse_json(Message)
| where tostring(Event.event) == "synthetic-result"
| project TimeGenerated, TestId=tostring(Event.testId),
          CorrelationId=tostring(Event.correlationId),
          Success=tobool(Event.success), DurationMs=todouble(Event.durationMs),
          Category=tostring(Event.diagnosticCategory)
```

A started execution is not successful completion. Check service completion and reporting mode, plus report/state failures and freshness. These workers do not publish a global healthy heartbeat.

## Disablement and teardown

1. Stop the service process and confirm no new tests run; wait for bounded cleanup.
2. Verify stopped/expired evidence cannot remain falsely Healthy.
3. Revoke only the approved application permissions under the tenant owner's procedure.
4. Review/remove only confirmed synthetic artifacts, respecting retention.
5. Remove dedicated cloud resources only after owner approval. Never delete a shared resource group or unrelated resources.
