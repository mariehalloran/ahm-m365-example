# Microsoft 365 provider monitoring

Provider entities and collection are **off by default**. Set root
`"serviceHealth": { "enabled": true }` to include the supporting entities and
permit the source settings below. Omitting the root setting, omitting `enabled`,
or setting it to `false` means no Service Health entity, provider lane, Graph
provider calls or provider reports. Synthetic journeys are unchanged.

Microsoft documents the related advanced monitoring feature for at least 5,000
qualifying Office/Microsoft 365 E3/E5 licenses and 50 monthly active users.
Confirm beta API eligibility with Microsoft; consent alone does not establish it.
These minimums do **not** apply to stable Service Health.

Each existing service container has an **independent provider lane**. It does not wait for synthetic execution and cannot change synthetic success, business-step measurements, or Experience rollup. All stable and approved beta signals for a product belong to **one** impact-suppressed `${service}-service-health` entity, reported ungrouped. There are no per-API entities or relationships. No extra container, mandatory Log Analytics workspace, or simulated live data is introduced.

## Short setup

1. Explicitly enable root `serviceHealth.enabled` only when this supporting context is wanted.
2. Approve application `ServiceHealth.Read.All` for stable data across Exchange, Teams and OneDrive; separately approve `ServiceActivity-Exchange.Read.All` and/or `ServiceActivity-Teams.Read.All` only when enabling those beta collectors. Keep mailbox/calendar/drive grants on the synthetic identity narrowly scoped. Name the separately federated read-only provider application once per tenant, as `providerClientId` beside the tenant's `tenantId`: every service whose `execution` enables `serviceHealth` or `serviceActivity` inherits it, and a service's own `execution.providerClientId` overrides it. It never selects the synthetic or Azure-report identity. Every hosted worker uses its explicitly selected managed identity and needs its own trust on that provider application; there is no certificate fallback.
3. Set these in the service's `execution` block (`tenants[].services.<service>.execution`), not in root selection/target fields:

```json
{
  "providerIntervalSeconds": 300,
  "serviceHealth": true,
  "serviceActivity": {
    "enabled": true,
    "aggregationIntervalMinutes": 15,
    "lookbackMinutes": 30,
    "maxAgeMinutes": 60,
    "thresholds": {
      "getConnectivityMetricsForExchange": {
        "degradedBelow": 99,
        "unhealthyBelow": 95
      }
    }
  }
}
```

The threshold example applies to **Exchange only**; Teams may omit `thresholds` entirely. Counts and Teams percentages are diagnostic by default. Thresholds are explicit customer choices, not universal SLOs. An optional `functions` array selects 1–5 unique functions for that service; omitting it selects all five approved functions. Beta remains **disabled by default**; enable it per service.

For **OneDrive**, set `serviceHealth: true` and keep `serviceActivity.enabled: false`, with no beta `functions` or `thresholds`. The tenant's `providerClientId` is inherited here too and selects the existing read-only provider app; it does not add Graph permissions. Its provider lane is also 300 seconds.

4. Set the explicit approvals in the `deployment` section, then run `npm run deploy`, which deploys the matching models first and then the workers:

```json
"deployment": { "enableLiveProbes": true, "enableBetaServiceActivity": true }
```

`enableBetaServiceActivity: true` mounts `ENABLE_BETA_SERVICE_ACTIVITY=true` in each worker, and deployment rejects a live worker that enables `serviceActivity` without it. No environment override is required. Local live commands still require both `ENABLE_LIVE_M365=true` and `ENABLE_BETA_SERVICE_ACTIVITY=true`; beta acknowledgement is also required when explicitly testing beta-enabled simulation. `--once` settles synthetic and provider lanes before exit.

5. Validate actual Graph authorization, returned buckets and accepted AHM ingestion. Permission assignment is not proof of tenant eligibility, publication latency, model evaluation or alert delivery. Beta APIs are preview/unsupported for production under their beta contract.

## Exact endpoints and units

Stable `GET https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/healthOverviews?$top=100` and `GET https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/issues?$top=100` filter exact subscribed service names:

| Product | Stable service selection | Single destination | Approved beta functions |
| --- | --- | --- | ---: |
| Exchange | `Exchange Online` | `exchange-service-health` | 5 |
| Teams | `Microsoft Teams` | `teams-service-health` | 5 |
| OneDrive | `Microsoft OneDrive`, overview ID `OneDriveForBusiness` | `onedrive-service-health` | 0 |

The parent verified the OneDrive mapping through the existing hosted identity and existing federated provider application. It is distinct from `{id: "SharePoint", service: "SharePoint Online"}`; no SharePoint alias is used. Keep the working **list** overview endpoint: the same authorized identity returned 403 for `/healthOverviews/OneDriveForBusiness`. This implementation makes no individual-ID lookup. Issues use the exact OneDrive service name. Missing tenant subscription/data or denied issue access produces sanitized Unknown diagnostics rather than a new grant, an alias or fabricated Healthy. No OneDrive beta serviceActivity endpoint has been approved or implemented.

All activity endpoints are GETs beneath `https://graph.microsoft.com/beta/reports/serviceActivity/`:

