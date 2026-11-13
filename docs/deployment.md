# Set up and deploy

The flow is driven by root [monitoring.config.json](../monitoring.config.json)
and the service files in its `serviceFiles` map:

1. **Configure** root Azure/health settings and each service's accounts, targets, scenarios, cadence and reporting
   [`groups`](./monitoring-groups.md). It names things and holds only the few IDs you
   must supply ([what the config holds](#what-the-config-holds)).
2. **Set up Azure and Microsoft 365** using the shared foundation and separate
   service authorization/provisioning guides ([below](#set-up-microsoft-365)).
3. **Deploy** the health models, execution Functions and scheduled dispatcher with `npm run deploy`
   ([below](#deploy-with-one-command)).

The config is the real configuration of this repository's Consto test tenant and may be
checked in; it holds your choices, names and a few IDs, never secrets. The IDs that setup
looks up or generates live in a gitignored [`.env`](#generated-ids-in-env) beside it, not
in the config.

The config uses JSON syntax with `//` and `/* ... */` comments (JSONC), keeping its
existing filename. Setup, deployment and worker commands accept comments; uploaded worker
snapshots remain standard JSON. Invalid syntax and trailing commas are rejected.

## What the config holds

The config **names** things, an Azure resource by its name and an account by its address;
IDs are derived or looked up. Service settings below are the matching
`tenants[].config` in each `monitoring.<service>.json`, composed into
`tenants[].services.<service>` at load time.

**Azure resources.** A bare name is a resource in `healthModel.resourceGroup` of
`healthModel.subscriptionId`. A value starting with `/subscriptions/` is a full resource ID,
for a resource in another resource group or subscription.

| Key | Names |
| --- | --- |
| `deployment.foundation` | `{ "mode": "existing", "environment": "<name or ID>", "registry": "<name or ID>" }`; `create` mode names the ones to create |
| Service `config.identity` | Existing, administrator-approved execution UAMI, attached to its service's Function app |
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

The optional OneDrive `config.setup` block selects the separate provisioning
identity, concurrency and deadline ([OneDrive setup](./onedrive-setup.md#plan-apply-and-rerun)).

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
For SharePoint, configure actual site URL/library/folder/list names in ungrouped
`config.targets[]`; `-SharePointOnly` launches read-only PowerShell discovery in a
disposable job as the selected service UAMI. It writes all four IDs to `.env`;
resource readback alone is not proof of completed journeys.

## Set up Microsoft 365

Start with [shared Azure prerequisites and Function authentication](./setup.md).
Microsoft 365 authorization/setup is split by service:

| Service | Accounts/resources, authentication and setup commands |
| --- | --- |
| Exchange | [Mailbox RBAC and retained reply fixtures](./exchange-permissions.md); `npm run setup:reply-seeds` |
| Teams | [Bot registrations, readback/RSC, calling and installed apps](./teams-permissions.md); `npm run setup:ids` |
| OneDrive | [Runtime permissions](./onedrive-permissions.md) and [separate folder provisioning](./onedrive-setup.md); explicit `-Apply -GrantTemporaryPermission` approval |
| SharePoint | [Selected-site consent, fixtures and read-only discovery](./sharepoint-permissions.md); `npm run setup:ids -- -SharePointOnly` |
| Optional provider data | [Separate read-only application roles and federation](./provider-monitoring.md#provider-authentication) |

Operator Azure CLI sessions orchestrate one-off jobs; Graph calls inside those
jobs use the explicitly selected managed identity. OneDrive alone requests an
explicitly approved transient tenant-wide provisioning grant and revokes it
afterward. No helper grants standing runtime Microsoft 365 consent automatically.
Generated bindings are merged into the root-adjacent `.env`.

### Generated IDs in `.env`

The setup commands write the IDs they look up or generate to `.env` next to
`monitoring.config.json` (the repository root), one `KEY=value` per line, so the config
keeps only what you choose. `npm run deploy` and every TypeScript command read it
automatically and fill the matching fields; leave those fields out of the config, because
deploy fails and names the conflict when the config sets one to a different value.

| Where | Keys, each `<TENANT>__<TARGET>__…` | Fills | Written by |
| --- | --- | --- | --- |
| Exchange target | `REPLY_SEED_MESSAGE_ID`, `REPLY_SEED_CORRELATION_ID` | `replySeed` | `npm run setup:reply-seeds` |
| Teams channel target | `CHANNEL_ID` | `channelId` | `npm run setup:ids` |
| Teams call target | `ORGANIZER_USER_ID` | `organizerUserId` | `npm run setup:ids`, from the target's `organizer` |
| Teams bot pair (`<TARGET>` is the pair ID) | `BOT_CLIENT_ID`, `BOT_PEER_CLIENT_ID` | `botPairs[].botClientId`, `botPairs[].botPeerClientId` | `npm run setup:ids`, from that pair's `identity` and `peerIdentity` |
| Teams service (`<TARGET>` is `TEAMS`) | `CALLING_CALLBACK_URL` | `execution.teamsCallingCallbackUrl` | `npm run setup:ids`, from the deployed Teams Function hostname |
| OneDrive target | `USER_ID` | `userId` | `npm run setup:ids`, from `userPrincipalName` |
| OneDrive target | `DRIVE_ID`, `FOLDER_ID` | `driveId`, `folderId` | `npm run onedrive:setup -- -Apply -GrantTemporaryPermission` |
| SharePoint target | `SITE_ID`, `DRIVE_ID`, `FOLDER_ID`, `LIST_ID` | `siteId`, `driveId`, `folderId`, `listId` | `npm run setup:ids -- -SharePointOnly` |

`npm run setup:function-auth` also writes the global `FUNCTION_API_CLIENT_ID` and
`COORDINATOR_CLIENT_ID` bindings for scheduled Function dispatch. These are
non-secret IDs, separate from service Graph authorization.

`<TENANT>` is the tenant alias, uppercased with non-alphanumeric characters replaced by `_`.
For Exchange and OneDrive, `<TARGET>` is `ACCOUNT_<SHA256>`, derived automatically from the
trimmed, lowercased mailbox address or UPN; the hexadecimal digest is uppercased in `.env`
keys. No manually assigned account `id` is required or accepted. Moving an account between
groups does not change its bindings; changing its address requires regenerating or
explicitly migrating its bindings.

SharePoint uses `SHAREPOINT_<SHA256>` derived from normalized site URL,
library/folder/list names. No manually assigned target `id` is accepted.
Changing location choices requires rediscovery; old bindings do not silently
authorize another location. Discovery verifies the site's URL, library membership,
existing direct-child folder and ordinary list. It creates none of them.

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
az login                   # approved tenant/subscription in the root config
npm run setup:function-auth # first-time Function API/dispatcher preparation
npm run deploy
```

Every execution Function app uses its own on-demand Flex Consumption plan.
There is no Premium or always-ready baseline. During upgrades, deployment
first grants the operator Blob Data Contributor on the execution-state container,
pauses the coordinator, and conditionally retires unclaimed starts. It waits for
running mutations to settle and refuses ambiguous ownership. A superseded
Durable delivery cannot claim execution or repeat its business operations.

Selected synthetic journeys run every ten minutes with a four-minute journey
deadline; provider schedules remain independent. Verification requires every
selected case to complete and reach its reporting destination.

Azure does not support moving an existing Flex app to another plan. To replace
incorrectly shared hosting, choose a new `deployment.functions.appName`, stop the
old apps after their executing mutations settle, and deploy replacements from
the same root configuration. Keep old resources stopped until recovery is
verified; do not delete journals, queues or unrelated resources.

The command reads the repository-root config and the `.env` beside it (`--config <file>`
reads another file); `--plan` names the file it read. It needs the Azure CLI (it builds
Bicep with `az bicep` and the image with `az acr build`) and Git (it records the
source revision). Each run's protected record stores the config's SHA-256. The
command refuses the placeholder `healthModel.subscriptionId` and stops before any
change unless `az` can show that subscription and its actual tenant equals
`deployment.azureTenantId` (by default the single tenant's `tenantId`). `--plan`
checks only the config: Azure permissions,
Graph access, bot routes, image availability and rollout are not verified.
Operator Graph, Blob and Function publishing requests explicitly use the root
subscription's signed-in account; no global Azure CLI account switch or basic
publishing credentials are required.

Phases, in order:

1. **Preflight:** verify the root-composed configuration, Azure tenant/subscription,
   Function API, selected identities and Teams bot bindings. Build Bicep and run
   `what-if` before cloud mutations.
2. **Configuration/reporting foundation:** private configuration storage in both
   modes; workspace/table/DCE/DCR only when Log Analytics is selected.
3. **Models and Function hosts:** establish service/root health models and
   execution infrastructure before starting recurring cases.
4. **Resolved configuration:** upload the immutable, hash-verified snapshot
   composed from root/service files and `.env` bindings.
5. **Execution and dispatch (`stage: "all"`):** deploy Function packages, pin the
   coordinator image and start scheduled case dispatch. `foundation` stops before
   this recurring execution stage.
6. **Verification:** check dispatcher/execution evidence and selected-mode report
   publication; retain protected deployment provenance.

Completion does not prove Microsoft 365 is healthy or notifications were delivered.
Verify actual model evaluation and notifications under [acceptance](#acceptance-and-cleanup). Each run
writes a protected record (what-if results, provenance) to
`.monitoring-deployment/<runId>/` in the repository root. The root `.gitignore`
already excludes that default `deployment.stateDirectory`; ignore a custom one yourself.

Report verification allows the longest selected start interval plus its whole-cycle
bound, then the existing `deployment.rolloutTimeoutSeconds` allowance for ingestion
or model visibility. With the 300-second cadence, 299-second cycle bound and default
300-second allowance, each service's observation/direct-report check can wait
899 seconds (14 minutes 59 seconds). Container readiness still has its separate
300-second rollout deadline; it is not proof of completed journeys.

### The `deployment` section

| Setting | Meaning |
| --- | --- |
| `location` | Region for the foundation and workers; it must match an existing environment's actual region |
| `configurationStorageAccount` | Private hash-verified worker configuration store; required in both modes and independent of the logging pipeline |
| `healthModelLocation` | Optional region for the health models, default `location` |
| `azureTenantId` | Optional tenant that hosts the Azure resources, by default the single tenant's `tenantId` (required with several tenants); it must be the subscription's actual tenant, so set it only to host in a different tenant than Microsoft 365 |
| `stage` | `all` for execution packages and scheduled dispatch, or `foundation` to establish models/infrastructure before Microsoft 365 setup |
| `functions`, `coordinator` | Function host/storage/API settings and the scheduled Container App dispatcher/identity |
| `enableLiveProbes` | Default `false`; see the live gates below |
| `enableBetaServiceActivity` | Default `false`; required when a service enables `serviceActivity` |
| `foundation` | `{ "mode": "create", "environmentName", "registryName" }` or `{ "mode": "existing", "environment", "registry" }`, each name a resource in the health model's resource group or a full resource ID ([names](#what-the-config-holds)) |
| `image` | `{ "mode": "build", "repository", "tag" }`, built in ACR for `linux/amd64` with the run ID appended to the tag, or `{ "mode": "existing", "reference" }`, a `registry/repository@sha256:…` digest in the configured registry |
| `workspaceName`, `applicationInsightsName` | Optional logging-mode resource names, defaulting to `law-<healthModel.name>` and `appi-<healthModel.name>`; not created for a new direct-only deployment |
| `retireEntities` | Optional `{ "service", "entityName" }` list of obsolete entities to delete after the rollout |
| `commandTimeoutSeconds`, `rolloutTimeoutSeconds`, `stateDirectory` | Defaults 1800, 300 and `.monitoring-deployment`; rollout timeout also supplies the report-visibility allowance after the next start interval and bounded cycle |

### Live execution gates

Live Microsoft 365 execution is off until all of these hold:

- The service file's `tenants[].config.execution.mode` is `"live"`; the alternative,
  `"simulation"`, is labeled and makes no Microsoft 365 or Azure calls.
- `deployment.enableLiveProbes` is `true`. At the `all` stage, planning
  or deploying live execution fails without it, and it makes the Function template set
  `ENABLE_LIVE_M365=true`. The runtime refuses `mode: "live"` without that variable;
  a local live run must export it.
- The live service names an existing, administrator-approved identity in
  `config.identity` (deployment never grants Microsoft 365 access), uses
  managed-identity health-report authentication and has the bindings its journeys
  need: Teams bot references, Exchange reply seeds, OneDrive user/drive/folder
  IDs and SharePoint site/drive/folder/list IDs (the generated ones come from [`.env`](#generated-ids-in-env)).
  Deployment rejects it otherwise.

Beta provider collection also needs `deployment.enableBetaServiceActivity: true`,
which sets `ENABLE_BETA_SERVICE_ACTIVITY=true`.

## Deployment status and order

**Current timing policy:** every selected Exchange, Teams, OneDrive and SharePoint journey has a
240-second execution deadline and 300-second cadence; Exchange remains aligned.

**SharePoint source implementation:** document roundtrip/integrity,
prior-version bytes and list-item lifecycle are implemented.
The checked-in selection enables one approved Team-backed site and dedicated
library-folder/list fixtures with an explicitly selected worker UAMI. Resource
IDs remain in `.env`, not root configuration. Administrative fixture/grant
metadata does not establish worker access: after the canonical deployment,
complete read-only discovery as that worker identity against its immutable
configuration, and verify deployed journeys, cleanup and ingestion.
This integration performs no Azure/Graph mutations or live deployment.

These source/config changes are not deployed or live-accepted by this implementation task. Historical
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
deployment counts below. There are no planned journey branches. The earlier
SharePoint prototype was retired; the implemented document/list journeys now
select a catalog-driven model and independent worker only when explicitly enabled.

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
npm --prefix synthetic-tests run catalog:check
npm --prefix synthetic-tests run typecheck
npm --prefix synthetic-tests run build
npm --prefix synthetic-tests run deploy -- --plan
az bicep build --file health-model/infra/main.bicep --stdout > /dev/null
az bicep build --file health-model/infra/observation-alerts.bicep --stdout > /dev/null
az bicep build --file synthetic-tests/infra/main.bicep --stdout > /dev/null
```

There is no maintained test suite or additional test-tool dependency. Focused
offline assertions may inject fake transports; they do not prove live access.
A service in `simulation` mode is labeled and does not ingest cloud health, send messages,
join calls or mutate files. A `live` service run locally needs `ENABLE_LIVE_M365=true` and
real access.

## Root configuration

The [root configuration](../monitoring.config.json) references the four
service files. Together they are the user-maintained project configuration:

| Section | Owns |
| --- | --- |
| `healthModel`, `serviceHealth` | Azure destination, thresholds/report TTL and optional suppressed Service Health context |
| `logAnalytics.enabled` | The single reporting toggle: `false` for direct Function health reports, `true` for direct Logs Ingestion API/DCR observations and KQL |
| `deployment` | Hosting region and tenant, foundation, image and live/beta opt-ins, above |
| Root `tenants[]` | `id`, `displayName`, `tenantId`, optional provider application ID |
| `serviceFiles` | Paths to the Exchange, Teams, OneDrive and SharePoint files; each matching `tenants[].config` owns identity, enabled/scenarios, execution and targets |
| Exchange/OneDrive `config.targets` | [User groups](./monitoring-groups.md) keyed by group ID with `userGroupName` and `users`; no root groups or Teams user groups |
| SharePoint `config.targets` | Ungrouped actual site URL/library/folder/list names; no users, arbitrary target IDs or per-target models |

It holds names, choices and the few [IDs only you can supply](#what-the-config-holds),
never secrets. Model and worker deployment use this same file. Each worker downloads
its immutable, hash-verified generated Blob snapshot using managed identity, with
names expanded to resource IDs and defaults applied. Looked-up and
generated IDs stay out of it: see [`.env`](#generated-ids-in-env).

## Identity and permissions

Use an explicitly selected managed identity per service and separate
authorization for Microsoft 365 access and health reporting.

- **Exchange:** application RBAC scoped to the dedicated test mailboxes; see
  [Exchange permissions](./exchange-permissions.md). Both the one-time approval and
  extending the scope to every configured mailbox are manual
  ([Exchange scope maintenance](./exchange-permissions.md#maintain-the-approved-mailbox-scope)).
- **Teams messaging:** managed-identity Bot Connector authentication and a
  separate federated application with team-scoped Graph readback permission; see
  [Teams permissions](./teams-permissions.md).
  No user sign-in, MFA, refresh-token cache or bot-to-bot delivery claim.
- **Teams meeting:** two explicit bot identities with `Calls.JoinGroupCall.All`,
  one dedicated meeting, signed callback verification, and independent teardown
  of both owned call legs. Meeting connectivity does not prove received audio,
  bidirectional audio or call quality.
- **OneDrive:** `Files.SelectedOperations.Selected` with write grants on the
  dedicated folders; app-folder operations separately use
  `Files.ReadWrite.AppFolder`. See [OneDrive permissions](./onedrive-permissions.md)
  and [bulk setup](./onedrive-setup.md).
- **SharePoint:** application `Sites.Selected` plus administrator-approved `write`
  on the designated test site; same-tenant explicit managed identity only.
  Site/library/folder/list provisioning and consent remain manual. See
  [SharePoint permissions](./sharepoint-permissions.md).
- **Reporting:** execution Functions have private configuration-reader and
  service-model report roles. With logging off, they publish journey/action reports
  directly. When on, their selected identities have DCR ingestion access and send
  observations directly through the Logs Ingestion API; model identities query the workspace.
  The root reads its nested models in both modes.

There is no silent CLI, user or credential fallback. Live managed-identity runs
need an Azure host with the selected identity attached; a laptop does not provide
that endpoint. Follow the [tenant-binding requirements](./cross-tenant-access.md).

## Container Apps boundary

The Container App only schedules authenticated Function invocations; it does not
run Graph journeys, collect results or aggregate health. Service Function apps
execute cases independently and publish results using their selected identities.
Keep deployment packages, coordinator image and the immutable resolved snapshot
from the same approved deployment.

Only scheduled Teams meetings need public HTTPS callback ingress. Background
journey execution is not a long-lived ingress request. Lanes run independently
with bounded execution and cleanup. All selected Exchange, Teams, OneDrive and SharePoint
journeys run every ten minutes and allow 240 seconds per complete journey.
Latency becomes Degraded above 15000 ms, with a 30000 ms Teams
channel-conversation override; latency alone never becomes Unhealthy.
Provider lanes remain at 60 seconds.
Genuine journey deadline expiry is a failed attempt; worker cancellations and
cleanup-only failures report Unknown. Unexecuted dependent steps are not extra
failed requests, and confirmed business-step evidence is preserved.
Exchange reserves 12 seconds for cleanup settlement and 12 for publication;
Teams/OneDrive/SharePoint reserve 12 and 30. All use a 599-second whole-cycle envelope,
including initialization. The non-Exchange cycle budget defaults to 252 seconds;
the checked-in Teams concurrency is six so all six attempts fit one wave, while
OneDrive's two accounts per lane fit its default concurrency three.
Actual cleanup remains independently bounded to ten
seconds. Graceful shutdown permits bounded reporting, but cannot extend the hard
slot deadline.

`logAnalytics.enabled` controls the reporting path, not just an exporter.
Off reports directly from execution Functions without a logging pipeline.
On sends observations directly through the Logs Ingestion API/DCR to the
pay-as-you-go workspace. Neither mode uses Event Hubs, Capture or an intermediary
ingestion Function. See
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
