# Shared runtime and deployment utilities

These modules support execution-Function runtime, configuration, reporting, provider collection
and the deployment command. They belong to the [single Node project](../README.md),
not a separate package.

## Module map

- [src/configuration/](./src/configuration/) - root config parsing, normalization, target keys and generated ID bindings
- [src/execution/](./src/execution/) - cycle scheduler, lane execution loop, step timing, and status synthesis
- [src/reporting/](./src/reporting/) - direct health reports and observation payloads
- [src/providers/](./src/providers/) - Service Health, Message Center, and approved activity collection
- [src/deployment/](./src/deployment/) - compose and execute model/foundation/coordinator+Function rollout plans
- [src/integrations/](./src/integrations/) - explicit identity, Graph/HTTP clients, ownership-checked drive-file helpers, Teams clients

## Runtime model

- Each service runs journey lanes plus an independent optional provider lane; reporting groups are not execution lanes.
- Each lane executes a journey set on a fixed cadence from the root config.
- Cycle output includes:
  - per-step results and latency
  - journey status and executed business-step evidence
  - optional provider context when enabled
- Cancellation and deadlines are handled through `AbortSignal` and lane-specific timeout settings.
- Every selected synthetic lane runs every 600 seconds with a 240-second whole-journey deadline, aligned to wall-clock ten-minute boundaries. Provider lanes keep their independent cadence.
- Each whole cycle, including initialization, cleanup and reporting, ends before its next slot (599 seconds with the current one-second margin). Execution budgets remain 275 seconds for Exchange and 252 for other services. Cleanup uses ten seconds, with 12 seconds for settlement; publication allows 12 seconds for Exchange or 30 for Teams/OneDrive/SharePoint.
- Non-Exchange `cycleTimeoutSeconds` defaults to 252; capacity validation includes every selected pair/target attempt. The checked-in Teams lane needs concurrency six, while each OneDrive lane runs two attempts within its default concurrency three.
- OneDrive and SharePoint reuse the same bounded file/download/version and owned-folder cleanup helpers.
- SharePoint location keys derive from the site URL and library/folder/list names; they are not account IDs.

## Reporting model

- `logAnalytics.enabled: false` -> publish direct journey/business-step reports; Experience rolls up natively.
- `logAnalytics.enabled: true` -> publish observations for model query evaluation windows.

### Measurement semantics

In both modes, execution cancellations and cleanup-only failures report Unknown
without a numeric success/failure sample. They retain diagnostics but do not enter
success-rate or service-latency denominators. Conclusive business-step evidence
is preserved, and an all-Unknown cohort evaluates Unknown.
Console results use `outcome: "unknown"` and `success: null`; observations retain
`value: null` and `dimensions.outcome: "unknown"`. Direct Unknown reports omit
`value` and evaluation rules. `minimumSamples` counts only conclusive evidence.

## Optional provider collectors

Stable Service Health and Message Center use the independently approved provider
application, not synthetic resource grants. Exchange/Teams beta selections need
separate approval; OneDrive/SharePoint are stable-only. Sources, endpoints,
permissions and bounded diagnostics are in [provider monitoring](../../docs/provider-monitoring.md).

## Deployment model

[src/deployment/](./src/deployment/) builds deterministic stages from root config:

1. Health model artifacts
2. Shared foundation resources
3. Per-service execution Function resources (+ coordinator wiring)

Each service Function app has its own on-demand Flex Consumption plan; there is
no Premium or always-ready baseline. The independent watchdog has its own host
and identity. Durable task-hub names are resolved through the package's
`DURABLE_TASK_HUB` setting so trigger scaling and runtime use the same queues.

When dispatch is paused for an upgrade, conditional journal writes retire only
unclaimed starts. Running or ambiguous mutations are never released by a timer.
At runtime, a later slot can replace an unclaimed older slot; delayed deliveries
of the replaced run cannot claim execution.

The same command supports plan and apply:

```sh
npm run deploy -- --plan
npm run deploy
```

## Validation commands

```sh
npm run typecheck
npm run build
```

## Related docs

- [Root overview](../../README.md)
- [Coordinator and execution entry points](../README.md)
- [Operations](../../docs/operations.md)
