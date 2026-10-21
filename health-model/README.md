# Journey entities with named action signals

The [root config](../monitoring.config.json) selects services/scenarios and optional OTEL. The root health model references separate service models. Within each service model, **each implemented journey is one entity**; its business actions are named signals, not child entities.

The isolated development family is `m365-experience-demo` in `rg-m365-demo`. The older `m365-experience-poc` remains separate. Provisioning and failure-path testing do not prove successful Microsoft 365 access or production readiness.

## Structure

```text
Root model: Microsoft 365 Experience
|
+-- Exchange Experience [references the Exchange model]
|   +-- Send and receive email [exchange-global entity]
|   |   +-- Whole journey: success / duration signals
|   |   +-- Create email: success / duration signals
|   |   +-- Send email: success / duration signals
|   |   `-- Confirm delivery: success / duration signals
|   `-- Service Health [suppressed context entity]
|
+-- Teams Experience [references the Teams model]
|   +-- Publish channel message [teams-global entity]
|   |   +-- Whole journey: success / duration signals
|   |   +-- Post message: success / duration signals
|   |   `-- Confirm publication: success / duration signals
|   `-- Service Health [suppressed context entity]
|
`-- SharePoint Experience [references the SharePoint model]
    +-- Save and reopen file [sharepoint-global entity]
    |   +-- Whole journey: success / duration signals
    |   +-- Verify library: success / duration signals
    |   +-- Upload file: success / duration signals
    |   `-- Read file: success / duration signals
    `-- Service Health [suppressed context entity]
```

Token acquisition and cleanup still execute internally, but have **no published step results, step metrics, step traces, or health/query signals**. Operational failures remain journey diagnostics; hiding these steps does not remove credentials, cleanup, cancellation budgets, or failure handling.

The service catalog accepts an array of journeys per service. Each selected journey gets its own named graph entity and signal collection; adding another implemented scenario does not require another service model. Only the three journeys above are implemented today.

The default family has **four models, 13 entities and nine relationships**. The root model has three native service-model references. Each service root depends on its journey entities and a suppressed Service Health entity, using `WorstOf` and `ignoreUnknown: false`. Journey entities evaluate their own signals; they have no action-entity dependencies.

Service models are named `<healthModel.name>-<service>`. Existing journey IDs (`exchange-global`, `teams-global`, `sharepoint-global`) remain stable. Each model's root entity has the same name as its model. Root prefixes are limited to 33 characters so service suffixes fit the 44-character model limit.

## Health reports target signals

The [Health Report Ingestion API](https://learn.microsoft.com/azure/azure-monitor/health-models/health-report-ingestion) targets a **named external signal on an existing entity**. The entity path identifies the journey; `signalName` identifies the measurement.

For example, the send action reports to the Exchange journey entity:

```json
{
  "signalName": "send-success-percentage",
  "healthState": "Unhealthy",
  "value": 0,
  "expiresInMinutes": 15
}
```

Whole-journey signal names remain `synthetic-success-percentage` and `synthetic-mean-duration`. Each business action uses `<step>-success-percentage` and `<step>-mean-duration` on that **same journey entity**. No report is sent to a separate action entity.

For each complete cycle, success is `100 * succeeded / executed`; duration is mean milliseconds across executed samples, including failures. Default Degraded/Unhealthy thresholds are below 99%/95% success and above 15,000/60,000 ms. Equality does not breach. These are demo thresholds, not per-action SLOs or p95.

Skipped actions receive Unknown without numeric values; they are not failed requests. No samples never means 100% success or zero latency. Whole-journey elapsed time still includes internal work. Request, confirmed delivery/publication, and whole-journey timing retain their separate definitions.

Cleanup failures and credential failures still explain an unsuccessful journey, but do not generate standalone step observations. Valid-but-incomplete setup produces actual unexecutable initialization failures; unexecuted business actions remain Unknown. `--once` still fails after reporting an initialization error.

The API creates external signals, not entities, and uses `2026-05-01-preview`; a 204 acknowledges ingestion. Reports replace the previous cycle with a default 15-minute TTL. Expiry removes the external signal rather than necessarily overriding remaining query evidence. Independently monitor execution and publication freshness. Workers keep no cross-cycle aggregation history or durable outbox.

## Optional OTEL signals

When root OTEL is enabled, each journey entity also receives matching Log Analytics query signals:

- `live-success-percentage` / `live-mean-duration` for the whole journey.
- `live-<step>-success-percentage` / `live-<step>-mean-duration` for each reported business action.

The full model has **25 query signals**: 22 journey/action measurements and three suppressed provider-context queries. External and query signals coexist on the same journey entity; one source does not overwrite the other's health state.

With OTEL disabled, a fresh deployment creates no workspace, Application Insights, workspace-query authentication, query-reader grants, or query signals. Direct reports and native nested-model references continue to work.

Azure export requires root `otel.enabled: true`, `otel.destination: azure-monitor`, and a securely supplied connection string. `console` is local inspection only. Embedded OTEL is initialized independently of live probe setup so observed setup failures can also be exported when the telemetry SDK is usable.

| Service | Query sources | Window |
| --- | --- | --- |
| Exchange | [Exchange queries](../synthetic-tests/exchange/queries/health-model/) | 5 minutes |
| Teams | [Teams queries](../synthetic-tests/teams/queries/health-model/) | 5 minutes |
| SharePoint | [SharePoint queries](../synthetic-tests/sharepoint/queries/health-model/) | 15 minutes |

Queries scope the exact Application Insights resource, service, journey, live mode and, for action signals, one fixed business step. Success uses weighted `100 * sum(Sum) / sum(ItemCount)`; durations use weighted means converted from seconds to milliseconds. No target inventory or trace join is required.

The overall Exchange/Teams duration queries measure confirmed delivery/publication, while direct overall duration measures the entire attempt. Unconfirmed completion has no invented confirmed-duration sample.

Stable Service Health remains suppressed context. Only fresh exact live v1.0 overview records supply its query; issues/history and experimental beta data never become synthetic measurements. Neither Microsoft provider state nor cleanup/token operations create business-action step signals.

## Implementation and permissions

- [main.bicep](./infra/main.bicep): scenario selection, root model, native references and optional telemetry resources.
- [service-catalog.bicep](./infra/service-catalog.bicep): typed service/journey catalog, business actions and query sources.
- [service.bicep](./infra/service.bicep): one entity per selected journey with named action queries.
- [Health reporting](../synthetic-tests/utils/src/health-reports.ts): aggregate and publish named signals to journey entities.
- [Report projection](../synthetic-tests/utils/src/contracts.ts): exclude internal token/cleanup observations from published results.

Use a current Bicep CLI supporting typed exports and functions. ARM language version 2.0 represents existing resources symbolically; these are not extra deployments.

Workers need only `Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action` on their service model, independently of Microsoft 365 authorization. The root identity receives Reader on its child models for [native nesting](https://learn.microsoft.com/azure/azure-monitor/health-models/concepts#nested-health-models). With OTEL, each service-model identity receives Log Analytics Reader only on the linked workspace. Worker identities need neither model administration nor workspace query access.

## Apply and migrate

Use the same reviewed private root config for models and workers. Its subscription/resource group must match deployment scope:

```sh
az deployment group what-if --subscription '<approved-subscription>' \
  --resource-group '<approved-resource-group>' --template-file health-model/infra/main.bicep \
  --parameters projectConfig=@/absolute/path/monitoring.private.json

