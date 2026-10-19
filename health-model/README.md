# Health model with simple metric queries

The worker runs a journey and exports OTel measurements. This component connects a model to Log Analytics and evaluates **service-level aggregates**. There is no worker state, health-report client, or mailbox inventory in the metric queries.

## Deployed resources

In the approved subscription, resource group `rg-m365-demo`, Central US:

| Resource | Name / purpose |
| --- | --- |
| Azure Monitor Health Models | `m365-experience-poc`; thirteen entities and eleven relationships |
| Log Analytics | `law-m365-experience-poc`; pay-as-you-go, thirty-day retention |
| Workspace-based Application Insights | `appi-m365-experience-poc`; linked to that workspace, sampling at 100% |
| Model authentication setting | `workspace-query`; the model's system-assigned managed identity |
| Workspace authorization | Log Analytics Reader, scoped only to the workspace, for the model identity |

No Container Apps, registry, mailbox, or Microsoft 365 permissions are deployed by this template. Application Insights has a separate daily cap from the workspace; review it before production.

## Data path

```text
Exchange / SharePoint service process
  -> embedded OTel counter and duration measurements
  -> Application Insights
  -> Log Analytics AppMetrics
  -> health-model query signal
```

All default signals select **live** metrics from the exact Application Insights resource. Simulation is excluded, and no fake live measurements were ingested for deployment validation.

## Query rules

The default metric dimensions are only service, execution mode, and outcome. Adding a mailbox to the worker's target list does not require adding it to a health-model query.

| Signal | Calculation | Missing data |
| --- | --- | --- |
| Success percentage | `100 * sum(successful attempts) / sum(all attempts)` from the delta run counter | No value / Unknown |
| Mean latency | `sum(duration) / sum(measurement count)`, converted to milliseconds | No value / Unknown |
| Missing service observations | Check whether Exchange and SharePoint have recent run metrics | Monitoring-pipeline problem, not proof Microsoft 365 is down |
| Unexecutable attempts, when configured | Aggregate run-counter outcomes for monitor/authentication failures | Distinguishable from journey failure |

Exchange latency uses its confirmed-delivery metric; SharePoint latency uses total attempt duration through cleanup. These are **weighted averages, not p95**. The simple aggregate table cannot reconstruct true percentiles from means.

Demonstration thresholds are below 99% success for Degraded and below 95% for Unhealthy; latency above 15 seconds is Degraded and above 60 seconds is Unhealthy. They are not enterprise SLOs. Exchange uses a shorter lookback than the five-minute SharePoint cadence permits; inspect the [versioned query files](./queries/) and [Bicep](./infra/main.bicep) for the deployed parameters.

No query lists mailbox addresses, probe IDs, or per-mailbox expected targets. Opaque IDs in diagnostic logs are not required for aggregate evaluation. Service-level freshness does not identify an individual missing mailbox while another target continues reporting.

## Topology

```text
Model root
`-- Microsoft 365 and Azure Experience
    +-- Azure Resource Health                  [not connected]
    +-- Exchange Experience
    |   `-- Exchange aggregate measurements
    +-- Teams Experience
    |   `-- Teams                             [not implemented]
    +-- SharePoint Experience
    |   `-- SharePoint aggregate measurements
    `-- Monitoring Pipeline
        +-- Missing service observations
        `-- Graph availability                [not connected]

Microsoft 365 Service Health                  [separate provider context]
```

The service-created model root is explicitly connected. Dependency aggregation uses `WorstOf` with `ignoreUnknown: false`. Provider context remains isolated and suppressed rather than overriding actual journey evidence.

No live worker currently supplies measurements. Journey health should remain Unknown, while missing-service monitoring can be Unhealthy. That is an honest description of an unconnected monitoring system, not a Microsoft 365 incident.

## Reapply the deployment

Use the confirmed subscription explicitly; do not rely on a shared machine's active CLI subscription:

```sh
SUBSCRIPTION_ID='<approved-subscription-id>'

az deployment group what-if \
  --subscription "$SUBSCRIPTION_ID" \
  --resource-group rg-m365-demo \
  --template-file health-model/infra/main.bicep

az deployment group create \
  --subscription "$SUBSCRIPTION_ID" \
  --resource-group rg-m365-demo \
  --name m365-model-foundation \
  --template-file health-model/infra/main.bicep
```

Review the preview first. Deployment is incremental; do not use complete mode against a shared resource group. The template pins the verified Health Models API `2026-05-01-preview`.

## Verify, then connect a worker

1. Read back the workspace/Application Insights linkage, model query authentication, workspace-scoped role, and entity signals.
2. Run the numeric queries in the real workspace, including no-data and known aggregate fixtures. A successful ARM deployment alone does not prove managed-identity evaluation works.
3. Verify the model reports no-row journey queries as Unknown and absent service observations as a monitoring problem.
4. Supply the Application Insights connection string securely and set a worker's `telemetry` to `azure-monitor`. Keep checked-in examples console-only.
5. After approved live resources exist, run once, inspect ingested `AppMetrics`, and confirm model refresh. Do not fake live samples merely to make the graph green.

The original model foundation was manually tested with external health reports on 2026-10-19, including a one-minute report expiration. That historical test is not the current ingestion path. Current workers never call that API.

Live end-to-end probe ingestion is still a separate acceptance step. Query calculations and model evaluation must not be presented as proof of actual Exchange/SharePoint journeys until those tests run.

## Notifications and enterprise operation

A query signal is not notification delivery. Action groups/receivers, independent reporting-gap alerts, and end-to-end notification tests still need configuration.

See [enterprise reliability requirements](../docs/operations.md#enterprise-reliability-acceptance-gate). Keep an out-of-band escalation route and do not rely only on Exchange/Teams notifications for Microsoft 365 monitoring.

Workspace ingestion, retention, model evaluation, and alerting have pricing/limits. Model creation does not imply zero cost. Stop producers before cleanup, revoke only dedicated roles, and delete only owner-approved resources.

## Further reading

- [Simple measurements and KQL examples](../telemetry/README.md)
- [Stateless worker configuration](../runner/README.md)
- [Mailbox authorization request](../MAILBOX-SYNTHETIC-ACCESS.md)
- [Microsoft query-signal guidance](https://learn.microsoft.com/en-us/azure/azure-monitor/health-models/signals)
- [Entity/query schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.cloudhealth/2026-05-01-preview/healthmodels/entities)
