# Microsoft 365 synthetic health model

A TypeScript/Azure Functions reference implementation of the supplied Microsoft 365 Synthetic Health Model plan. Synthetic journeys are the primary evidence; Microsoft-reported service health and monitoring-pipeline health are separate context.

The existing [.NET starter](./ahm-m365-example/) is preserved and is not used by this implementation.

## Quick start

Requires Node.js 22 or 24, npm, and (for Azure operations) Azure CLI.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run demo
SYNTHETIC_SCENARIO=slow npm run demo
SYNTHETIC_SCENARIO=failed npm run demo
SYNTHETIC_SCENARIO=timeout npm run demo
SYNTHETIC_SCENARIO=stale npm run demo
PROVIDER_SCENARIO=degraded npm run demo
```

`demo` is explicitly offline: no authentication, Azure writes, or mailbox mutations. It runs enough complete cycles to exercise the configured consecutive-failure/recovery policy. `DEMO_VERBOSE=true` prints the same structured events used by the deployed timer.

## Architecture

```text
5-minute monitored timer
  -> pluggable synthetic handlers (simulation, Exchange, SharePoint)
  -> strict normalized result validation
  -> cohort freshness, coverage, success rate, p95 and stabilization policy
  -> real AHM ingestHealthReport API
  -> persisted aggregation history
  -> completed-cycle runner heartbeat

