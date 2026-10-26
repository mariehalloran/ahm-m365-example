# Microsoft 365 synthetic tests

**Run a test, aggregate its actions, report health, repeat.** Each service has its own config and cadence; one root configuration selects services, journeys, targets, and report policy.

This directory is the self-contained Node project. For why synthetic journeys complement Microsoft-reported health and how Azure Monitor Health Models exposes experience gaps, see the [repository overview](../README.md).

Start with the service-owned journey guides: [Exchange six core mail/calendar journeys](./exchange/README.md), [Teams target families and current bot/signaling coverage](./teams/README.md#target-catalog-versus-current-implementation), and [SharePoint target families and current save/rename coverage](./sharepoint/README.md#target-catalog-versus-current-implementation). Each separates implemented operations from the target catalog and live evidence. These are API-backed journeys, not browser/desktop or employee sign-in tests. HTTP-level tests assume approved access; no successful tenant journey or employee receipt is established by those tests. Calling health does not prove that each recipient rang.

```text
Exchange Container App   [mail 60s; five other journeys 300s]    --+
Teams Container App      [test + aggregation, every 120 seconds] --+
SharePoint Container App [test + aggregation, every 300 seconds] --+
                                                                |
                            Direct health reports to service model entities
                                                                |
                                    Root model of service health models

```

The [health model templates](../health-model/README.md) create a root referencing service models, including a planned-only OneDrive model. The complete catalog has **five models, 180 entities and 175 relationships**: eleven implemented and 23 planned journey roots, with 40 implemented and 78 planned steps. Target attempts aggregate without per-user signal inventories; existing IDs stay unchanged. Implemented journeys/steps have **External Reports**, plus optional **OpenTelemetry**; planned nodes have no reports, stay Unknown and are suppressed from synthetic rollup. Token acquisition and generic cleanup remain internal; explicit deletion/cancellation/hang-up are business steps. Use the [shared worker deployment](./infra/README.md) and [model migration](../health-model/README.md#apply-and-migrate).

Each service has its own Container App and cadence. Console diagnostics remain in that same process; no separate telemetry service or Kubernetes requirement is introduced.

## Catalog, implementation and live evidence

A journey family is a completed workflow, not a fixed number of API calls. Exchange
implements six core families; Teams and SharePoint each have five target families
but only narrower implemented coverage, detailed in their service guides. Live
Exchange mail, draft, attachment/reply and DL fanout are verified Healthy; its two
calendar journeys currently fail with 403 pending scoped-authorization cache propagation.
Teams live verification covers one-bot publication/reply with a Graph observer and
signaling-only calls to three accounts, not a second bot receiving or answered audio.
SharePoint save/rename handlers exist but approved live targets are missing.
See [live evidence](../docs/deployment.md#deployment-status-and-order), not unit tests,
for execution and ingestion acceptance.

Graph persisted readback is not Bot B receipt; owner access is not recipient access;
call signaling is not media; APIs are not browser experience. Future families and
optional variants below and in service guides are **not implemented or selectable**
unless explicitly listed as current root scenarios.

### OneDrive target catalog (planned)

There is no OneDrive worker, root scenario selection or live verification
yet. Keep this catalog here until implementation exists; no empty service folder is needed.

| Planned family | Completed-workflow target |
| --- | --- |
| User-drive roundtrip | Create folder/file in an approved user's drive, reopen/download, verify hash, delete owned artifacts |
| App-folder lifecycle | Write, read, update, verify and delete app-folder data; exact authentication/authorization model pending validation |
| Recipient sharing | Create sharing link/grant, read as the intended recipient, verify content, revoke and verify access removal |
| Document versions | Update, enumerate history, retrieve/verify an earlier version; restore is optional |
| Search and retrieve | Wait for indexing, find the owned file, retrieve it and verify content |

An optional browser variant is also planned. Cadences, permissions and host design
are not yet implemented; SharePoint API coverage must not be relabeled as OneDrive coverage.

## Run locally

Requires Node.js 22 or 24 and npm. From the repository root, enter this project:

```sh
cd synthetic-tests
npm ci
npm run exchange -- --once
# Remove --once to repeat on Exchange's cadence.
npm run exchange
# Another terminal/process runs SharePoint independently.
npm run sharepoint
# Or run one safe Teams simulation.
npm run teams -- --once
```

Checked-in configs use **simulation** and **console output**: reports are previews, with no real email/files, Azure ingestion, or local state writes. Stop with Ctrl+C.

All remaining npm and compiled-worker commands in this guide run from `synthetic-tests/`. From the repository root, `npm --prefix synthetic-tests run <command>` selects the same project without changing directories.

## Configure the project and each service

[monitoring.config.json](../monitoring.config.json) is the authoritative top-level configuration:

| Root setting | Meaning |
| --- | --- |
| `services.<service>.enabled` | Enable Exchange, Teams, or SharePoint; all default to `true` |
| `services.<service>.scenarios` | Select journeys independently: Exchange `send-receive-mail`/`edit-reopen-draft`/`attachment-reply-mail`/`distribution-list-mail`/`recurring-calendar`/`meeting-invitation`, Teams `publish-channel-message`/`reply-channel-message`/`call-test-user`, SharePoint `save-reopen-file`/`rename-reopen-file`; checked-in root selects all |
| `services.<service>.targets` | Account email addresses or approved site/team/channel IDs, never credentials |
| `services.teams.callTargets` | Separate individual user allowlist: `id`, `tenantId`, `callUserId` (object UUID), three users in the sample; no channel metadata |
| `services.<service>.configFile` | Service-owned file for independent cadence, timeout, mode, authentication and provider settings; relative to the root config's directory |
| `healthModel` | Root model name, subscription/resource group, report TTL, and success/mean-duration thresholds |
| `otel` | Optional export: `enabled: false` by default; destination `console` or `azure-monitor` |

Service/scenario selection, targets, and report policy are configured **only in the root file**. The service-file parser rejects duplicate `enabled`, `targets`, and obsolete `telemetry` keys instead of silently ignoring them. Root service/scenario switches disable execution before credentials are initialized. A reusable lane engine runs within each service worker, not across services. Exchange defaults to independent 60-second mail and 300-second extended lanes; service-owned `executionLanes` can set cadence/deadlines. Root Exchange targets add explicit `recipientMailbox` and `distributionList: { address, expectedRecipients }`; see [Exchange migration](./exchange/README.md). Omitted new scenario keys in older profiles default off; missing setup for a selected live journey fails observably. Live execution and beta/provider permissions remain separate safety gates.

Each service accepts up to 30 configured targets; Teams separately accepts up to
30 call targets. Selected journeys expand targets into independent attempts:
30 messaging targets across two journeys plus 30 calls produce up to 90 Teams
attempts in one cycle, aggregated into fixed journey/action signals.

| Config | Cadence | Default |
| --- | --- | --- |
| [Exchange](./exchange/config.json) | Mail 60 seconds; five other core journeys 300 seconds | Simulated mail/calendar results |
| [SharePoint](./sharepoint/config.json) | 300 seconds | Simulated file result |
| [Teams](./teams/config.json) | 120 seconds | Simulation; live defaults to an installed same-tenant managed-identity bot |

```json
{
  "type": "exchange",
  "intervalSeconds": 60,
  "timeoutSeconds": 45,
  "mode": "simulation",
  "graphAuthentication": "managed-identity",
  "cohort": "exchange-global"
}
```

Restart a worker after editing its file. Separate services do not share a scheduler.
The reusable asynchronous lane runner executes independent journeys/targets concurrently
and reports settled results. Each lane never overlaps itself; missed slots are skipped,
not queued into catch-up bursts. Run one instance per target set until distributed ownership is implemented.

Each command reads the root config (default `../monitoring.config.json` from this Node project), then the selected `configFile`. Use `--project-config <file>` for a private/mounted root config and `--config <file>` to override only the service file. The latter path is relative to the process working directory; root `configFile` paths are relative to the project config. A service entry rejects another service's config before credentials or operations are initialized.

### Per-cycle health reports

After each settled lane cycle, aggregate actual attempts separately for each journey and business action. Send `synthetic-success-percentage`/`synthetic-mean-duration` to that journey's entity and each journey-scoped business-step entity in `<root-model-name>-<service>`. Selected journeys share a product worker, not necessarily a cadence; service-owned lanes set cadence/deadlines while root config selects scenarios and targets. Defaults remain below 99%/95% success and above 15/60 seconds mean duration for Degraded/Unhealthy; these are demo thresholds, **not per-action SLOs or p95 latency**.

Executed failures and execution timeouts count as zero success; timeouts report Unhealthy, not Unknown. Unexecuted dependent steps are not failed requests: skipped/unobserved actions have no artificial samples and receive Unknown reports without a numeric value. No aggregation history is retained across cycles. Simulation only prints `health-report-preview`; live mode publishes direct ARM health reports and console diagnostics. Publication failures remain explicit.

Reports default to a 15-minute TTL and are replaced each cycle. Settled execution-deadline failures are reported, not discarded as incomplete; external shutdown must not publish a healthy partial aggregate. Expiry **removes** external signals; it does not guarantee Unhealthy or an alert. Independently detect stopped/stalled execution and broken publication. Reports are current-cycle aggregates, not a full metrics store, percentile history, or arbitrary logs query interface; means alone cannot reconstruct weighted historical statistics.

Live hosted workers do not substitute simulations when resources are unready. Real API/authorization failures make the journey unsuccessful. Valid-but-incomplete setup is reported as an actual unexecutable initialization failure: the journey gets a zero-success/Unhealthy report and unexecuted action signals remain Unknown. Recurring workers retry initialization on their service cadence; `--once` still fails after publishing. Invalid schemas and unavailable report credentials can prevent publication entirely.

### Optional OTEL

Configure OTEL only in the root file; service files still reject the obsolete `telemetry` key. With `otel.enabled: true`, `destination: console` adds `otel-log` and `probe-metrics` records without Azure I/O. `destination: azure-monitor` requires `APPLICATIONINSIGHTS_CONNECTION_STRING`; the shared hosting template supplies it from the optional Application Insights component as a secret. Direct reports and existing console results always remain enabled.

Logs retain service/journey/action attribution, correlation IDs and explicit live/simulation modes. Metrics record binary success and measured durations, with skipped actions excluded and internal authentication/cleanup steps omitted. Provider observations are logs only. Export failures do not fabricate failed service operations or prevent direct report attempts; one-shot commands fail explicitly. See [lifecycle, measurement and dependency details](./utils/README.md#optional-opentelemetry).

## Optional Microsoft-reported context

Provider collection is read-only and runs once per service worker cycle in the existing process—not once per journey or target. Safe simulation configs keep it off; the live examples enable stable Service Health. Collection is independent of journey initialization, so missing targets/bot credentials do not block the Graph attempt. Explicit permission/collection errors are logged; no Microsoft health is fabricated. Provider data never changes journey results or the 1/0 synthetic/step measurements.

- `serviceHealth: true` reads stable `/v1.0/admin/serviceAnnouncement/healthOverviews` and `/issues` for the exact subscribed service name. Overview status reports directly to `${service}-service-health` as `microsoft-reported-service-status` in **External Reports**: **100 healthy, 50 degraded, 0 interruption**, with `impactSuppressed`. Failed/missing/unknown overview status produces Unknown without a value and with failure context. The existing trial observes Graph 403 until `ServiceHealth.Read.All` admin consent is granted. Issues/history remain console diagnostics and do not populate health signals.
- `serviceActivity: { "enabled": true, "aggregationIntervalMinutes": 15, "lookbackMinutes": 30 }` additionally requires **`ENABLE_BETA_SERVICE_ACTIVITY=true`**. Five approved Exchange and five Teams beta functions provide experimental supporting context. Approved status/percentage mappings and explicitly configured thresholds can publish direct suppressed Service Health reports; activity counts remain diagnostic unless thresholds are configured. They never supply synthetic samples or Experience/journey health. SharePoint beta configuration is rejected because no SharePoint-specific report is verified.
- Live mode still requires `ENABLE_LIVE_M365=true` and separately approved application permissions: `ServiceHealth.Read.All`, and optionally `ServiceActivity-Exchange.Read.All` or `ServiceActivity-Teams.Read.All`. These are additional provider permissions, not replacements for scoped journey access. Nothing grants them automatically. Tenant eligibility/enablement must be confirmed.

Business Basic can support the API-backed synthetics and stable Service Health where the subscribed service (including an appropriate Teams SKU) and administrator-approved access exist. Do **not** assume beta report entitlement on Basic: its API pages document permissions, not explicit Basic eligibility. Microsoft's separate [advanced Microsoft 365 monitoring](https://learn.microsoft.com/microsoft-365/enterprise/microsoft-365-monitoring) requires at least 5,000 qualifying Office 365/Microsoft 365 E3/E5 licenses and 50 monthly active users for a core service; that published monitoring eligibility is not proof of beta API entitlement. Confirm report availability with the tenant administrator.

Stable and beta collectors use independent provider lanes inside existing service
containers (`providerIntervalSeconds`, default **300 seconds**), separate from user journeys.
Beta collection currently receives 403, never fabricated Healthy. Simulation skips
configured sources without Graph credentials/network or fabricated Microsoft health.
Provider failures (including missing/invalid data, permission errors, throttling,
and bounded pagination) are explicit sanitized console diagnostics and summary failure
counts, not successful empty snapshots. Historical overlapping beta windows are not
synthetic counters or success rates. OTEL remains optional.

See the [exact configuration, diagnostic contract and bounds](./utils/README.md#optional-provider-collectors) and [measurement semantics](./utils/README.md#measurement-semantics). Each attempt contributes one binary success observation (1 or 0); total duration stays separate from request and confirmed delivery/publication durations. Reports aggregate separately by journey/business step, never by per-target dimensions or inventories.

## Administrator setup: enable authentication and live tests

These are setup instructions, **not permissions or deployments already applied**. Microsoft 365 admin center alone does not run these tests: an Azure administrator prepares the worker host/identity, and the relevant Microsoft 365/Entra administrators authorize its access.

### 1. Confirm the tenant and dedicated test resources

- Confirm the Azure hosting tenant and Microsoft 365 tenant separately. Same-tenant application Graph can use the Azure UAMI. Teams delegated mode requires same-tenant hosting, a separately approved public client and the protected cache. For cross-tenant application Graph, use a certificate-backed application in the **M365 tenant**, independently of Azure health-report credentials; no Azure subscription is needed in the M365 tenant for that option. Follow the [cross-tenant administrator walkthrough](../docs/cross-tenant-access.md).
- Provision an approved synthetic mailbox, dedicated SharePoint site/library/folder, and test team/standard channel as applicable. Confirm licensing, owners, cadence, cleanup/retention, and recipient restrictions. Business Basic supports the stable Service Health endpoints with administrator-granted access; it does not establish entitlement to optional beta reports.
- Record the mailbox address; SharePoint site/drive/folder IDs; and Teams tenant/team/standard-channel IDs and approved Bot Connector service URL. Only optional delegated coverage needs expected test-user UPNs. Do not target employee resources merely to get started.

### 2. Prepare and attach the hosted identity

Use a separate user-assigned managed identity per service/environment. The [shared hosting guide](./infra/README.md) and [Bicep](./infra/main.bicep) deploy all selected services with separate identities. Its foundation stage creates no workers, and real execution requires a separate live opt-in. Compiling creates nothing.

Hand off these non-secret outputs to the tenant administrator:

| Output | Use |
| --- | --- |
| `tenantId` | Verify the approved Microsoft 365 directory |
| `clientId` | Select the identity at runtime; application ID for service grants |
| `principalId` | Enterprise service-principal object ID for permission assignments |
| `identityResourceId` | Attach the Azure identity to its Container App |

An application-registration object ID is **not** the managed identity's `principalId`. For same-tenant Graph, managed identities already have an enterprise service principal; do not create a duplicate app registration. For cross-tenant Graph, the separate M365 application has its own Enterprise application Object ID; use that for M365 grants, not the Azure UAMI principal ID. The Azure UAMI remains responsible for health reports.

The deploying administrator needs scoped resource creation/identity-attachment rights. A private registry also needs the appropriate scoped image-pull authorization. These Azure permissions do not grant Microsoft 365 access, and the runtime identity does not need subscription Owner/Contributor or tenant administrator roles.

### 3. Authorize each journey

| Journey | Administrator action | Boundary to verify |
| --- | --- | --- |
| Exchange | Register the identity's service-principal reference in Exchange; assign **`Application Mail.ReadWrite`**, **`Application Mail.Send`**, and calendar journeys' **`Application Calendars.ReadWrite`** through Exchange RBAC for Applications | Scope only the dedicated participants; verify allowed participants and an approved denied control mailbox |
| SharePoint | Assign Graph application permission **`Sites.Selected`**, then explicitly grant the identity **`write`** on the approved test site | `Sites.Selected` alone grants no site access; the site grant covers that site, not just the configured folder |
| Teams | Approve the public client's delegated **`ChannelMessage.Send`**, **`ChannelMessage.Read.All`**, **`ChannelMessage.ReadWrite`** and individual human bootstraps; see the [cache/bootstrap guide](../docs/teams-user-bootstrap.md) | Every selected root test-user UPN, same tenant, dedicated standard channel, independently verified posting authors; no provisioning scopes on the runtime app |

Follow the [Exchange administrator commands and effective-access checks](../MAILBOX-SYNTHETIC-ACCESS.md#4-illustrative-exchange-administrator-setup), [SharePoint setup](./sharepoint/README.md), and [Teams setup](./teams/README.md).

**Do not additionally grant tenant-wide Entra Graph `Mail.ReadWrite` or `Mail.Send`.** Entra grants and Exchange RBAC are a union; the scoped Exchange role cannot restrict a separate broad mail grant. Review both authorization paths. Allow propagation time and verify effective live access before scheduling.

Teams defaults to `teamsAuthentication: "bot"` and `botAuthentication: "managed-identity"`: an installed same-tenant bot uses explicitly selected `BOT_CLIENT_ID` for Bot Connector, independent of application Graph observation and ARM reporting. Hosting supplies bot tenant/client metadata from the attached UAMI; no Teams serviceAccess credentials or user-cache storage are needed. No user MFA or refresh-token maintenance is involved, and this is not employee sign-in/UI coverage. Follow the [bot setup](./teams/README.md#primary-setup-unattended-bot). Optional delegated coverage requires explicit `teamsAuthentication: "user-delegated"`, isolated per-user protected caches and [human bootstrap](../docs/teams-user-bootstrap.md); provider collectors never reuse user tokens. Optional bot certificates require explicit `botAuthentication: "certificate"`, never fallback.

### 4. Optionally authorize Microsoft-reported context

Grant only what the service config actually enables, to the **identity collecting that service's data**:

| Config | Additional Graph application permission |
| --- | --- |
| `serviceHealth: true` | `ServiceHealth.Read.All` for both stable overviews and issues |
| Exchange `serviceActivity.enabled: true` | `ServiceActivity-Exchange.Read.All` |
| Teams `serviceActivity.enabled: true` | `ServiceActivity-Teams.Read.All` |

Managed identities do not have a normal app-registration API-permissions page. An authorized Entra administrator assigns the Graph app role to the existing enterprise service principal. For Microsoft Graph application roles, use an administrator with **Privileged Role Administrator** or another appropriately authorized role; subscription ownership alone is insufficient.

For example, this PowerShell setup grants **only stable Service Health**. It requires the Microsoft Graph PowerShell Applications module and administrator-approved delegated scopes. The setup scopes belong to the administrator's session, **not the worker**. Replace the three handoff placeholders, review existing grants, and run only after approval:

```powershell
$ErrorActionPreference = "Stop"
$tenantId = "<approved tenantId>"
$clientId = "<managed identity clientId>"
$principalId = "<managed identity principalId>"

Connect-MgGraph -TenantId $tenantId -ContextScope Process `
    -Scopes "Application.Read.All", "AppRoleAssignment.ReadWrite.All"

$identity = Get-MgServicePrincipal -ServicePrincipalId $principalId
if ($identity.AppId -ne $clientId) { throw "Identity clientId/principalId mismatch." }

$graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
$role = @($graph.AppRoles | Where-Object {
    $_.Value -eq "ServiceHealth.Read.All" -and $_.IsEnabled -and
    $_.AllowedMemberTypes -contains "Application"
})
if ($role.Count -ne 1) { throw "Required Graph application role is unavailable." }

$existing = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $principalId -All |
    Where-Object { $_.ResourceId -eq $graph.Id -and $_.AppRoleId -eq $role[0].Id }
if (-not $existing) {
    New-MgServicePrincipalAppRoleAssignedTo -ServicePrincipalId $graph.Id `
        -PrincipalId $principalId -ResourceId $graph.Id -AppRoleId $role[0].Id
}
Disconnect-MgGraph
```

See Microsoft's [app-role assignment authorization requirements](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignments?view=graph-rest-1.0). The full [permission handoff](../MAILBOX-SYNTHETIC-ACCESS.md#optional-microsoft-reported-provider-data) explains the separation from mailbox roles.

Keep beta disabled for production. Experimental use requires confirmed tenant availability, its additional permission, `serviceActivity.enabled: true`, and **`ENABLE_BETA_SERVICE_ACTIVITY=true`**. These reports remain log-only diagnostics and never drive journey/Experience health. SharePoint beta is not supported by this implementation.

### 5. Configure the worker, not the administrator's login

Copy the live settings example for [Exchange](./exchange/config.live.example.json), [Teams](./teams/config.live.example.json), or [SharePoint](./sharepoint/config.live.example.json) to an approved private runtime-config location. Select that file in a private root config, replace **root** targets and `healthModel.subscriptionId`/resource group/name, and choose the intended cadence. These files contain no targets or enablement; those belong only at the root. Live execution still requires root selection and `ENABLE_LIVE_M365=true` after approval. For example, an Exchange service file is:

```json
{
  "type": "exchange",
  "intervalSeconds": 60,
  "timeoutSeconds": 45,
  "mode": "live",
  "graphAuthentication": "managed-identity",
  "cohort": "exchange-global",
  "serviceHealth": true,
  "serviceActivity": { "enabled": false }
}
```

Set these in the hosted worker's environment; keep secrets out of JSON and source control:

| Setting | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Attached user-assigned identity's client ID |
| `AZURE_TENANT_ID` | Azure hosting tenant ID |
| Certificate Graph `M365_*` settings | M365 tenant/client ID and securely mounted PEM path; see the cross-tenant guide |
| `ENABLE_LIVE_M365` | Exactly `true`, only after authorization |
| Teams delegated `TEAMS_PUBLIC_CLIENT_ID`, `TEAMS_CACHE_ACCOUNT_URL` | Public-client/storage access metadata; Bicep also supplies fixed `TEAMS_CACHE_CONTAINER` / `TEAMS_CACHE_BLOB`; account is root-owned |
| Teams bot `BOT_TENANT_ID`, `BOT_CLIENT_ID` | Default bot mode: hosted metadata from the attached UAMI; only explicit `botAuthentication: "certificate"` needs a mounted `BOT_CLIENT_CERTIFICATE_PATH` |

Same-tenant Graph defaults to the explicitly selected managed identity. Teams bot
readback can instead use service `teamsReadbackClientId`: a separate Entra
registration with team-scoped RSC trusts the worker UAMI through federation.
Bot Connector, calling, provider collection and ARM reporting retain their
independent identities. Follow the [bot identity mapping](./teams/README.md#primary-setup-unattended-bot).
Neither mode falls back to developer login, a system identity, secrets or certificates.
`healthReportAuthentication` independently obtains an ARM-audience token and
requires ingestion permission on its own **service model**. Cross-tenant Graph
uses explicit `certificate` mode and `M365_*`; it does not change Azure reporting.

**Local live development:** a normal laptop does not expose the Container Apps managed-identity endpoint. Explicitly choose `graphAuthentication: "certificate"` and provide the M365 application's `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_CERTIFICATE_PATH`. Independently choose `healthReportAuthentication: "certificate"` with an Azure-authorized report application's `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_CERTIFICATE_PATH`. Upload the corresponding public certificates, keep private PEMs secure, and authorize each service principal only for its purpose. Hosted identity grants do not transfer to them. **Migration:** move old Graph certificate metadata from `AZURE_*` to `M365_*`; no legacy fallback occurs. `az login` alone does not authenticate these workers.

### 6. Prove one cycle before enabling recurrence

1. Run the checked-in simulation commands first; these make no Microsoft 365 calls and require no credentials.
2. Complete allowed/denied access checks. From the approved host, invoke a single live cycle using its private config:

   ```sh
   npm run exchange -- --project-config /absolute/path/to/approved/monitoring.config.json --once
   # Or in a built container, with the config mounted at the approved path:
   node dist/exchange/src/worker.js --project-config /etc/probe/monitoring.config.json --config /etc/probe/exchange.json --once
   ```

3. Inspect every journey/step result and cleanup outcome. A completed process is not proof of a successful journey. Check explicit provider diagnostics if collection is enabled.
4. Verify separate journey/step external reports and propagation through service/root models, plus suppressed provider status. Check separately that issues/beta diagnostics and internal token/cleanup operations never become business-step measurements.
5. Only then run without `--once`. Review the [operations acceptance gates](../docs/operations.md), independent missing-results/worker alerts, and end-to-end notification tests before calling this production-ready.

## Wiring and readiness

| Surface | Current state |
| --- | --- |
| Exchange, Teams, SharePoint journeys and named steps | Eleven implemented journeys, safe simulation defaults and HTTP-mocked tests. Exchange mail/draft/attachment-reply/DL verified Healthy; calendar currently 403-blocked. Teams single-bot messaging/readback and signaling-only calls live verified; SharePoint lacks approved live targets. Target catalogs are broader than implementation. |
| Root config, scheduling, direct aggregated reports, console diagnostics, provider callbacks | Connected in code; safe simulation previews by default; live examples collect stable provider context |
| Root model of service models and journey/step entities | Five models, 180 entities, 175 relationships: eleven implemented and 23 planned journey roots, 118 business steps. Implemented External Reports always, OTEL optional; planned coverage stays Unknown/suppressed with no reports or workers. See [catalog](../health-model/README.md#catalog-versus-modeled-and-live-coverage). |
| Stable provider context / beta diagnostics | Independent 300-second provider lanes; direct suppressed status/threshold reports, counts diagnostic absent thresholds, issues diagnostic. Beta currently 403; failed/missing data stays Unknown, never synthetic success samples. See [provider evidence](../docs/provider-monitoring.md). |
| Worker hosting and packaging | Separate Container Apps reuse one immutable image; see the dated [live baseline](../docs/deployment.md#deployment-status-and-order) rather than treating sample settings as deployed state |
| Tenant authorization and runtime settings | Mailbox-scoped Exchange and team-scoped Teams readback verified in the baseline; each new deployment must validate its own allowed/denied grants, targets and ingestion |
| Production operations | Independent stalled-worker/broken-publication detection, end-to-end notifications and OTEL cloud ingestion remain acceptance gates |

The [deployment status](../docs/deployment.md#deployment-status-and-order) distinguishes
successful live evidence, incomplete setup and unverified production gates. Do not
infer tenant-wide availability, employee UI success or alert delivery from API tests.

## Components

| Folder | Responsibility |
| --- | --- |
| [health-model/](../health-model/) | Independently deployed topology and external report signals |
| [exchange/](./exchange/) | Exchange worker, config, journeys/actions and tests |
| [teams/](./teams/) | Teams worker, config, journeys/actions and tests |
| [sharepoint/](./sharepoint/) | SharePoint worker, config, journeys/actions and tests |
| [utils/](./utils/README.md) | Shared root/service config, clients, measured steps, execution/scheduling, aggregation/health reports and console diagnostics |
| [package.json](./package.json), [package-lock.json](./package-lock.json) | npm scripts and pinned dependency graph for this project |
| [tsconfig.json](./tsconfig.json), [tsconfig.build.json](./tsconfig.build.json), [vitest.config.ts](./vitest.config.ts) | Typechecking, production build and unit-test discovery |

Installed dependencies and generated output live in this project's ignored `node_modules/`, `dist/`, and `coverage/` directories. There is no repository-root npm package or workspace wrapper.

## Validate

```sh
npm run typecheck
npm test
npm run build
node dist/exchange/src/worker.js --once
node dist/teams/src/worker.js --once
node dist/sharepoint/src/worker.js --once
```

This npm package builds all three entries into `dist/`; tests are excluded from production output. See [shared worker configuration](./utils/README.md), [operations](../docs/operations.md), and [deployment boundaries](../docs/deployment.md). Direct health reporting is required for live execution.
