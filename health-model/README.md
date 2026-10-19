# Experience -> User Journey, with step query signals

Each service owns its worker, journey functions, reusable action functions, metrics, tests, and query files. This component owns the model topology that evaluates those measurements.

**Workers remain stateless.** They publish 1/0 observations and durations, not Healthy/Unhealthy states. Shared authentication, scheduling, HTTP, and embedded OTel functionality lives in [utils/](../synthetic-tests/utils/).

## Deployed topology

The `m365-experience-poc` layout in `rg-m365-demo`, Central US, has **12 entities and 11 relationships**. Each service Experience has one Log Analytics **User Journey** entity containing its step queries and one suppressed **Service Health** supporting-context entity.

```text
Microsoft 365 and Azure Experience
|
+-- Exchange Experience
|   +-- Service Health                       [stable provider context]
|   `-- User Journey                         [Log Analytics entity]
|       +-- Authenticate - success % / mean duration
|       +-- Create email - success % / mean duration
|       +-- Send email - success % / mean duration
|       +-- Confirm delivery - success % / mean duration
|       `-- Cleanup - success % / mean duration
|
+-- Teams Experience
|   +-- Service Health                       [stable provider context]
|   `-- User Journey                         [Log Analytics entity]
|       +-- Authenticate - success % / mean duration
|       +-- Post message - success % / mean duration
|       +-- Confirm publication - success % / mean duration
|       `-- Cleanup - success % / mean duration
|
+-- SharePoint Experience
|   +-- Service Health                       [stable provider context]
|   `-- User Journey                         [Log Analytics entity]
|       +-- Authenticate - success % / mean duration
|       +-- Verify library - success % / mean duration
|       +-- Upload file - success % / mean duration
|       +-- Read file - success % / mean duration
|       `-- Cleanup - success % / mean duration
|
`-- Azure Resource Health                       [not connected]
```

The lines below each User Journey are **signals, not child entities**. The model retains its service-created root and existing journey IDs (`exchange-global`, `teams-global`, `sharepoint-global`). Each User Journey has one Log Analytics source and a separate named KQL query for each step's success and mean duration, plus whole-journey measurements.

The User Journey signal lists remain 12 for Exchange, 10 for Teams, and 12 for SharePoint: **34 journey queries**. Three independent stable-provider status queries bring the model total to **37**. Monitoring Pipeline and its former children remain absent; operational missing-result queries/reliability safeguards are retained separately.

Each Service Health query reads only the latest fresh live v1.0 `healthOverviews` record for its own service. It remains Unknown until data arrives. Its impact stays **Suppressed**, as explicitly selected: a provider incident, collection error, or beta report must not change Experience health. Dependency rollup otherwise uses `WorstOf` with `ignoreUnknown: false`.

## What each step measures

| Instrument | Sample | Labels |
| --- | --- | --- |
| `synthetic.step.success` | 1 when the step succeeds, 0 when an executed step fails | Service, journey, bounded step name, mode, outcome |
| `synthetic.step.duration` | Elapsed seconds for that executed step, including failed attempts | Same low-cardinality labels |

Whole-journey success/duration and the specific send/delivery/publication/upload/read measurements remain available. Individual request timings are not substituted for confirmed arrival/readback.

**Skipped is not failed.** If authentication fails, later send/read actions never execute. They receive diagnostic skipped records, not artificial zero-success or zero-duration samples. Their step queries return no data/Unknown; the failed prerequisite is visible separately. Cleanup executes only when needed and uses its independent cancellation budget.

Examples:

- Send request succeeds, Inbox confirmation times out: the send step remains successful; the delivery-confirmation step fails.
- Upload succeeds but downloaded content is wrong: upload succeeds; verified readback fails.
- Message publication succeeds but cleanup fails: publication remains successful with its timing; cleanup and the overall journey fail.

No worker persists these outcomes between cycles. Log Analytics/model queries own time-window evaluation.

## Service-owned query files

| Service / journey label | Query source | Lookback |
| --- | --- | --- |
| Exchange / `send-receive-mail` | [synthetic-tests/exchange/queries/health-model/](../synthetic-tests/exchange/queries/health-model/) | 5 minutes |
| Teams / `publish-channel-message` | [synthetic-tests/teams/queries/health-model/](../synthetic-tests/teams/queries/health-model/) | 5 minutes |
| SharePoint / `save-reopen-file` | [synthetic-tests/sharepoint/queries/health-model/](../synthetic-tests/sharepoint/queries/health-model/) | 15 minutes |

Every query scopes the exact Application Insights resource, one service, one journey, and **live** mode. Step queries additionally select one bounded `probe.step`. No mailbox address, target/probe inventory, trace join, or dynamic code is required.

For each journey and step:

- Success percentage is `100 * sum(Sum) / sum(ItemCount)` for its binary observations.
- Duration is `sum(Sum) / sum(ItemCount)`, converted from seconds to milliseconds.
- No samples means no value/Unknown, never 100% success or fabricated zero latency.
- All failed samples still count as reported observations: zero sum with positive count is 0% success, not missing telemetry.

Step query files use a single `__STEP__` placeholder. Bicep substitutes the fixed step name when deploying a distinct signal **inside that service's User Journey entity**. They do not combine different services or steps.

The demo thresholds are below 99%/95% success for Degraded/Unhealthy and above 15/60 seconds for latency. These common defaults are **not production per-action SLOs**; calibrate latency budgets for authentication, sending, polling, and cleanup before operational use. These are means, not p95.

## Deployment scope and cost

The [template](./infra/main.bicep) manages:

- The existing model, workspace `law-m365-experience-poc`, and linked Application Insights `appi-m365-experience-poc`.
- Workspace-only Log Analytics Reader access for the model's system-assigned identity and its `workspace-query` authentication setting.
- Thirty-four live journey query signals plus three stable-provider context signals.
- The Service Health nodes keep Suppressed impact and require no worker-published state.

Journey signals refresh every minute; provider context refreshes every five minutes. This is approximately **49,824 scheduled evaluations per day** before service behavior/limits. Review applicable query/model pricing, workspace ingestion/retention, and refresh requirements.

This deployment does **not** create Container Apps, mailbox permissions, a registry, or the Exchange user-assigned identity. The [Exchange managed-identity Bicep](../synthetic-tests/exchange/infra/README.md) remains an independent **mock-only setup**. The workspace retains data for thirty days; Application Insights has its own daily cap and sampling configuration to review.

## Apply and inspect

Always specify the approved subscription explicitly:

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

Review the preview first. Deployment is incremental; do not use complete mode on a shared resource group. The verified Health Models API is `2026-05-01-preview`.

Query verification uses read-only Kusto fixtures, not telemetry injection:

```sh
python3 health-model/tests/verify_queries.py \
  --subscription "$SUBSCRIPTION_ID" --fixtures
