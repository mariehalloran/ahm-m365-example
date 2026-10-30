# Microsoft 365 synthetic tests

This is the self-contained Node project: source, shared utilities,
TypeScript configuration, dependencies and build output live here. The single
user-owned [monitoring.config.json](../monitoring.config.json) stays at the repository
root, with the gitignored `.env` that the setup commands write beside it
([generated IDs](../docs/deployment.md#generated-ids-in-env)). The three service
workers run independently in Azure Container Apps and publish health directly; no
telemetry worker or persistent journey state is required.

Supported workflows: [Exchange journeys](./exchange/README.md),
[two bot-backed Teams journeys](./teams/README.md), and
[three OneDrive journeys](./onedrive/README.md). Every selected target is attempted.
There is no SharePoint project, proposal catalog, delegated-user bootstrap,
P2P audio, card, sharing or search prototype.

## Commands

Run from this directory. [`docs/setup.md`](../docs/setup.md) covers administrator
prerequisites; `setup:ids` and `setup:reply-seeds` turn that access into `.env` values, and
`deploy` applies models and workers after those and the required OneDrive provisioning
steps are complete ([setup and deploy](../docs/deployment.md)):

| Command | What it does |
| --- | --- |
| `npm run setup:ids` | Looks up or creates the Teams channel, peer bot client ID, Teams calling callback URL, call targets' organizer user IDs and OneDrive accounts' user IDs |
| `npm run setup:reply-seeds` | Provisions the retained SELF-REPLY message each `reply-mail` mailbox answers; `-- -Reprovision` replaces one that no longer validates |
| `npm run deploy` | Health models, foundation and workers from the root config; `-- --plan` previews |
| `npm run onedrive:setup` | OneDrive folders and grants; writes drive and folder IDs to `.env` ([guide](../docs/onedrive-setup.md)) |
| `npm run exchange:mail-test` | Local reply-seed and attachment/reply diagnostic; `-- --apply` writes seeds to `.env` ([guide](./exchange/README.md#provision-and-test-attachment-and-reply-separately)) |
| `npm run exchange`, `teams`, `onedrive` | Run one service's worker locally; `-- --once` runs a single cycle |

## Run locally

Requires Node.js 22 or 24 and npm:

The checked-in services are configured for **live** execution. For an offline
preview, set the chosen service's `execution.mode` to `"simulation"` and root
`serviceHealth.enabled` and `otel.enabled` to `false` before these commands.
Required generated target IDs must still be present in the adjacent `.env`.

```sh
cd synthetic-tests
npm ci
npm run exchange -- --once
npm run teams -- --once
npm run onedrive -- --once
```

Each command reads the repository-root [monitoring.config.json](../monitoring.config.json)
and the `.env` beside it. A service in `simulation` mode prints explicit modeled
observations and health-report previews, never live Microsoft 365 operations or Azure
ingestion; a `live` service needs `ENABLE_LIVE_M365=true` and real access.
Add `--tenant <id>` when the config has several tenants. Remove `--once` to schedule
that service continuously. SIGINT/SIGTERM stop scheduling and allow bounded
cleanup/reporting. Deploy everything with the single `npm run deploy`; see
[deployment](../docs/deployment.md#deploy-with-one-command).

## Configure the project

[monitoring.config.json](../monitoring.config.json) is the only configuration file.
It names things and holds only the few IDs you must supply, never secrets
([what the config holds](../docs/deployment.md#what-the-config-holds)):

| Field | Purpose |
| --- | --- |
| `healthModel` | Azure destination, success/duration thresholds, report TTL and optional `alertActionGroupIds`; recipients are managed in those Azure action groups |
| `deployment` | Hosting region and tenant, foundation, image and live/beta opt-ins; see the [`deployment` section](../docs/deployment.md#the-deployment-section) |
| `otel`, `serviceHealth` | Optional console/Azure Monitor export and Service Health context; both disabled by default |
| `tenants[]` | `id`, `displayName`, `tenantId`, optional `providerClientId` and the three services below |
| `tenants[].services.<service>.enabled`, `scenarios` | Five single-user Exchange switches (self-mail, draft, self-attachment, SELF-REPLY, private recurrence), only `channel-conversation` and `scheduled-meeting` for Teams, only `user-drive-roundtrip`, `app-folder-lifecycle` and `document-versions` for OneDrive |
| `….exchange.targets`, `….onedrive.targets` | [User groups](../docs/monitoring-groups.md) keyed by group ID, each with `userGroupName` and `users` containing the approved per-user target objects |
| `….teams.targets` | Ungrouped channel target array; never user groups |
| `….callTargets` | Teams only: the dedicated meeting and its `organizer`, not human call targets |
| `….execution` | Mode, cadence/deadlines, `executionLanes`, authentication, cleanup and optional provider settings |
| `….access` | Nonsecret certificate references and, for Teams, the bot, peer bot and peer identity names |
| `….worker` | Container App name and managed identity (`identity`, an existing one by name, or `identityName`) |
| `….setup` | OneDrive only: the explicit privileged credential used by `onedrive:setup` |

All supported scenarios default to enabled; obsolete service/scenario keys are
rejected rather than silently migrated. Optional OTEL and provider context default
off in the schema, but both are enabled in the checked-in tenant configuration.
There is no root `groups` list. Shared users keep the same target ID and settings
in each group and execute once per selected journey; generated IDs remain outside
the user target objects.

Looked-up and generated IDs (reply seeds; Teams channel, organizer, peer-bot and callback
IDs; OneDrive user, drive and folder IDs) are not config fields you maintain:
`npm run setup:ids` and the other setup commands write them to the gitignored `.env` next to
the config, and deploy and every TypeScript command fill them in
([format and keys](../docs/deployment.md#generated-ids-in-env)).

`execution.executionLanes` is an array of
`{ name, intervalSeconds, timeoutSeconds, journeys }`; assign every supported
service scenario exactly once, even when disabled. Lanes run independently
and never overlap themselves. Missed slots are skipped, not replayed.

Checked-in lanes:

- Exchange: all five journeys for every unique mailbox on one aligned wall-clock minute;
  concurrent independent attempts, sequential dependent steps and global/per-mailbox Graph-request permits.
- Teams: one lane containing channel conversation and scheduled meeting, every 120 seconds.
- OneDrive: three independent lanes, each every 300 seconds.
- Each service's optional providers: a separate lane, default `providerIntervalSeconds: 300`.

Without explicit `executionLanes`, Teams and OneDrive each use one lane containing
all their journeys, with the service's `intervalSeconds` and `timeoutSeconds`.
Exchange always uses its single aligned-minute lane.

See [shared configuration details](./utils/README.md#config). `execution` rejects
`enabled`, `targets`, report-policy and obsolete `telemetry` fields.

### Upgrading older configs

A `schemaVersion` `1.0` config (root `services` with per-service `configFile` files)
is rejected; rewrite it as `2.0` from the checked-in file. There is no automatic
migration or compatibility mode. Removing a service, scenario or lane from the config
does not remove what was deployed; retire only owned obsolete resources under the
approved [model migration procedure](../health-model/README.md#apply-and-migrate).
`deployment.retireEntities` accepts obsolete entity IDs, not entities still
supported by the current catalogue even if their scenarios are disabled.

- Keep exactly the supported scenarios, each assigned to one lane. Do not
  rename deployed `onedrive-planned-*` roots or their `step-1`…`step-4` IDs.
- Attachment and reply are separate scenarios; reply needs a retained `replySeed`
  in that same mailbox, which `npm run setup:reply-seeds` provisions into `.env` ([reply
  seeds](./exchange/README.md#provision-and-test-attachment-and-reply-separately)).
- Replace old Exchange sender/recipient target pairs with one `{ id, mailbox }`
  target for every unique former participant. Removed journeys/fields are rejected.
  Re-provision incompatible paired fixtures explicitly with
  `npm run setup:reply-seeds -- -Reprovision`; see the Exchange migration guide.
- Teams accepts only bot participants with explicitly selected managed identities;
  there is no bootstrap command or user-token compatibility path.
- Optional OneDrive stable collection accepts `serviceHealth: true` and inherits the
  tenant's approved `providerClientId`; its worker UAMI needs provider-app federation
  trust. Keep `serviceActivity.enabled: false` and omit beta functions/thresholds.

## Administrator setup: enable authentication and live tests

1. Approve dedicated resources, identity, cadence and cleanup.
   Follow [access setup](../docs/cross-tenant-access.md) and each service guide.
2. Follow [`docs/setup.md`](../docs/setup.md) for every access grant — resources,
   identities, Exchange application RBAC, Graph application roles, federated
   credentials, bots/channels and the Teams app — with the Azure, Exchange and
   Entra administrator roles it lists for each step. Use
   `deployment.foundation.mode: "existing"` and named resources.
3. Once that access exists, run `npm run setup:ids` and, when `reply-mail` is
   selected, `npm run setup:reply-seeds`: both are idempotent and only turn
   existing access into `.env` values, never a new grant. Team installation,
   Teams app upload and meeting creation remain administrator tasks; existing
   provider/readback app registrations are required.
   [Bulk OneDrive setup](../docs/onedrive-setup.md), `npm run onedrive:setup`,
   separately provisions selected folders/grants and writes drive/folder IDs;
   configure its privileged OneDrive `setup` credential block first.
4. `npm run deploy` deploys the [health models](../health-model/README.md#apply-and-migrate)
   before the [worker foundation](./infra/README.md) and workers. Each worker
   identity has ingest-only access to its own service model.
5. Live execution requires `execution.mode: "live"` and `deployment.enableLiveProbes: true`.
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
draft/file/private-series deletion and call departure are business steps.
Execution timeouts are failures, not Unknown samples. Entity health follows the
aggregate success and duration thresholds; a failed attempt does not automatically
make a large cohort Unhealthy.
Reports aggregate by stable journey/action IDs, not targets.

Completed live cycles directly publish health reports and console diagnostics.
Optional root OTEL runs in-process and does not replace direct reporting; with Azure
Monitor export, deployment also creates the administrator saved searches
([Log Analytics for administrators](../docs/operations.md#log-analytics-for-administrators)).
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
npm run typecheck
npm run build
npm run deploy -- --plan
```

Typechecking and building also check the generated catalogue. The deploy plan
validates the root configuration and `.env` bindings locally, without Azure
changes; it does not verify permissions or live access. There is no unit-test or
Python template-test suite. See [local Bicep validation](../health-model/README.md#local-validation).

The Docker build context is this directory. The runtime image contains only
compiled code and production dependencies; workers download a private hash-verified
Blob snapshot of the root config using managed identity. `npm run deploy` builds and
pins the image and snapshot. [Hosting details](./infra/README.md).
