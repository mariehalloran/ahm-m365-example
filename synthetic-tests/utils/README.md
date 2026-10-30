# Shared runtime and deployment utilities

This package provides the common runtime, config loading, reporting, deployment planning, and provider support used by all service workers.

## Module map

- `src/config/` - root config parsing, normalization, and env resolution
- `src/execution/` - cycle scheduler, worker loop, step timing, and status synthesis
- `src/reporting/` - direct health reports and observation payloads
- `src/providers/` - Service Health, Message Center, and approved activity collection
- `src/deployment/` - compose and execute model/foundation/worker rollout plans
- `src/cloud/` - Azure client helpers and identity wiring

## Runtime model

- Each service runs on one or more lanes (target + optional group + optional provider lanes).
- Each lane executes a journey set on a fixed cadence from the root config.
- Cycle output includes:
  - per-step results and latency
  - journey status and aggregate service status
  - optional provider context when enabled
- Cancellation and deadlines are handled through `AbortSignal` and lane-specific timeout settings.

## Reporting model

- `logAnalytics.enabled: false` -> publish direct service and journey health reports.
- `logAnalytics.enabled: true` -> publish observations for model query evaluation windows.

## Deployment model

`src/deployment/` builds deterministic stages from root config:

1. Health model artifacts
2. Shared foundation resources
3. Per-service worker resources

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

- Root overview: `../../README.md`
- Worker entry points: `../README.md`
- Operations: `../../docs/operations.md`
