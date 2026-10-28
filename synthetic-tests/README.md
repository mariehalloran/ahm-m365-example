# Microsoft 365 synthetic tests

This is the self-contained Node project: source, shared utilities, tests,
TypeScript/test configuration, dependencies and build output live here. The single
user-owned [monitoring.config.json](../monitoring.config.json) stays at the repository
root. The three service workers run independently in Azure Container Apps and
publish health directly; no telemetry worker or persistent journey state is required.

Supported workflows: [Exchange journeys](./exchange/README.md),
[two bot-backed Teams journeys](./teams/README.md), and
[three OneDrive journeys](./onedrive/README.md). Every selected target is attempted.
There is no SharePoint project, proposal catalog, delegated-user bootstrap,
P2P audio, card, sharing or search prototype.

## Run locally

Requires Node.js 22 or 24 and npm:

```sh
cd synthetic-tests
npm ci
npm run exchange -- --once
npm run teams -- --once
npm run onedrive -- --once
```

Each command reads the repository-root [monitoring.config.json](../monitoring.config.json),
which is checked in as safe **simulation**: explicit modeled observations and
health-report previews, never live Microsoft 365 operations or Azure ingestion.
Add `--tenant <id>` when the config has several tenants. Remove `--once` to schedule
that service continuously. SIGINT/SIGTERM stop scheduling and allow bounded
cleanup/reporting. Deploy everything with the single `npm run deploy`; see
[deployment](../docs/deployment.md#deploy-with-one-command).

## Configure the project

[monitoring.config.json](../monitoring.config.json) is the only configuration file.
It holds IDs and references, never secrets:

| Field | Purpose |
| --- | --- |
| `healthModel` | Azure destination, success/duration thresholds and report TTL |
| `deployment` | Hosting region and tenant, foundation, image and live/beta opt-ins; see the [`deployment` section](../docs/deployment.md#the-deployment-section) |
| `otel`, `serviceHealth` | Optional console/Azure Monitor export and Service Health context; both disabled by default |
| `tenants[]` | `id`, `displayName`, `tenantId` and the three services below |
| `tenants[].services.<service>.enabled`, `scenarios` | Service selection and its journey switches: the documented Exchange mail/draft/attachment/reply/list/calendar/invitation switches, only `channel-conversation` and `scheduled-meeting` for Teams, only `user-drive-roundtrip`, `app-folder-lifecycle` and `document-versions` for OneDrive |
| `….targets` | Approved mailbox/channel/account metadata, never credentials |
| `….callTargets` | Teams only: dedicated meeting and peer-bot allowlist, not human call targets |
| `….execution` | Mode, cadence/deadlines, `executionLanes`, authentication, cleanup and optional provider settings |
| `….access` | Nonsecret certificate and bot references |
| `….worker` | Container App name and managed identity |
| `….setup` | OneDrive only: the explicit privileged credential used by `onedrive:setup` |
| `groups[]` | Optional [reporting groups](../docs/monitoring-groups.md) |

All supported scenarios default to enabled; obsolete service/scenario keys are
rejected rather than silently migrated.

`execution.executionLanes` is an array of
`{ name, intervalSeconds, timeoutSeconds, journeys }`; assign every supported
service scenario exactly once, even when disabled. Lanes run independently
and never overlap themselves. Missed slots are skipped, not replayed.

Default lanes:

- Exchange: mail every 60 seconds; all other journeys every 300 seconds.
- Teams: one lane containing channel conversation and scheduled meeting, every 120 seconds.
- OneDrive: three independent lanes, each every 300 seconds.
- Each service's optional providers: a separate lane, default `providerIntervalSeconds: 300`.

See [shared configuration details](./utils/README.md#config). `execution` rejects
`enabled`, `targets`, report-policy and obsolete `telemetry` fields.

### Upgrading older configs

A `schemaVersion` `1.0` config (root `services` with per-service `configFile` files)
is rejected; rewrite it as `2.0` from the checked-in file. There is no automatic
migration or compatibility mode. Removing a service, scenario or lane from the config
does not remove what was deployed; retire only owned obsolete resources under the
approved procedure (`deployment.retireEntities`, [model migrations](../health-model/README.md#apply-and-migrate)).

- Keep exactly the supported scenarios, each assigned to one lane. Do not
  rename deployed `onedrive-planned-*` roots or their `step-1`…`step-4` IDs.
- Attachment and reply are separate scenarios; reply needs root-owned `replySeed`
  bindings from the [fixture setup](./exchange/README.md#provision-and-test-attachment-and-reply-separately).
- Teams accepts only bot participants with explicitly selected managed identities;
  there is no bootstrap command or user-token compatibility path.
- Optional OneDrive stable collection accepts `serviceHealth: true` and the
  approved `providerClientId`; its worker UAMI needs provider-app federation
  trust. Keep `serviceActivity.enabled: false` and omit beta functions/thresholds.

## Administrator setup: enable authentication and live tests

1. Approve dedicated resources, identity, cadence and cleanup.
   Follow [access setup](../docs/cross-tenant-access.md) and each service guide.
2. `npm run deploy` deploys the [health models](../health-model/README.md#apply-and-migrate)
   before the [worker foundation](./infra/README.md). The root references three
   independent service models; each worker identity has ingest-only access to its
   own model.
3. Grant only required Microsoft 365 access. Exchange uses mailbox-scoped
   application RBAC; Teams uses installed managed-identity bots and team-scoped
   Graph readback; OneDrive uses Selected folder grants and AppFolder.
   [Bulk OneDrive setup](../docs/onedrive-setup.md) creates/reuses folders, grants
   scoped write access and saves real bindings for every approved account.
4. Set `execution.mode: "live"` on the service and `deployment.enableLiveProbes: true`.
   Hosted workers then receive `ENABLE_LIVE_M365=true`; a local live run must export
   it. See the [live gates](../docs/deployment.md#live-execution-gates).

Hosted Graph/reporting explicitly selects `AZURE_CLIENT_ID`, not a guessed host,
CLI or developer login. Teams Bot Connector selects `BOT_CLIENT_ID` and matching
`BOT_TENANT_ID`/`AZURE_TENANT_ID`; scheduled meetings additionally select the
approved peer UAMI. No user sign-in, MFA or refresh-token cache is implemented.
Exchange retains explicit `graphAuthentication: "certificate"` with
`M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_CERTIFICATE_PATH` for approved
local/alternative access; Azure reporting credentials stay independent.

Providers require root `"serviceHealth": { "enabled": true }`; omission or false
excludes their model entities and stops all provider collection/reporting.
Sources without usable data publish no health reports; collection failures remain
diagnostic-only. Observed Service Health statuses map to 100/50/0 availability.
Permissions are stable `ServiceHealth.Read.All` for all three services,
and separately gated Exchange/Teams beta permissions with
`deployment.enableBetaServiceActivity: true` (`ENABLE_BETA_SERVICE_ACTIVITY=true`). See
[provider setup](../docs/provider-monitoring.md). Provider failures/counts cannot
rewrite synthetic success or Experience rollup.

## Prove one cycle before enabling recurrence

On an approved host with the configured identity, run each selected worker with
`--once` against the live config. Verify:

- Real authentication and each required action, not simulated health.
- Expected authors, recipients, meeting identities, hashes and prior-version bytes.
- Owned-artifact cleanup and both-leg call termination.
- Actual health-report acceptance, then fresh entity signals and service/root rollup.
- Independent stopped/stalled-worker and broken-ingestion detection.
- End-to-end notifications, not just enabled alert rules.

Missing OneDrive selected-folder IDs/grants are configuration/permission failure
evidence; app-folder resolution does not authorize searching the drive root or
using a broad credential fallback. Initialization failures publish unsuccessful
journeys when the independent report publisher is usable; unexecuted actions
stay Unknown. Unsafe schemas/reporting credentials can prevent publication and
need an independent observer.

## Measurement and reliability

Each attempt contributes binary success 1/0 and total duration. Executed business
steps contribute their own measurements; skipped steps never enter a request
denominator. Generic authentication/cleanup stay internal, while deliberate
deletion/cancellation/departure are business steps. Execution timeouts are failures,
not Unknown journeys. Reports aggregate by stable journey/action IDs, not targets.

Every live cycle directly publishes **External Reports** and console diagnostics.
Optional root OTEL runs in-process and does not replace direct reporting.
No durable outbox, cross-cycle history or exactly-once guarantee exists.
TTL expiry removes reports rather than guaranteeing an Unhealthy state or alert.
See [operations acceptance gates](../docs/operations.md#enterprise-reliability-acceptance-gate).

Teams covers bot APIs, not employee receipt or received audio. OneDrive covers
Graph file operations, not browser rendering or sync. Source validation and
deployment readiness do not prove live success; see
[deployment evidence](../docs/deployment.md#deployment-status-and-order).

## Validate source and packaging

From this directory:

```sh
npm test
npm run typecheck
npm run build
```

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s health-model/tests -v
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s synthetic-tests/infra/tests -v
```

The Docker build context is this directory. The runtime image contains only
compiled code and production dependencies; workers mount the root config at
deployment (`npm run deploy` builds and pins the image). [Hosting details](./infra/README.md).
