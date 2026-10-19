# Experience -> User Journey, with step query signals

Each service owns its worker, journey functions, reusable action functions, metrics, tests, and query files. This component owns the model topology that evaluates those measurements.

**Workers remain stateless.** They publish 1/0 observations and durations, not Healthy/Unhealthy states. Shared authentication, scheduling, HTTP, and embedded OTel functionality lives in [utils/](../utils/).

## Deployed topology

The intended `m365-experience-poc` layout in `rg-m365-demo`, Central US, has **13 entities and 11 relationships**. Each service Experience has exactly one Log Analytics entity displayed as **User Journey**, containing the query signals for its actions.

```text
Microsoft 365 and Azure Experience
|
+-- Exchange Experience
|   `-- User Journey                         [Log Analytics entity]
|       +-- Authenticate - success % / mean duration
|       +-- Create email - success % / mean duration
|       +-- Send email - success % / mean duration
|       +-- Confirm delivery - success % / mean duration
|       `-- Cleanup - success % / mean duration
|
+-- Teams Experience
|   `-- User Journey                         [Log Analytics entity]
|       +-- Authenticate - success % / mean duration
|       +-- Post message - success % / mean duration
|       +-- Confirm publication - success % / mean duration
|       `-- Cleanup - success % / mean duration
|
+-- SharePoint Experience
|   `-- User Journey                         [Log Analytics entity]
|       +-- Authenticate - success % / mean duration
|       +-- Verify library - success % / mean duration
|       +-- Upload file - success % / mean duration
|       +-- Read file - success % / mean duration
|       `-- Cleanup - success % / mean duration
|
+-- Azure Resource Health                       [not connected]
`-- Monitoring Pipeline
    +-- Separate missing/execution checks for all three journeys
    `-- Graph Query Availability                [not connected]

Microsoft 365 Service Health                    [separate supporting context]
```

The lines below each User Journey are **signals, not child entities**. The model retains its service-created root and existing journey IDs (`exchange-global`, `teams-global`, `sharepoint-global`). Each User Journey has one Log Analytics source and a separate named KQL query for each step's success and mean duration, plus whole-journey measurements.

Provider context is isolated and suppressed rather than overriding measured journey evidence. Dependency rollup uses `WorstOf` with `ignoreUnknown: false`.

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
| Exchange / `send-receive-mail` | [exchange/queries/health-model/](../exchange/queries/health-model/) | 5 minutes |
| Teams / `publish-channel-message` | [teams/queries/health-model/](../teams/queries/health-model/) | 5 minutes |
| SharePoint / `save-reopen-file` | [sharepoint/queries/health-model/](../sharepoint/queries/health-model/) | 15 minutes |

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
- Forty live query signals: whole-journey/step measurements inside three User Journey entities, plus independent reporting/execution checks in the monitoring pipeline.

Signals refresh every minute. Forty signals imply up to **57,600 scheduled evaluations per day** before service behavior/limits. Keeping signals in one entity simplifies the graph but does not reduce their evaluations. Review applicable query/model pricing, workspace ingestion/retention, and refresh requirements.

This deployment does **not** create Container Apps, mailbox permissions, a registry, or the Exchange user-assigned identity. The [Exchange managed-identity Bicep](../exchange/infra/README.md) remains an independent **mock-only setup**. The workspace retains data for thirty days; Application Insights has its own daily cap and sampling configuration to review.

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

ARM success is not enough: read back the three User Journey entities, their step signal lists and Experience relationships, then inspect real query evaluation. Empty live data must leave journey/step signals Unknown and flag absent reporting as a monitoring problem, not an assertion that Microsoft 365 itself is down.

## Remaining live acceptance

No live Microsoft 365 journey or Container App has been deployed. The worker simulations must stay excluded from live model calculations.

Before production: supply approved identity/resource access, validate real OTel ingestion and step labels, test allowed/denied mailbox/site/channel access, configure independent missing-report/platform alerts, and verify an actual notification reaches its approved receiver. A model signal alone does not notify anyone.

See the [permission handoff](../MAILBOX-SYNTHETIC-ACCESS.md) and [enterprise reliability gate](../docs/operations.md#enterprise-reliability-acceptance-gate). Removing the worker's durable state does not create lossless telemetry or prevent duplicate operations across replicas.
