# A health model of service health models

The [root configuration](../monitoring.config.json) selects services and supported journey scenarios for both workers and model deployment. All three services/scenarios are enabled by default. Service files contain execution settings only; selection, targets, and OTEL are not duplicated there.

**These templates have not been deployed.** The earlier single-model PoC in `rg-m365-demo` is a different topology. Building a template or running mocked tests does not establish live ingestion, cross-model propagation, or tenant access.

## Topology and naming contract

With the default name, [main.bicep](./infra/main.bicep) creates four independent Azure Monitor Health Models resources:

```text
m365-experience-poc                         [root model]
|
+-- Exchange Experience                    [references m365-experience-poc-exchange]
|   `-- User Journey                       [exchange-global, in the Exchange model]
|       +-- Authenticate                   [exchange-authenticate]
|       +-- Create email                   [exchange-create-draft]
|       +-- Send email                     [exchange-send]
|       +-- Confirm delivery               [exchange-confirm-delivery]
|       `-- Cleanup                        [exchange-cleanup]
+-- Teams Experience                       [references m365-experience-poc-teams]
|   `-- User Journey                       [teams-global, in the Teams model]
|       +-- Authenticate
|       +-- Post message
|       +-- Confirm publication
|       `-- Cleanup
`-- SharePoint Experience                  [references m365-experience-poc-sharepoint]
    `-- User Journey                       [sharepoint-global, in the SharePoint model]
        +-- Authenticate
        +-- Verify library
        +-- Upload file
        +-- Read file
        `-- Cleanup
```

Each service model also has a **Service Health** supporting-context entity directly under its Experience root, with **Suppressed** impact. Monitoring Pipeline and unconnected Azure Resource Health branches are absent.

Each model's root entity has the same name as that model. Service model names are `<healthModel.name>-<service>`; journey entities are `<service>-global`; action entities are `<service>-<step>`. Runtime and templates share these names. The root prefix is limited to 33 characters by runtime configuration so the longest service suffix fits the model's 44-character limit.

The root model references each enabled service model through an `azureResource` source pointing to that model's resource ID, not through a copied journey or a fabricated KQL signal. Microsoft documents that [nested models contribute the health of their root entity](https://learn.microsoft.com/azure/azure-monitor/health-models/concepts#nested-health-models). The root identity has Reader only on its child models; `nested-models` authentication is required independently of OTEL.

Within a service model, Experience depends on User Journey and suppressed Service Health; User Journey depends on its action entities. Dependency aggregation uses `WorstOf`, with `ignoreUnknown: false`. With all services selected there are **27 entities and 23 relationships across four models**, including three root reference entities. Disabling a service or its only supported scenario excludes that service model and reference from a fresh deployment. All services disabled leaves the root model with no evidence, not a fabricated healthy result.

## Required direct health reports

After each complete cycle, the worker aggregates actual samples separately for the whole journey and each action, then submits two external signals to each corresponding service-model entity:

| Signal | Value and evaluation |
| --- | --- |
| `synthetic-success-percentage` | `100 * succeeded / executed`; default Degraded below 99%, Unhealthy below 95% |
| `synthetic-mean-duration` | Mean milliseconds across executed samples, including failures; default Degraded above 15,000 ms, Unhealthy above 60,000 ms |

Threshold equality does not breach. These are provisional demonstration thresholds, not production per-action SLOs or p95. Whole-journey direct duration includes cleanup. Send-request duration and confirmed delivery/publication remain distinct action measurements.

Skipped/unobserved actions have no artificial failure or duration sample. They receive explicit **Unknown** reports without a numeric value. Authentication/permission failures still make the overall attempt unsuccessful; they do not establish a provider outage. Cleanup failure affects cleanup and the whole journey without rewriting earlier successful actions.

The [Health Report Ingestion API](https://learn.microsoft.com/azure/azure-monitor/health-models/health-report-ingestion) creates external signals automatically, but **does not create destination entities**. The templates therefore establish entities first and do not declare a writable `external` signal group. Reports use the verified `2026-05-01-preview` API and require a 204 acknowledgement. Simulation emits previews only.

Workers retain no aggregation history between cycles. There is no cross-cycle sample minimum, rolling window, stabilization counter, durable outbox, or exactly-once guarantee. A complete cycle replaces each signal's previous report. Incomplete/cancelled cycles explicitly skip publication rather than publishing a healthy partial aggregate.

Reports default to a **15-minute TTL**. Expiry removes external signals; it does not necessarily make an entity Unknown if other signals still contribute health. Live configuration requires TTL to exceed cadence plus the bounded 212-second cycle/report budget. Independently monitor execution and accepted-report freshness; report expiry is not a stopped-worker alert.

## Optional OTEL and Log Analytics

With root `otel.enabled: false`, service models, journey/action entities, native nested-model references, and direct health reports still work. A fresh deployment creates **no workspace, Application Insights, workspace-query authentication, query-reader roles, or Log Analytics signals**.

With OTEL enabled and at least one service selected, the templates additionally create:

- A shared pay-as-you-go workspace and linked Application Insights component.
- Workspace-only Log Analytics Reader grants and `workspace-query` authentication for each enabled service-model identity.
- Two overall journey queries and two queries on each action entity: live success percentage and mean duration.
- One stable-provider context query on each suppressed Service Health entity.

The default full model has **37 optional query signals**: 34 journey/action signals and three provider-context signals. They live on the **same entities** that receive external reports, not a separate telemetry branch. Active query signals also contribute to entity evaluation; direct reports do not override them.

Root `otel.destination: console` is for safe local inspection and does not populate Azure queries. For Azure ingestion, select `azure-monitor` and securely supply `APPLICATIONINSIGHTS_CONNECTION_STRING`. Enabling OTEL does not enable live probes or provider permissions.

Queries remain service-owned:

| Service / journey | Queries | Window |
| --- | --- | --- |
| Exchange / `send-receive-mail` | [Exchange queries](../synthetic-tests/exchange/queries/health-model/) | 5 minutes |
| Teams / `publish-channel-message` | [Teams queries](../synthetic-tests/teams/queries/health-model/) | 5 minutes |
| SharePoint / `save-reopen-file` | [SharePoint queries](../synthetic-tests/sharepoint/queries/health-model/) | 15 minutes |

Every query selects the exact Application Insights resource, service, journey and live mode; action queries additionally select one fixed step. No target inventory or trace join is needed. Success is weighted `100 * sum(Sum) / sum(ItemCount)`; durations are weighted means, converted from seconds to milliseconds. All-zero attempts are 0% success; no samples return no value, not healthy success or zero latency.

These historical windows differ from direct single-cycle reports. The Exchange/Teams **overall query** measures confirmed delivery/publication duration, while their direct overall duration measures the whole attempt through cleanup; display names preserve that distinction. Individual action timings retain their existing definitions.

Stable Service Health queries accept only fresh live v1.0 overview records for the exact service. Issues/history and beta reports never supply synthetic reports or journey health. With OTEL disabled, provider diagnostics remain console output and the Service Health entity is an unconnected, suppressed context stub.

## Identity and permissions

There are three separate authorization responsibilities:

1. **Workers:** the same explicitly selected Graph identity obtains a separate ARM-audience token for reports. The minimum report action is `Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action`, scoped to that worker's **service model** through an approved custom role. This action was verified against the provider operation catalog. Runtime does not require root-model administration, subscription Contributor/Owner, or workspace query access. Microsoft 365 permissions remain separate.
2. **Root model:** its system-assigned identity receives built-in Reader on each enabled service model for native nesting. This is not a worker permission and is not conditional on OTEL.
3. **Service models with OTEL:** their system-assigned identities receive Log Analytics Reader only on the shared workspace. No query access is required with OTEL disabled.

The deploying operator needs approved model/resource creation and scoped role-assignment rights. Templates do not create workers, worker ingestion grants/custom roles, Microsoft 365 grants, mailboxes, bots, registries, or notifications. Explicit local certificate mode needs Azure report permission for that development principal as well as its separately scoped Graph access.

## Apply and migrate safely

Use the same reviewed private project config for deployment and workers. Deployment subscription/resource group must match `healthModel.subscriptionId` and `resourceGroup`; worker destination metadata does not relocate an ARM deployment.

```sh
SUBSCRIPTION_ID='<approved-subscription-id>'
RESOURCE_GROUP='<approved-resource-group>'
PROJECT_CONFIG='/absolute/path/to/approved/monitoring.config.json'