Graph Service Health -> normalized provider context (does not propagate)
Graph availability  -> separate pipeline diagnostic (live mode only)
Execution events    -> Function logs / Application Insights
```

Three simulated probes form the default `exchange-global` cohort. A single mailbox is intentionally **not** called tenant-wide evidence. Cohorts can represent locations, personas, or dedicated test identities. The caller provisions one AHM entity per configured cohort.

See [deployment](./docs/deployment.md), [operations and safety](./docs/operations.md), and [service patterns/product findings](./docs/product-recommendations.md).

Provider fixtures under [mocks](./mocks/) exercise the real provider normalizer without requiring a Graph token. An optional [Dev Proxy configuration](./mocks/devproxyrc.json) intercepts only Graph and blocks unmocked Graph requests. It intentionally does not mock Azure identity or AHM. See the [proxy boundaries](./docs/operations.md#optional-dev-proxy) before using it.

## Health policy

These are demonstration defaults, not service-level guarantees:

| Evidence | State |
| --- | --- |
| At least 99% successful and p95 <= 15 seconds | Healthy |
| 95% to less than 99% successful, or p95 > 15 and <= 60 seconds | Degraded |
| Less than 95% successful, or p95 > 60 seconds | Unhealthy |
| Missing, malformed, expired, unexecutable, or insufficient coverage | Unknown |

At least three fresh samples and 100% configured-probe coverage are required by default. Observation times more than one minute in the future are invalid. Duplicates, wrong-cohort results and unconfigured probes cannot inflate sample counts.

Two consecutive bad cycles are required for Unhealthy. The first bad cycle is Degraded, **never falsely Healthy**. Two healthy cycles are required to recover from a non-healthy state. Unknown bypasses stabilization immediately and resets history. Old history is not reused after its expiration. Azure Blob Storage persists this history using conditional ETag writes; a collision or storage failure fails the execution cycle.

The policy is isolated in [policy.ts](./src/policy.ts). This PoC performs cohort evaluation externally because it submits final external health states. AHM owns model dependencies/propagation; these configurable example thresholds are not intended as a second permanent customer-policy engine. Productizing this should move cohort evaluation and temporal policy into AHM.

## Runtime configuration

Copy [local.settings.example.json](./local.settings.example.json) to an ignored `local.settings.json` for Functions Core Tools. For CLI commands, export settings as environment variables; the CLI does not automatically load that file.

| Setting | Default / purpose |
| --- | --- |
| `EXECUTION_MODE` | `simulation`; `live` uses real Graph operations |
| `ENABLE_LIVE_M365` | `false`; must explicitly be `true` for live mode |
| `SYNTHETIC_SCENARIO` | `healthy`, `slow`, `failed`, `timeout`, `stale` |
| `PROVIDER_SCENARIO` | `operational`, `degraded`, `throttled`, `unauthorized`, `forbidden`, `unavailable`, `malformed`, `stale` |
| `SYNTHETIC_SCHEDULE` | Azure deployment sets `0 */5 * * * *` |
| `PROBES_JSON` | Dedicated probe definitions; default is three simulated Exchange probes |
| `AHM_MODEL_ID` | Full ARM resource ID; required for real ingestion |
| `AHM_API_VERSION` | Must match the deployed/supported Health Models API |
| `REPORT_TTL_SECONDS` | `900`; range 60-3600; must exceed scheduling interval |
| `PROBE_TIMEOUT_MS` | `90000`; each probe also has bounded cleanup |
| `POLL_INTERVAL_MS` | `2000` |
| `MIN_FRESH_SAMPLES` / `MIN_FRESH_COVERAGE` | `3` / `1` |
| `HEALTHY_SUCCESS_RATE` / `DEGRADED_SUCCESS_RATE` | `0.99` / `0.95` |
| `HEALTHY_LATENCY_MS` / `UNHEALTHY_LATENCY_MS` | `15000` / `60000` |
| `CONSECUTIVE_FAILURES` / `CONSECUTIVE_RECOVERIES` | `2` / `2` |
| `STATE_STORAGE_URL` | Managed-identity Azure Blob endpoint for deployed history |
| `STATE_FILE` | Local persistent history, default `.azure/aggregation-state.json` |

Do not configure overlapping independent runners against one model/history blob. The monitored Azure timer serializes executions; ETags detect competing writers.

### Execute a real ingestion cycle with simulated Graph

```sh
export AHM_MODEL_ID='/subscriptions/.../resourceGroups/.../providers/Microsoft.CloudHealth/healthmodels/...'
export AHM_API_VERSION='SUPPORTED-VERSION-FROM-DEPLOYMENT'
az login
npm run cycle
SYNTHETIC_SCENARIO=failed npm run cycle
SYNTHETIC_SCENARIO=failed npm run cycle
```

Unlike `demo`, `cycle` really submits health reports. It uses Azure CLI/default credentials locally and managed identity on Azure. `report` manually exercises all four states:

```sh
npm run report -- Healthy
npm run report -- Degraded
npm run report -- Unhealthy
npm run report -- Unknown
```

Manual reporting defaults to `exchange-global` / `synthetic-health`; optional entity and signal arguments target another pre-created signal. Disable the timer during manual tests to prevent it overwriting the test state.

AHM receives only state, an explicit whole-minute expiration, and a small allowlisted diagnostic context. TTL reserves the 15-second request budget and is rounded **down**; evidence with less than 75 seconds remaining is sent as Unknown rather than refreshed. Use a TTL comfortably above the scheduling interval. Synthetic content, mailbox addresses, access tokens and Graph response bodies never enter health reports.

## Live Exchange journey

Do not enable this against real-user mailboxes. Obtain approval for dedicated shared mailbox resources and narrowly scoped application permissions first; see [operations](./docs/operations.md).

```sh
export EXECUTION_MODE=live
export ENABLE_LIVE_M365=true
export MIN_FRESH_SAMPLES=1
export PROBES_JSON='[{"id":"exchange-probe-001","type":"exchange-mail-flow","cohort":"exchange-global","mailbox":"dedicated-synthetic@example.invalid"}]'
npm run cycle
```

The sample authenticates, creates a draft with a unique correlation subject, sends without retrying an ambiguous send, polls Inbox IDs, measures latency, and cleans up only correlated test copies with independent bounded cancellation. Permission/authentication/throttling/collector failures yield Unknown evidence, not a claim about Exchange user health. Cleanup failures are explicit and prevent a successful result.

One probe with `MIN_FRESH_SAMPLES=1` is only an integration test. Use multiple approved resources and measured thresholds before claiming tenant health.

## Additional SharePoint journey

The reusable handler also validates a drive belongs to an approved site, uploads a uniquely named small synthetic file to an existing dedicated folder, downloads/verifies the exact synthetic payload, and deletes it. Download redirects do not receive a Graph bearer token.

Provision an appropriate SharePoint cohort entity first and configure `siteId`, `driveId`, and `folderId` on a `sharepoint-file` probe. No tenant-wide permissions or resources are created automatically. Teams is deliberately a documented candidate, not a misleading meeting/media synthetic.

## Implementation and validation boundaries

Implemented: reusable contracts/handlers, timer, simulation scenarios, bounded retries/cancellation, explicit freshness and aggregation, persistent anti-flapping, ARM report submission, heartbeat gating, Graph-shaped provider fixtures, Exchange and SharePoint adapters, infrastructure and automated tests.

Live evidence requires actual approved resources. No shared mailbox, test site, M365 admin consent, or Dan's existing PoC was supplied. Code and HTTP-level tests do **not** prove a real Exchange journey or a production-ready tenant SLO. Azure deployment/validation results and preview API limitations are recorded in [deployment](./docs/deployment.md).
