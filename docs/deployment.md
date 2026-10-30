# Set up and deploy

The whole flow is three steps, all driven by the single root
[monitoring.config.json](../monitoring.config.json):

1. **Edit** it: tenants, accounts and targets, scenarios, cadence and the reporting
   [`groups`](./monitoring-groups.md). It names things and holds only the few IDs you
   must supply ([what the config holds](#what-the-config-holds)).
2. **Set up Microsoft 365**: grant access by hand, then run the two small commands that
   turn that access into `.env` values ([below](#set-up-microsoft-365)).
3. **Deploy** the health models, foundation and workers with `npm run deploy`
   ([below](#deploy-with-one-command)).

The config is the real configuration of this repository's Consto test tenant and may be
checked in; it holds your choices, names and a few IDs, never secrets. The IDs that setup
looks up or generates live in a gitignored [`.env`](#generated-ids-in-env) beside it, not
in the config.

## What the config holds

The config **names** things, an Azure resource by its name and an account by its address;
IDs are derived or looked up.

**Azure resources.** A bare name is a resource in `healthModel.resourceGroup` of
`healthModel.subscriptionId`. A value starting with `/subscriptions/` is a full resource ID,
for a resource in another resource group or subscription.

| Key | Names |
| --- | --- |
| `deployment.foundation` | `{ "mode": "existing", "environment": "<name or ID>", "registry": "<name or ID>" }`; `create` mode names the ones to create |
| `worker.identity` | The existing, administrator-approved managed identity of a service's worker; `worker.identityName` instead names one the deployment creates |
| Teams `botPairs[]` | Each pair's `id`, `bot`, `identity`, `peerBot` and `peerIdentity`; existing Azure Bot registrations and managed identities |

**IDs you supply.** A resource ID is needed only for a resource outside the health model's
resource group. Otherwise the only IDs left each name something that exists outside this
repository, so nothing here can derive them:

| ID | Why it is an input |
| --- | --- |
| `healthModel.subscriptionId` | The Azure subscription that hosts the models and workers |
| `tenants[].tenantId` | The Microsoft 365 tenant to monitor; the alias is a label, not authorization |
| `tenants[].providerClientId` | The Entra app registration for Microsoft-reported Service Health and Service Activity; administrators create it outside this project |
| Teams `execution.teamsReadbackClientId` | The Teams readback app registration, likewise |
| Teams target `teamId` | The existing team that holds the channel |
| Call target `meetingThreadId` | The dedicated meeting, created outside this project |

The optional OneDrive `setup` block, read only by `npm run onedrive:setup`, also holds that
command's own client IDs ([OneDrive setup](./onedrive-setup.md#plan-apply-and-rerun)).

**Defaults.**

- `deployment.azureTenantId` is optional: it defaults to the single tenant's `tenantId` and
  is required only when the config has several tenants. Deploy still verifies it against
  the subscription's real tenant, so set it only to host in a different tenant than
  Microsoft 365.
- Teams targets and call targets default `tenantId` to the tenant's. Channel targets
  default `serviceUrl` to `https://smba.trafficmanager.net/teams/`. Every configured
  pair exercises every selected target; participant client IDs come from that pair.
- A tenant's `providerClientId` is inherited by each service that has `serviceHealth`,
  `serviceMessages` or `serviceActivity` enabled and no `execution.providerClientId` of its own; set the
  per-service value only to override it.

**Looked up by `npm run setup:ids`**, never in the config: each OneDrive account's user ID,
each call target's organizer user ID (from its `organizer`, the organizer's user principal
name, which only that command reads), both client IDs of each bot pair and the Teams calling
callback URL. It writes them to `.env` ([keys](#generated-ids-in-env)).

## Set up Microsoft 365

Every Microsoft 365 or Azure **access grant** is manual: follow
[`docs/setup.md`](./setup.md), which lists each one by name, with who can do it and the
exact `az`, Graph or PowerShell commands to run. Two small commands then generate `.env`
values from that access — never a new grant — and are safe to automate:

- `npm run setup:ids` looks up or creates the Teams channel, both client IDs of each pair, the
  Teams calling callback URL, call targets' organizer user IDs and OneDrive accounts' user
  IDs.
- `npm run setup:reply-seeds` provisions the retained SELF-REPLY message each `reply-mail`
  mailbox answers (only when that scenario is selected).

Both are idempotent and read the same root config; [`docs/setup.md`](./setup.md) covers
requirements, flags and retries in full. OneDrive's drives and folders are a separate,
separately approved command, [`npm run onedrive:setup`](./onedrive-setup.md).

### Generated IDs in `.env`

The setup commands write the IDs they look up or generate to `.env` next to
`monitoring.config.json` (the repository root), one `KEY=value` per line, so the config
keeps only what you choose. `npm run deploy` and every TypeScript command read it
automatically and fill the matching fields; leave those fields out of the config, because
deploy fails and names the conflict when the config sets one to a different value.

| Where | Keys, each `<TENANT>__<TARGET>__…` | Fills | Written by |
| --- | --- | --- | --- |
| Exchange target | `REPLY_SEED_MESSAGE_ID`, `REPLY_SEED_CORRELATION_ID` | `replySeed` | `npm run setup:reply-seeds`; a local `npm run exchange:mail-test -- --apply` |
| Teams channel target | `CHANNEL_ID` | `channelId` | `npm run setup:ids` |
| Teams call target | `ORGANIZER_USER_ID` | `organizerUserId` | `npm run setup:ids`, from the target's `organizer` |
| Teams bot pair (`<TARGET>` is the pair ID) | `BOT_CLIENT_ID`, `BOT_PEER_CLIENT_ID` | `botPairs[].botClientId`, `botPairs[].botPeerClientId` | `npm run setup:ids`, from that pair's `identity` and `peerIdentity` |
| Teams service (`<TARGET>` is `TEAMS`) | `CALLING_CALLBACK_URL` | `execution.teamsCallingCallbackUrl` | `npm run setup:ids`, from the foundation's environment |
| OneDrive target | `USER_ID` | `userId` | `npm run setup:ids`, from `userPrincipalName` |
| OneDrive target | `DRIVE_ID`, `FOLDER_ID` | `driveId`, `folderId` | `npm run onedrive:setup` |

`<TENANT>` is the tenant alias, uppercased with non-alphanumeric characters replaced by `_`.
For Exchange and OneDrive, `<TARGET>` is `ACCOUNT_<SHA256>`, derived automatically from the
trimmed, lowercased mailbox address or UPN; the hexadecimal digest is uppercased in `.env`
keys. No manually assigned account `id` is required or accepted. Moving an account between
groups does not change its bindings; changing its address requires regenerating or
explicitly migrating its bindings.

Teams retains configured target IDs, uppercased with non-alphanumeric characters
replaced by `_`; for example, `CONSTO__TEAMS_PROBE_002__CHANNEL_ID`
or `CONSTO__TEAMS_PAIR_002__BOT_PEER_CLIENT_ID`. `.env` holds tenant-specific IDs but no secrets, and
it is safe to delete and regenerate by re-running the setup commands (reply seeds are then
re-created). What stays in the config is listed [above](#what-the-config-holds).

## Deploy with one command

From `synthetic-tests/`:

```sh
npm ci
npm run deploy -- --plan   # local preview, no Azure changes
az login                   # the subscription in healthModel.subscriptionId
npm run deploy
```

The command reads the repository-root config and the `.env` beside it (`--config <file>`
reads another file); `--plan` names the file it read. It needs the Azure CLI (it builds
Bicep with `az bicep` and the image with `az acr build`) and Git (it records the
source revision). Each run's protected record stores the config's SHA-256. The
command refuses the placeholder `healthModel.subscriptionId` and stops before any
change unless `az` can show that subscription and its actual tenant equals
`deployment.azureTenantId` (by default the single tenant's `tenantId`). `--plan`
checks only the config: Azure permissions,
Graph access, bot routes, image availability and rollout are not verified.

Phases, in order:

1. **Preflight**, no changes: validate the config, check the Azure account, any
   `existing` foundation, worker identity and Teams bot bindings, build both Bicep
   templates and run `what-if` for ingestion, models, foundation and workers.
2. **Reporting foundation:** private configuration storage in both modes.
   Only with `logAnalytics.enabled: true`, also provision the pay-as-you-go workspace,
   `M365Synthetic_CL`, Event Hub, optional Capture, ingestion Function, DCE and DCR.
3. **Health models and worker foundation:** direct external-report signals when
   off, native KQL signals/query permissions when on. Worker identities always receive
   scoped direct-report and configuration-reader roles; Event Hub sender roles are on-only.
4. **Build and configuration:** pin the ACR worker image by digest. Build/deploy
   the ingestion Function only when on, then upload an immutable private Blob snapshot
   generated from the root configuration and its resolved `.env` bindings. This is
   a deployment artifact, not another user-maintained configuration file.
5. **Prove Exchange first:** verify current direct health reports or live observation
   ingestion, including the exact configuration hash and ready revision. Then roll out
   the remaining services and verify their selected journey scopes.
6. **Operational checks:** on enables the log-based freshness rule after ingestion
   proof. Off verifies direct reporting, allows the old pipeline to drain, and retires
   only owned Event Hub/Function/DCR resources and obsolete access. Existing workspace
   history and archived data are retained. The direct mode has no log freshness watchdog.

Completion includes ready revisions and current reports in the selected mode, not
proof that Microsoft 365 is healthy or notifications were delivered. Verify Capture,
actual model evaluation and notifications under [acceptance](#acceptance-and-cleanup). Each run
writes a protected record (what-if results, provenance) to
`.monitoring-deployment/<runId>/` in the repository root. The root `.gitignore`
already excludes that default `deployment.stateDirectory`; ignore a custom one yourself.

### The `deployment` section

| Setting | Meaning |
| --- | --- |
| `location` | Region for the foundation and workers; it must match an existing environment's actual region |
| `configurationStorageAccount` | Private hash-verified worker configuration store; required in both modes and independent of the logging pipeline |
| `healthModelLocation` | Optional region for the health models, default `location` |
| `azureTenantId` | Optional tenant that hosts the Azure resources, by default the single tenant's `tenantId` (required with several tenants); it must be the subscription's actual tenant, so set it only to host in a different tenant than Microsoft 365 |
| `stage` | `workers` (default), or `foundation` to stop after the models and foundation, for example until administrators approve the new identities |
| `enableLiveProbes` | Default `false`; see the live gates below |
| `enableBetaServiceActivity` | Default `false`; required when a service enables `serviceActivity` |
| `foundation` | `{ "mode": "create", "environmentName", "registryName" }` or `{ "mode": "existing", "environment", "registry" }`, each name a resource in the health model's resource group or a full resource ID ([names](#what-the-config-holds)) |
| `image` | `{ "mode": "build", "repository", "tag" }`, built in ACR for `linux/amd64` with the run ID appended to the tag, or `{ "mode": "existing", "reference" }`, a `registry/repository@sha256:…` digest in the configured registry |
| `workspaceName`, `applicationInsightsName` | Optional logging-mode resource names, defaulting to `law-<healthModel.name>` and `appi-<healthModel.name>`; not created for a new direct-only deployment |
| `retireEntities` | Optional `{ "service", "entityName" }` list of obsolete entities to delete after the rollout |
| `commandTimeoutSeconds`, `rolloutTimeoutSeconds`, `stateDirectory` | Defaults 1800, 300 and `.monitoring-deployment` |

### Live execution gates

Live Microsoft 365 execution is off until all of these hold:

- `tenants[].services.<service>.execution.mode` is `"live"`; the alternative,
  `"simulation"`, is labeled and makes no Microsoft 365 or Azure calls.
- `deployment.enableLiveProbes` is `true`. At the default `workers` stage, planning
  or deploying a live worker fails without it, and it makes the worker template set
  `ENABLE_LIVE_M365=true`. The runtime refuses `mode: "live"` without that variable;
  a local live run must export it.
- The live worker names an existing, administrator-approved identity in
  `worker.identity` (deployment never grants Microsoft 365 access), uses
  managed-identity health-report authentication and has the bindings its journeys
  need: Teams bot references, Exchange reply seeds and OneDrive user, drive and
  folder IDs (the generated ones come from [`.env`](#generated-ids-in-env)).
  Deployment rejects it otherwise.

Beta provider collection also needs `deployment.enableBetaServiceActivity: true`,
which sets `ENABLE_BETA_SERVICE_ACTIVITY=true`.

## Deployment status and order

**Single-user Exchange conversion:** the five-journey, aligned-minute source
change is not deployed or live-accepted by this implementation task. Historical
tenant evidence below predates that conversion and does not establish self-reply
fixture validity, current cohort capacity or current health ingestion. Re-provision
fixtures and perform the approved live acceptance separately.

First deployment with the single command, 2026-10-28: `npm run deploy` against the Consto
test tenant (existing foundation and worker apps, a private copy of the config passed with
`--config`) deployed the models and workers, rolled each worker to a new image and retired
the two obsolete `exchange-attachment-*reply-mail` entities. Read back through ARM after
the last rollout, once every lane had completed a steady-state cycle:

- **Groups:** `Central US` and `UK South` appear as named signal aggregation groups on the
  journey entities only (Central US on all 12 journeys, UK South on the 3 OneDrive ones),
  alongside External Reports, each reporting its own state. Workers published the matching
  `group-<id>--tenant-<tenant>--<signal>` reports.
- **Health:** the root model and every Experience entity were Healthy. Of 66 service-model
  entities, 63 were Healthy. The exceptions are the Exchange and Teams Service Health context
  entities, Degraded because Microsoft's own overview reports `serviceDegradation` for both
  services (Suppressed, so they do not roll up), and the optional OneDrive restore step,
  Unknown by design while `restoreVersion` is false.
- **Journeys:** every Exchange, Teams and OneDrive journey passed in the steady-state cycles
  after the final rollout, with Exchange finishing in under 10 seconds against the 15-second cap.

The run also exposed defects that mocked tests had hidden, now fixed: `az acr show` has no
`--ids` argument; Azure reports an environment's region as `Central US`, not `centralus`; and
the Teams channel readback rejected whole Graph pages once the continuation link exceeded
8,192 characters, which retained posts had grown it past. Exchange calendar journeys sat at the
15-second cap because of 2-second polling, so Exchange now polls every 500 milliseconds. A
restart can still show one Unhealthy cycle, because all lanes fire at once and Exchange may
throttle (HTTP 429); the next cycle recovers. An occasional health-report acknowledgement
still exceeds its 5-second deadline (`cancelled`) and is re-sent on the next cycle. Exchange's five
beta Service Activity functions return 403 until the provider application is granted
`ServiceActivity-Exchange.Read.All`; they are diagnostics only.

*Entries below were recorded with the earlier per-service profile files and separate
prepare and deploy commands, which the single `npm run deploy` command supersedes.*

The current scope comes from the root config and
[shared catalogue](../synthetic-tests/utils/src/catalog.ts), not the historical
deployment counts below. There are no planned journey branches. SharePoint's
health model and root reference are deleted, and its old worker has no active revision.

The dated deployment evidence below predates the independent attachment/reply
split; source changes alone do not update the running workers or live model.

The cleanup removes unsupported Teams receipt/P2P/card prototypes and unused
file-sharing/search prototypes rather than publishing hardcoded capability
failures. A source change, a successful deployment, and a successful live journey
are different acceptance gates.

Verified live deployment, 2026-10-26:

- ACR build `cja` produced immutable image
  `sha256:f96ca82926b39991b7b54b9591a7d79699e79f17620ff339d52b186a90ad4c84`.
  Exchange and Teams ready revisions are `0000015`; OneDrive is `0000002`.
  Only these new revisions are active on the selected workers.
- Integrated validation passed: 1,104 tests, TypeScript, build, 20 model contracts
  and 14 worker-infrastructure contracts.
- Stable and approved beta reports now ingest on each product's single,
  suppressed Service Health entity: seven signals each for Exchange and Teams,
  two for OneDrive. External Reports groups have no unresolved members.
  The 14 old per-API child entities and relationships were removed after the
  matching new workers published to their parent entities.
- Exact ARM inventory matches deployment outputs: root 4 entities/3
  relationships, Exchange 33/32, Teams 14/13, OneDrive 17/16; total **68/64**.
  A second provider cycle confirmed fresh parent reports and no recreation of
  retired entities.
- All six Exchange journeys completed real successful attempts on the new image.
  The second cycle ingested 100% success for all six; the meeting journey can
  still be Degraded when its measured duration exceeds the configured latency
  threshold. Its earlier cancellation-cleanup failure is fixed.
- OneDrive app-folder operations succeed. Selected-folder roundtrip and versions
  remain Unhealthy because dedicated folder IDs/resource grants are missing.
  Administrator reads of both configured test-folder paths returned 403; no IDs
  or successful operations were invented.
- Both scheduled-meeting join POSTs now succeed. Call-state verification/cleanup
  readback and channel publication readback still report real read failures;
  these live acceptance issues remain under investigation. The earlier
  primary-token permission error is not the current observed failure.
- OneDrive's approved managed-identity federation to the existing read-only
  collector is verified. Its actual `OneDriveForBusiness` / `Microsoft OneDrive`
  stable feed reports Healthy/100 on the grouped entity. Exchange and Teams
  stable feeds genuinely report Degraded/50; their denied beta calls remain
  diagnostic Unknown. OneDrive has no beta collector.
- One Exchange report acknowledgement timed out, although ARM confirms that
  exact report persisted. The failure remains logged; successful ingestion does
  not retroactively prove receipt of the acknowledgement.

Teams follow-up, 2026-10-26:

- Builds `cjb` and `cjc` contain the bounded messaging-poll fix, provisional
  call-chain handling, and compatibility with Graph's actual `playPrompt`
  response (`@odata.context`, PascalCase status and nullable diagnostics).
- Revision `0000017` is deployed with
  `sha256:33774473931abbe3a57f0fac1d9972c81ba8208f999558455f28a2d5e59075c5`.
  Exchange and OneDrive remain on the initial grouped-rollout image.
  All 1,122 tests, TypeScript and build pass.
- A real revision-16 attempt passed joining, establishment, meeting metadata,
  both rosters and both departures, exposing the playback response-format bug.
  The response-format fix does not weaken authenticated callback correlation.
- The latest observed meeting report is still Unhealthy with a permission
  failure. Full playback and complete live journey acceptance are not confirmed.
  Diagnostic calls were explicitly deleted and termination verified.

Source update, 2026-10-27 (**not deployed**): scheduled meetings now verify both
bots' establishment, meeting metadata, both rosters and both departures without
uploading or playing audio. The audio step, endpoint and playback reports are
removed from the desired model/runtime; the live revision and its last observed
failure above are unchanged.

Exchange hierarchy deployed, 2026-10-27: deployment
`exchange-mail-calendar-20261027` updated only `m365-experience-consto-exchange`
in `rg-m365-consto`, using the approved `monitoring.consto.json` profile.
Four mail journeys now roll up through **Mail** and two calendar journeys
through **Calendar**, both with native UserFlow icons. The six old direct
root-to-journey links were removed after their replacements were verified.
Journey/step IDs, workers, other service models, root references and permissions
were unchanged.

Paginated live inventory is **35 entities/34 relationships**, including the
existing suppressed Service Health branch retained unchanged by this scoped
rollout. All six journey External Reports groups resolve. Fresh mail reports
at **14:19:49 UTC** show 100% success after deployment. At verification, native
rollup was **Mail Degraded** (attachment journey mean duration 15,556 ms, above
the 15,000 ms threshold) and **Calendar Healthy**.

Do not treat partial live acceptance as proof that every journey or the
independent worker/report-freshness/notification safeguards are green.

OneDrive setup completed, 2026-10-27: both configured test accounts now have
dedicated test folders and verified Selected-folder write grants. Their real
folder bindings are persisted in the approved private root profile and deployed
OneDrive configuration. Only that worker's configuration was updated and its
existing `sh-omit-d09c316d` revision restarted; its image, service configuration,
single-replica settings and unrelated workers were unchanged.

Fresh reports at **14:54:16-14:54:18 UTC** confirm **100% success (2/2 accounts)**
for user-drive roundtrip, app-folder lifecycle and document versions. All three
journeys, all 11 required business steps and **OneDrive Experience are Healthy**.
The disabled optional restore step remains suppressed. Temporary tenant-wide
provisioning grants, applications/service principals and certificate files were
removed. Worker Graph roles remain `Files.ReadWrite.AppFolder` and
`Files.SelectedOperations.Selected`, without tenant-wide file access. See
[programmatic OneDrive setup](onedrive-setup.md) for bulk provisioning and reruns.

Stable Service Health enabled across all three products, 2026-10-27:
the canonical private root explicitly enables provider context, all three
service-level flags are enabled, and Teams' missing suppressed Service Health
entity/relationship is restored. Five unavailable beta members were removed
from Exchange's External Reports group; existing beta collection selections
were not changed. All business entities, worker images and managed identities
were preserved. Existing read-only permission and federation trusts were
verified; no permissions, credentials or trusts were added.

At **15:25 UTC**, fresh accepted v1.0 overview/issues reports confirm working
collection for every product, with no unresolved group members. **OneDrive is
Healthy/100; Exchange and Teams are Degraded/50**, reflecting Microsoft's actual
`serviceDegradation` statuses, not collection failures. These states were not
overridden to manufacture green. OneDrive's three synthetic journeys still
report 100% success for both accounts.

The existing Exchange/OneDrive images predate the project-root Service Health
field: their deployed copies retain the working `serviceHealth: true` service
setting without the unsupported root field. Adding it caused startup validation
failures, which were corrected before fresh reports were verified. The canonical
profile and newer Teams worker use explicit root enablement. Use a matching new
worker image before applying that root field to the legacy workers.

## Safe local validation

From the repository root, with the existing package dependencies restored:

```sh
npm --prefix synthetic-tests test
npm --prefix synthetic-tests run typecheck
npm --prefix synthetic-tests run build
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s health-model/tests
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s synthetic-tests/infra/tests
```

A service in `simulation` mode is labeled and does not ingest cloud health, send messages,
join calls or mutate files. A `live` service run locally needs `ENABLE_LIVE_M365=true` and
real access.

## Root configuration

The [root configuration](../monitoring.config.json) is the only file you maintain:

| Section | Owns |
| --- | --- |
| `healthModel`, `serviceHealth` | Azure destination, thresholds/report TTL and optional suppressed Service Health context |
| `logAnalytics.enabled` | The single reporting toggle: `false` for direct container health reports, `true` for the observation/KQL pipeline |
| `deployment` | Hosting region and tenant, foundation, image and live/beta opt-ins, above |
| `tenants[]` | `id`, `displayName`, `tenantId`, optional `providerClientId`, and per service `enabled`, `execution` (mode, cadence, lanes, authentication, providers), `access` (certificate references and, for Teams, bot names), `worker` (app and identity), `scenarios`, `targets` (a Teams channel target may set `channelName`, read only by setup), Teams `callTargets` (an `organizer`, read only by setup) and OneDrive `setup` |
| `tenants[].services.exchange.targets`, `….onedrive.targets` | [User groups](./monitoring-groups.md) keyed by group ID with `userGroupName` and `users`; no root groups or Teams user groups |

It holds names, choices and the few [IDs only you can supply](#what-the-config-holds),
never secrets. Model and worker deployment use this same file. Each worker downloads
its immutable, hash-verified generated Blob snapshot using managed identity, with
names expanded to resource IDs and defaults applied. Looked-up and
generated IDs stay out of it: see [`.env`](#generated-ids-in-env).

## Identity and permissions

Use an explicitly selected managed identity per service and separate
authorization for Microsoft 365 access and health reporting.

- **Exchange:** application RBAC scoped to the dedicated test mailboxes; see
  [mailbox access](../MAILBOX-SYNTHETIC-ACCESS.md). Both the one-time approval and
  extending the scope to every configured mailbox are manual
  ([`docs/setup.md`, section 4](./setup.md#4-exchange-mailbox-access)).
- **Teams messaging:** managed-identity Bot Connector authentication and a
  separate federated application with team-scoped Graph readback permission.
  No user sign-in, MFA, refresh-token cache or bot-to-bot delivery claim.
- **Teams meeting:** two explicit bot identities with `Calls.JoinGroupCall.All`,
  one dedicated meeting, signed callback verification, and independent teardown
  of both owned call legs. Meeting connectivity does not prove received audio,
  bidirectional audio or call quality.
- **OneDrive:** `Files.SelectedOperations.Selected` with write grants on the
  dedicated folders; app-folder operations separately use
  `Files.ReadWrite.AppFolder`. See [OneDrive setup](../synthetic-tests/onedrive/README.md).
- **Reporting:** workers have private configuration-reader and service-model report
  roles. With logging off, these publish all aggregated journey/action reports directly.
  When on, workers also have Event Hubs sender access; the Function has receiver,
  host/quarantine storage and DCR ingestion roles, and model identities query the workspace.
  The root reads its nested models in both modes.

There is no silent CLI, user, certificate or credential fallback. Explicit
certificate options for local application access remain separate from hosted
managed-identity execution.

## Container Apps boundary

`npm run deploy` deploys the selected reporting foundation and [health models](../health-model/README.md),
then the [worker foundation](../synthetic-tests/infra/README.md) and image.
Only the enabled logging mode deploys an ingestion Function.
It proves fresh Exchange reports before rolling out Teams and OneDrive. Workers reuse an
existing approved environment and identities when `deployment.foundation.mode` is
`existing`, run an immutable image digest and download the same root-config snapshot.

Only scheduled Teams meetings need public HTTPS callback ingress. Background
journey execution is not a long-lived ingress request. Lanes run independently
with bounded execution and cleanup; a timeout is a failed attempt, while
unexecuted dependent steps are not extra failed requests.

`logAnalytics.enabled` controls the entire log path, not just an exporter.
Off reports directly from containers and does not use a logging pipeline.
On uses Event Hubs, the managed-identity Function/DCR bridge and pay-as-you-go workspace,
with optional Capture and the five administrator saved searches. See
[Log Analytics for administrators](./operations.md#log-analytics-for-administrators).
Microsoft-reported provider data
remains separate, suppressed Service Health context; see
[provider configuration](./provider-monitoring.md).

## Acceptance and cleanup

1. Check the config (the plan names the file; the run record stores its SHA-256),
   selected identities, immutable image digest and ready revision on each worker.
2. Observe at least two real cycles, including required assertions and owned
   artifact/call cleanup.
3. Read the ingested reports from every expected journey/action entity. A
   successful deployment or log line alone is insufficient.
4. Reconcile exact live entity and relationship IDs against the selected catalog.
   Incremental ARM deployments do not delete retired child resources.
5. Delete only identified retired relationships and entities; never remove a
   whole active model to fix a child migration. List them in
   `deployment.retireEntities`: after a verified rollout the command deletes each
   listed entity and its relationships, and refuses entities the catalogue still
   supports.
6. Verify worker/report freshness and notifications independently before claiming
   production readiness. Current live acceptance does not establish those
   operational safeguards.

## Teams live verification — 2026-10-27

*Recorded with the earlier per-service profile files; `npm run deploy` now deploys the
models and workers from the single root config.*

Only the Teams model and worker were deployed from the approved
`monitoring.consto.json` / `teams.consto.bot.live.json` profiles. ACR build `cjh`
produced immutable image
`sha256:763ebdcaf5b3fc5338850818a0a9cb47708cf624225069e95f185a213b845ac1`,
deployed as revision `m365-ctbcoa-teams--0000018`, config revision `rotd6sga77wp2`.
It is the sole active normal revision; identities, mounts, probes and routing
were preserved. The former diagnostics export and root-default Service Health remained disabled.

Real meetings ended at **14:49:54.562** and **14:51:55.130 UTC** after both
bots joined, established, verified metadata/both rosters, reconfirmed established
state and independently departed. ARM readback confirms all five steps at 100%,
with actual durations and matching cycle IDs. Channel journeys also succeeded.
Exact Teams inventory is **12 entities/11 relationships** after retiring only its
former audio-playback and disabled Service Health branches; six call External Reports
members remain. At **15:02:33 UTC**,
old playback/placeholder reports had expired naturally and every Teams entity,
including both native journey rollups and the Teams Experience, was Healthy. No
external signal definitions were rewritten.

Reporting is **not fully green**: the 14:48–14:52 UTC window contained 11 cancelled
acknowledgements across three cycles. Three exact reports subsequently persisted;
earlier overwritten statuses cannot establish receipt. The existing five-second
request deadline remains unchanged. Container Apps exec returned
`ErrorGeneratingAuthToken`; credential-free ACR run `cjj` verified the exact
image's CLI `--help` instead. Local Docker was unavailable.

A later preflight (15:19–15:24 UTC) detected an unexpected concurrent write to the
Teams app at 15:19:13 UTC and a restart at 15:19:33 UTC. App template and routing
metadata still matched the saved snapshot, but mounted-secret equality could not be
assumed. The previously retired Teams Service Health entity and relationship also
reappeared: observed inventory was **13 entities/12 relationships**, not the 12/11
baseline. Neither external change was reverted; reconcile the external writer before
the next change. Fresh normal meetings ended at 15:21:53.583 and 15:23:53.839 UTC with
all five steps and both departures verified.

The primary bot still holds a `CallRecords.Read.All` grant from the former quality
collector; it was verified and retained, and no grants were added. Nothing in this
repository uses it any more, and an administrator may revoke it.
