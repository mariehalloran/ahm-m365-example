# Microsoft 365 provider monitoring

Each existing service container has an **independent provider lane**. It does not wait for synthetic execution and cannot change synthetic success, business-step measurements, or Experience rollup. Provider state belongs only to the impact-suppressed `${service}-service-health` entity. No extra container, mandatory Log Analytics workspace, or simulated live data is introduced.

## Short setup

1. Approve application `ServiceHealth.Read.All` for stable data; separately approve `ServiceActivity-Exchange.Read.All` and/or `ServiceActivity-Teams.Read.All` only when enabling those beta collectors. Keep mailbox/calendar grants on the synthetic identity narrowly scoped. Optional service `providerClientId` selects the separately federated read-only provider application; it never selects the synthetic or Azure-report identity.
2. Set these **service-file** settings (not root selection/target fields):

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

The threshold example applies to **Exchange only**; Teams may omit `thresholds` entirely. Counts and Teams percentages are diagnostic by default. Thresholds are explicit customer choices, not universal SLOs. An optional `functions` array selects 1–5 unique functions for that service; omitting it selects all five approved functions. Beta remains **disabled by default** in checked-in profiles.

3. Deploy matching models first (Service Health External Reports groups include approved activity signal names), then prepare workers with explicit approvals:

```sh
npm --prefix synthetic-tests run deployment:prepare -- \
  /absolute/path/monitoring.private.json ./workers.parameters.json \
  registry.example.invalid/probes:approved \
  --enable-live --enable-beta-service-activity
```

The generated ARM parameter `enableBetaServiceActivity: true` mounts `ENABLE_BETA_SERVICE_ACTIVITY=true` in each worker. No environment override or hidden deployment profile is required. Local live commands still require both `ENABLE_LIVE_M365=true` and `ENABLE_BETA_SERVICE_ACTIVITY=true`; beta acknowledgement is also required when explicitly testing beta-enabled simulation. `--once` settles synthetic and provider lanes before exit.

4. Validate actual Graph authorization, returned buckets and accepted AHM ingestion. Permission assignment is not proof of tenant eligibility, publication latency, model evaluation or alert delivery. Beta APIs are preview/unsupported for production under their beta contract.

## Exact endpoints and units

Stable `GET https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/healthOverviews` and `/issues` filter exact subscribed service names `Exchange Online`, `Microsoft Teams`, `SharePoint Online`. SharePoint has **stable collection only**.

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

## Direct reports and Unknown

Only approved stable categorical mappings are automatic:

| Overview status | Value / health |
| --- | --- |
| `serviceOperational` | 100 / Healthy |
| `serviceDegradation` | 50 / Degraded |
| `serviceInterruption` | 0 / Unhealthy |
| Missing, failed, unrecognized/investigation/recovery states | Unknown, no numeric value |

Issue history is bounded diagnostic context, not an independent availability score. Old incident update times are not the collection freshness of an overview.

Each explicit `serviceActivity.thresholds.<function>` produces `microsoft-activity-<function>` on the same suppressed Service Health entity. Rules are `LessThan` customer `degradedBelow` / `unhealthyBelow`, ordered unhealthy ≤ degraded; percentage thresholds cannot exceed 100. Counts require explicit thresholds before producing health. No count is divided into an invented availability percentage; no raw activity metric changes a synthetic or call-quality score.

Select the **latest complete bucket**, not an average/sum of overlapping history. Missing/invalid/duplicate/future/out-of-window data, failed source collection, or bucket age exceeding `maxAgeMinutes` produces Unknown **without a numeric value**, replacing prior health rather than retaining stale Healthy. The default maximum age is 60 minutes and is configurable independently of cadence. QoE/UDP interpretations remain explicit in report context even with customer thresholds.

Each source has a 30-second cancellation budget, five exact-origin/version/path pages and a 2 MB/page cap; malformed/partial snapshots fail the source. A rejected source does not kill siblings. Provider lane slots never overlap and missed slots are logged. Simulation emits skipped source diagnostics, never provider status. Console diagnostics always accompany reporting; optional root OTEL export is additional and does not require provider Log Analytics/KQL ingestion.

Report TTL must exceed both selected synthetic lane cadence and provider cadence plus bounded publication budgets. Expiry is not guaranteed Unhealthy or an alert: independently verify worker/report freshness and end-to-end notifications.

References: [Service Health](https://learn.microsoft.com/graph/api/resources/servicehealth?view=graph-rest-1.0), [count contract](https://learn.microsoft.com/graph/api/resources/serviceactivityvaluemetric?view=graph-rest-beta), [percentage contract](https://learn.microsoft.com/graph/api/resources/serviceactivityperformancemetric?view=graph-rest-beta), [operations acceptance](./operations.md#enterprise-reliability-acceptance-gate).