```

ARM success is not enough: read back the User Journey and Service Health children under each Experience and inspect actual query evaluation. Empty live data must leave journey/step signals Unknown. Separate operational reporting-gap detection must not be confused with a Microsoft 365 outage.

## Provider endpoints and diagnostic isolation

Microsoft-reported context comes from the following v1.0 endpoints. Query configuration does not grant `ServiceHealth.Read.All` or deploy a worker:

```text
GET https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/healthOverviews
GET https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/issues
```

Both require the separate Graph application permission `ServiceHealth.Read.All`; scoped Exchange mailbox roles do not authorize them.

The requested `beta/reports/serviceActivity` integration is an approved **experimental opt-in**, disabled by default. Microsoft documents beta APIs as unsupported for production applications. Exchange and Teams have documented report functions; no SharePoint-specific function is assumed. Historical provider measurements must not be counted as our own synthetic requests.

- Exchange example: `getConnectivityMetricsForExchange(...)`, requiring `ServiceActivity-Exchange.Read.All`.
- Teams example: `getMessageVolumeMetricsForTeamsChat(...)`, requiring `ServiceActivity-Teams.Read.All`.
- Function arguments use UTC inclusive start/exclusive end and aggregation intervals of 5, 10, 15, or 30 minutes; documented start times can be up to thirty days in the past.

Beta results, issue history, and collection errors are diagnostic logs only. They never use the overview log body, contribute to synthetic/step metrics, or become query signals. Stable context queries explicitly require the overview body, `provider.api_version=v1.0`, the service, live mode, and a fresh collection timestamp.

Provider status evaluation occurs in KQL, not in the worker: operational/restored/resolved statuses score 100; degradation/investigation/recovery score 50; interruption scores 0. Unknown future statuses and missing/stale records produce no value/Unknown. The latest unknown status never falls back to an older operational record. These scores describe Microsoft-reported context, not our request success percentage.

No Graph permission grant, live provider collection call, beta enablement, or fake live status is performed as part of model deployment. The source integration must still be exercised against approved access.

### Verified context isolation

The model update was applied incrementally and read back: 12 entities, 11 relationships, 34 unchanged journey signals, and three provider-context signals. All Service Health entities retain Suppressed impact and currently report Unknown / “Log query returned no rows.”

Forty-eight read-only Kusto fixture checks verified operational, degraded, interrupted, and recovering statuses; unknown/no-data cases; and rejection of beta, issue-history, simulation, wrong-service/resource, stale, and future records. A newer beta record cannot replace a stable overview, and a newer unknown stable status cannot fall back to an older healthy record. No fixture data was ingested.

## Remaining live acceptance

No live Microsoft 365 journey or Container App has been deployed. The worker simulations must stay excluded from live model calculations.

Before production: supply approved identity/resource access, validate real OTel ingestion and step labels, test allowed/denied mailbox/site/channel access, configure independent missing-report/platform alerts, and verify an actual notification reaches its approved receiver. A model signal alone does not notify anyone.

See the [permission handoff](../MAILBOX-SYNTHETIC-ACCESS.md) and [enterprise reliability gate](../docs/operations.md#enterprise-reliability-acceptance-gate). Removing the worker's durable state does not create lossless telemetry or prevent duplicate operations across replicas.