# Only after reviewing the preview:
az deployment group create --subscription '<approved-subscription>' \
  --resource-group '<approved-resource-group>' --name m365-model-foundation \
  --template-file health-model/infra/main.bicep \
  --parameters projectConfig=@/absolute/path/monitoring.private.json
```

For the previous action-entity layout, roll out the journey-scoped reporter first, deploy the compact model, then explicitly remove only obsolete action relationships/entities. Incremental deployment does not delete omitted graph resources. Verify the exact names and ownership before removal; retain journey entities, service roots/context, worker resources and the separate old PoC.

Existing historical token/cleanup telemetry remains subject to retention; it is not purged by this change. New records exclude those steps. Disabling OTEL/services likewise requires deliberate reconciliation of previously deployed resources, permissions and workers. Never use complete deployment mode on a shared resource group.

## Validation and limits

```sh
python3 -B -m unittest discover -s health-model/tests -p 'test_*.py'
npm --prefix synthetic-tests test
```

Offline tests cover scenario selection, multiple journey definitions, signal shape, internal-step exclusion, preserved execution/cleanup behavior and optional resource conditions. They are not Azure deployment simulations. The [read-only Kusto verifier](./tests/verify_queries.py) remains available for approved workspaces.

Verify live business-action data, fresh direct reports and service/root rollup after deployment. Successful token acquisition is not mailbox access, API-backed tests are not employee login/UI tests, and Unhealthy configuration failures are not proof of a Microsoft outage.

At default cadence, direct reports make about **18,144 calls/day before retries**. Optional queries schedule about **32,544 evaluations/day** before service limits/behavior. Review applicable pricing, ingestion/retention, quotas and the [enterprise acceptance gate](../docs/operations.md#enterprise-reliability-acceptance-gate). No successful tenant journeys or end-to-end notifications are claimed by the failure-path trial.
