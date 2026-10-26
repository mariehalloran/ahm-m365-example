# Microsoft 365 synthetic tests

This is the self-contained Node project: source, shared utilities, tests,
configuration, dependencies and build output live here. The three service
workers run independently in Azure Container Apps and publish health directly;
no telemetry worker or persistent journey state is required.

Supported workflows: [six Exchange journeys](./exchange/README.md),
[two bot-backed Teams journeys](./teams/README.md), and
[three OneDrive journeys](./onedrive/README.md). Every selected target is attempted.
There is no SharePoint project, proposal catalog, delegated-user bootstrap,
separate reply probe, P2P audio, card, sharing or search prototype.

## Run locally

Requires Node.js 22 or 24 and npm:

```sh
cd synthetic-tests
npm ci
npm run exchange -- --once
npm run teams -- --once
npm run onedrive -- --once
```

Checked-in profiles are safe **simulation**: explicit modeled observations and
health-report previews, never live Microsoft 365 operations or Azure ingestion.
Remove `--once` to schedule that service continuously. SIGINT/SIGTERM stop
scheduling and allow bounded cleanup/reporting.

```sh
npm run teams -- --project-config /approved/path/monitoring.private.json --once
```

The root profile's `configFile` paths are relative to that profile.
An explicit `--config <service-file>` override is relative to the process working
directory and cannot override root selection, targets or report policy.

## Configure the project and each service

[monitoring.config.json](../monitoring.config.json) alone owns:

| Root field | Purpose |
| --- | --- |
| `services.exchange.scenarios` | The six documented mail/draft/attachment/list/calendar/invitation switches |
| `services.teams.scenarios` | Only `channel-conversation` and `scheduled-meeting` |
| `services.onedrive.scenarios` | Only `user-drive-roundtrip`, `app-folder-lifecycle`, `document-versions` |
| `services.<service>.enabled` / `configFile` | Service selection and its execution-file path |
| `services.<service>.targets` | Approved mailbox/channel/account metadata, never credentials |
| `services.teams.callTargets` | Dedicated meeting and peer-bot allowlist, not human call targets |
| `healthModel` | Azure destination, success/duration thresholds, report TTL and optional call-quality thresholds |
| `otel` | Optional console/Azure Monitor export; disabled by default |

All supported scenarios default to enabled. Explicitly configure private switches;
obsolete service/scenario keys are rejected rather than silently migrated.

Service files contain execution settings only: mode, cadence/deadlines, cohort,
authentication, cleanup and optional provider settings.
`executionLanes` is an array of
`{ name, intervalSeconds, timeoutSeconds, journeys }`; assign every supported
service scenario exactly once, even when root-disabled. Lanes run independently
and never overlap themselves. Missed slots are skipped, not replayed.

Default lanes:

- Exchange: mail every 60 seconds; the other five journeys every 300 seconds.
- Teams: one lane containing channel conversation and scheduled meeting, every 120 seconds.
- OneDrive: three independent lanes, each every 300 seconds.
- Each service's optional providers: a separate lane, default `providerIntervalSeconds: 300`.

See [shared configuration details](./utils/README.md#config).
No duplicate `enabled`, `targets`, report policy or obsolete `telemetry` fields
belong in a service file.

### Migrate existing private profiles

- Remove `services.sharepoint`; keep only Exchange, Teams and OneDrive.
- Replace old Teams scenario switches with exactly `channel-conversation` and
  `scheduled-meeting`. Keep dedicated `callTargets` and both approved UAMIs;
  use one execution lane containing both keys.
- Keep exactly the three documented OneDrive scenarios and their three lanes;
  remove sharing/search switches and lanes. Do not rename deployed
  `onedrive-planned-*` roots or their `step-1`…`step-4` IDs.
- Keep all six Exchange switches, with mail on the 60-second lane and the other
  five families on the 300-second lane.
- Remove public-client/token-cache and bot-certificate settings. Teams accepts
  only bot participants with explicitly selected managed identities; there is
  no bootstrap command or user-token compatibility path.
- Optional OneDrive stable collection accepts `serviceHealth: true` and the
  approved `providerClientId`; its worker UAMI needs provider-app federation
  trust. Keep `serviceActivity.enabled: false` and omit beta functions/thresholds.

Regenerate deployment parameters from that same active root profile. Source
removal and incremental deployment do not delete previously deployed resources;
retire only owned obsolete resources under the approved cleanup procedure.

## Administrator setup: enable authentication and live tests

1. Approve dedicated resources, identity, cadence and cleanup.
   Follow [access setup](../docs/cross-tenant-access.md) and each service guide.
2. Deploy [health models](../health-model/README.md#apply-and-migrate) before the
   [worker foundation](./infra/README.md). The root references three independent
   service models; each worker identity has ingest-only access to its own model.
3. Grant only required Microsoft 365 access. Exchange uses mailbox-scoped
   application RBAC; Teams uses installed managed-identity bots and team-scoped
   Graph readback; OneDrive uses Selected folder grants and AppFolder.
4. Use a private live service profile, approved root destination, and
   `ENABLE_LIVE_M365=true`. This gate is separate from `mode: "live"`.

Hosted Graph/reporting explicitly selects `AZURE_CLIENT_ID`, not a guessed host,
CLI or developer login. Teams Bot Connector selects `BOT_CLIENT_ID` and matching
`BOT_TENANT_ID`/`AZURE_TENANT_ID`; scheduled meetings additionally select the
approved peer UAMI. No user sign-in, MFA or refresh-token cache is implemented.
Exchange retains explicit `graphAuthentication: "certificate"` with
`M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_CERTIFICATE_PATH` for approved
local/alternative access; Azure reporting credentials stay independent.

Providers are optional: stable `ServiceHealth.Read.All` for all three services,
and separately gated Exchange/Teams beta permissions/`ENABLE_BETA_SERVICE_ACTIVITY=true`. See
[provider setup](../docs/provider-monitoring.md). Provider failures/counts cannot
rewrite synthetic success or Experience rollup.

## Prove one cycle before enabling recurrence

Run each selected worker with `--once` using the approved profile. Verify:

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
compiled code and production dependencies; mount the approved root/service
configuration at deployment. [Hosting details](./infra/README.md).