az deployment group what-if \
  --subscription "$SUBSCRIPTION_ID" --resource-group "$RESOURCE_GROUP" \
  --template-file health-model/infra/main.bicep \
  --parameters projectConfig=@"$PROJECT_CONFIG"

# Only after reviewing the preview and obtaining deployment approval:
az deployment group create \
  --subscription "$SUBSCRIPTION_ID" --resource-group "$RESOURCE_GROUP" \
  --name m365-model-foundation --template-file health-model/infra/main.bicep \
  --parameters projectConfig=@"$PROJECT_CONFIG"
```

**Incremental deployment does not delete omitted resources or old relationships.** It is not enough to set OTEL/service switches false and assume old entities, query groups, authentication, RBAC, or workspaces disappear.

Prefer a new approved model prefix when moving from the previous single-model topology. Establish and validate the new model family, switch worker destinations, and retire only specifically approved old resources. If reusing the old prefix, inventory and explicitly remove obsolete root relationships/entities (including the old `m365-tenant` branch), signals and permissions before relying on the new rollup. Existing external/query groups may need reconciliation when updating entities. Stop or coordinate producers during this migration; subsequent complete cycles repopulate external reports.

Similarly, disabling a previously deployed service requires stopping its worker and removing its obsolete root reference/relationship after approval. Disabling OTEL requires reconciling old query signal groups and query permissions; remove telemetry resources only if dedicated and approved. Never use complete deployment mode or delete a shared resource group to clean up this sample.

## Validation and operational acceptance

Compile and check offline contracts:

```sh
az bicep build --file health-model/infra/main.bicep --stdout > /tmp/m365-model-template.json
python3 -m unittest discover -s health-model/tests -p 'test_*.py'
```

The offline checks cover root configuration sharing, service/scenario selection, default topology, native references, and optional query-resource conditions. They are **not an Azure deployment simulation**. Runtime tests cover real config resolution, numeric aggregation boundaries, payloads, retries, OTEL-disabled live-worker wiring with fake HTTP, and independent failure paths.

The existing [read-only Kusto fixture verifier](./tests/verify_queries.py) can validate query semantics against an approved workspace when optional telemetry is used; it does not inject live telemetry or prove model ingestion.

Before operational acceptance, verify live entity reports and native root propagation with OTEL disabled, then optional live queries. Test denied ingestion, broken reference/query authorization, cancelled cycles, stale/expired reports, stopped/stalled workers, and notification delivery through an independent approved route. See the [enterprise reliability gate](../docs/operations.md#enterprise-reliability-acceptance-gate). None of these cloud acceptance checks is claimed complete.

At default cadence, direct reporting can make about **27,936 API calls/day** across the three services. Optional queries schedule approximately **49,824 evaluations/day** before service behavior/limits. Review API limits, query/model pricing, ingestion/retention, and always-running compute. Workspace retention defaults to 30 days; the Application Insights daily cap is managed separately and must be reviewed. Azure Monitor Health Models and its API are preview.
