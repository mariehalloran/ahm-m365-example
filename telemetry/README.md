# Simple OTel measurements

The worker reports measurements. Log Analytics aggregates them. The health model evaluates the query results. No worker stores history or publishes a health state.

OTel runs **inside the same service process**, not in a separate worker, Collector, or sidecar.

## Three measurements, no mailbox dimensions

| Metric | Measurement |
| --- | --- |
| `synthetic.probe.runs` | Add one per attempt, with `outcome=success`, `failure`, or `unexecutable` |
| `synthetic.probe.duration` | Record total attempt duration in seconds, including cleanup |
| `mailflow.delivery.duration` | Record confirmed Exchange delivery time in seconds; no sample for an unconfirmed delivery |

Metric dimensions are only **service**, **execution mode**, and **outcome**:

```text
probe.service = exchange | sharepoint
probe.mode    = live | simulation
probe.outcome = success | failure | unexecutable
```

No mailbox address, probe ID, correlation ID, or cohort is needed to aggregate metrics. Different targets contribute to the same service totals. Target resources remain in the probe's operational config, not in OTel queries.

## Destination

```text
Service process with embedded OTel
  -> workspace-based Application Insights
  -> Log Analytics AppMetrics
  -> aggregate queries and model-side evaluation
```

Set the service config to `telemetry: azure-monitor` and supply `APPLICATIONINSIGHTS_CONNECTION_STRING` securely. Console mode stays local. Telemetry export and live execution are independent: simulated tests can export, but all default model queries select **live only**.

The deployed telemetry resources are `appi-m365-experience-poc` and `law-m365-experience-poc` in `rg-m365-demo`. Worker hosting and live mailbox/site access are separate. No fake live data was ingested during deployment.

## Success percentage

```kusto
AppMetrics
| where TimeGenerated > ago(15m)
| where Name == "synthetic.probe.runs"
| where tostring(Properties["probe.mode"]) == "live"
| summarize Attempts = sum(Sum),
            Successful = sumif(Sum, tostring(Properties["probe.outcome"]) == "success")
    by Service = tostring(Properties["probe.service"])
| extend SuccessPercent = iff(Attempts > 0, 100.0 * Successful / Attempts, real(null))
```

Use [success-rate.kql](./queries/success-rate.kql) when a workspace contains multiple application resources; it keeps their totals separate.

The denominator includes all reported attempts, including unexecutable tests. This is overall synthetic success, not a claim that an authentication problem means Exchange is down. Outcome labels still allow that distinction. No attempts means no percentage, never 100%.

## Average duration

```kusto
AppMetrics
| where TimeGenerated > ago(15m)
| where Name == "synthetic.probe.duration"
| where tostring(Properties["probe.mode"]) == "live"
| summarize DurationSum = sum(Sum), Measurements = sum(ItemCount)
    by Service = tostring(Properties["probe.service"])
| where Measurements > 0
| project Service, MeanSeconds = DurationSum / Measurements
```

[mean-duration.kql](./queries/mean-duration.kql) also shows Exchange confirmed-delivery duration. This is a weighted mean: sum durations and divide by measurement count, rather than averaging already averaged rows.

**These are averages, not p95.** `AppMetrics` contains histogram summaries, not enough information to reconstruct true percentiles. Per-run logs can support optional deeper analysis; they are not required by the default model queries.

## Did a service stop reporting?

[last-seen.kql](./queries/last-seen.kql) checks recent run metrics for a service and returns a row even if none exist. No mailbox inventory or per-target join is required.

Use a cadence-appropriate tolerance: Exchange reports every minute, SharePoint every five minutes. Include execution/export/ingestion delay.

This detects a **service reporting gap**, not which mailbox is missing. One active target can keep that service reporting while another target is absent. Per-target coverage would be an explicitly separate feature, not part of this default.

## Optional diagnostic records

Every attempt also emits a `synthetic-result` log in `AppTraces`, with opaque attempt/test identifiers, outcome, timing, and cleanup details. These records help investigate an incident; the default health queries do not read or enumerate them.

Mailbox addresses, message bodies/IDs, credentials, and private keys are excluded. Do not add per-run identifiers to metric labels.

## Reliability and cost

Counters export interval/delta values, so `sum(Sum)` does not repeatedly count the same cumulative counter. Exporters use bounded memory buffers; disk retry storage and Blob/file checkpoints are disabled. A crash/network outage can lose telemetry, and delivery is not exactly once.

One-shot/graceful shutdown flushes telemetry. Export failures are sanitized and explicit. Monitor reporting gaps and the alerting path independently; a functioning exporter is not an enterprise availability guarantee.

Application Insights sampling is configured at 100% for this PoC. The workspace is pay-as-you-go with 30-day retention and no workspace daily cap. Application Insights has a separate default daily cap, which must be reviewed before production. Ingestion, retention, query evaluation, and alerting costs/limits remain operational considerations.

The lockfile-tested modular Azure exporter is a beta package. Review support, retention, authentication, throttling, and enterprise reliability requirements before production.

## References

- [AppMetrics fields: Sum and ItemCount](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/appmetrics)
- [JavaScript Azure Monitor OTel exporters](https://learn.microsoft.com/en-us/javascript/api/overview/azure/monitor-opentelemetry-exporter-readme)
- [Model deployment and query wiring](../health-model/README.md)
- [Enterprise reliability gate](../docs/operations.md#enterprise-reliability-acceptance-gate)