| Service | Function | Contract and interpretation |
| --- | --- | --- |
| Exchange | `getConnectivityMetricsForExchange` | Percentage of successful provider-observed connections; not customer-owned mail flow |
| Exchange | `getMessageVolumeMetricsForEmailDelivery` | Successfully delivered message count (documented within 15 minutes), not a delivery success rate |
| Exchange | `getActiveUserMetricsForOutlookWebByReadEmail` | Active-user successful read count for Outlook web, not all mail clients |
| Exchange | `getActiveUserMetricsForOutlookWebByAppOpening` | Active-user web-app opening count, not an app-opening success rate |
| Exchange | `getActiveUserMetricsForEmailByModernAuthentication` | Active-user modern-authentication count, not individual sign-in events |
| Teams | `getUsageMetricsForTeamsByMeetingsJoined` | Successful meeting join count; no failure/total denominator |
| Teams | `getUsageMetricsForTeamsByLaunch` | Successful Teams launch count; no failure/total denominator |
| Teams | `getMessageVolumeMetricsForTeamsChat` | Successfully sent/delivered chat count, not synthetic message success |
| Teams | `getAudioStreamQoEMetricsForTeams` | Percentage of audio streams with QoE telemetry; **coverage, not call quality** |
| Teams | `getAudioStreamsOverUdpMetricsForTeams` | UDP percentage; network context, not automatic outage/call quality |

Append exact interval parameters, for example:

```text
getConnectivityMetricsForExchange(inclusiveIntervalStartDateTime=2026-10-26T12:00:00Z,exclusiveIntervalEndDateTime=2026-10-26T12:30:00Z,aggregationIntervalInMinutes=15)
```

Aggregation is 5/10/15/30 minutes; lookback must be an integer multiple, at most 1,440 minutes. Requests end at the current completed UTC aggregation boundary, stay within 30-day Graph retention, and never request future buckets. Polling every 300 seconds does **not** mean source data is five minutes fresh.

## Direct reports and unavailable data

Only approved stable categorical mappings are automatic:

| Overview status | Value / health |
| --- | --- |
| `serviceOperational` | 100 / Healthy |
| `serviceDegradation` | 50 / Degraded |
| `serviceInterruption` | 0 / Unhealthy |
| Missing, failed, unrecognized/investigation/recovery states | No health report |

Authentication or permission failures and unavailable observations produce **no health report**, including no Unknown placeholder. Collection failures remain console/optional OTEL diagnostics. Successfully retrieved supported statuses are converted to the availability scores above; these are categorical mappings, not measured availability percentages.

Issue history is bounded diagnostic context, not an independent availability score. A successful complete snapshot emits an `issue-summary` diagnostic, including an empty snapshot as count zero; `microsoft-reported-issue-count` reports that count on the same supporting entity with Unknown health and no evaluation rules. Failed/incomplete/missing snapshots produce no report, never zero issues. Old incident update times are not the collection freshness of an overview.

Every enabled selected function with usable data produces `microsoft-activity-<function>` on **`${service}-service-health`**, alongside available `microsoft-reported-service-status` and `microsoft-reported-issue-count` reports. Signal names remain distinct and unchanged; only destinations are consolidated. With more than one tenant in the config each is published as `tenant-<tenant id>--<name>`, one set per tenant on the shared entity; with one tenant the names stay plain. Without a threshold an activity signal reports a fresh numeric measurement with **Unknown**, no evaluation rules, and `evaluated: false` context: display is not an evaluated success. Explicit `serviceActivity.thresholds.<function>` enables `LessThan` customer `degradedBelow` / `unhealthyBelow`, ordered unhealthy ≤ degraded; percentage thresholds cannot exceed 100. Counts require explicit thresholds before producing evaluated health. No count is divided into an invented availability percentage; no raw activity metric changes a synthetic score. A disabled or unselected function simply receives no new reports; OneDrive has only its two stable signals.

The signals are plain external signals on the one supporting entity: no aggregation group, child-entity graph or writable external-signal declaration is created for them. Per-signal health and source diagnostics remain authoritative for missing data. `additionalContext.source` and `apiVersion` distinguish each stable endpoint/beta function on the shared entity; the supporting entity remains suppressed.

Units accompany **every direct report** in `additionalContext.unit`: `Percent`, `Count`, or overview `status-score` (categorical 0/50/100, not a percentage). Available diagnostic measurements with Unknown health also retain unit context; missing observations are not published. **Native external-report unit labels are not supported by the ingestion API**; no unsupported `dataUnit` is sent and read-only external signal definitions are not written. See [schema evidence and limitation](../health-model/README.md#direct-report-units-platform-limitation) and [ordered migration with exact retired IDs and model inventory](../health-model/README.md#consolidating-service-health-ordered-handoff). All old worker revisions must be inactive before final child/relationship pruning.

Select the **latest complete bucket**, not an average/sum of overlapping history. Missing/invalid/duplicate/future/out-of-window data, failed source collection, or bucket age exceeding `maxAgeMinutes` produces **no health report**. Failure categories and HTTP statuses, such as 403, remain console/optional OTEL diagnostics. A previously published report is not refreshed and remains visible until its configured TTL expires; omission does not immediately delete it. The default maximum age is 60 minutes and is configurable independently of cadence. QoE/UDP interpretations remain explicit in report context even with customer thresholds.

Each source has a 30-second cancellation budget, five exact-origin/version/path pages and a 2 MB/page cap; malformed/partial snapshots fail the source. A rejected source does not kill siblings. Provider lane slots never overlap and missed slots are logged. Simulation emits skipped source diagnostics, never provider status. Console diagnostics always accompany reporting; optional root OTEL export is additional and does not require provider Log Analytics/KQL ingestion.

Report TTL must exceed both selected synthetic lane cadence and provider cadence plus bounded publication budgets. Expiry is not guaranteed Unhealthy or an alert: independently verify worker/report freshness and end-to-end notifications.

References: [Service Health](https://learn.microsoft.com/graph/api/resources/servicehealth?view=graph-rest-1.0), [count contract](https://learn.microsoft.com/graph/api/resources/serviceactivityvaluemetric?view=graph-rest-beta), [percentage contract](https://learn.microsoft.com/graph/api/resources/serviceactivityperformancemetric?view=graph-rest-beta), [operations acceptance](./operations.md#enterprise-reliability-acceptance-gate).
