# Microsoft 365 synthetic tests

**Run a test, aggregate its actions, report health, repeat.** Each service has its own config and cadence; one root configuration selects services, journeys, targets, and report policy.

This directory is the self-contained Node project. For why synthetic journeys complement Microsoft-reported health and how Azure Monitor Health Models exposes experience gaps, see the [repository overview](../README.md).

Start with the service-owned journey guides: [Exchange mail/draft](./exchange/README.md), [Teams publication/reply](./teams/README.md), and [SharePoint save/rename](./sharepoint/README.md). Each documents its exact endpoints, reusable actions, config and tests. These are API-backed journeys, not browser/desktop or employee sign-in tests. HTTP-level tests assume approved access; no successful tenant journey or employee receipt is established by those tests.

```text
Exchange Container App   [test + aggregation, every 60 seconds]  --+
Teams Container App      [test + aggregation, every 120 seconds] --+
SharePoint Container App [test + aggregation, every 300 seconds] --+
                                                                |
                            Direct health reports to service model entities
                                                                |
                                    Root model of service health models

```

The [health model templates](../health-model/README.md) create a root model referencing separate enabled service models. Each of six journeys has its own entity and business-step child entities: **18 business steps, four models, 34 entities and 30 relationships** in the full family. Each journey/step has **External Reports** as its only signal group. Token acquisition and cleanup remain internal, with no entities or published step data. Use the [shared worker deployment](./infra/README.md) for rollout and the [migration procedure](../health-model/README.md#apply-and-migrate) to remove old telemetry resources while preserving the earlier PoC model entities/root.

Each service has its own Container App and cadence. Console diagnostics remain in that same process; no separate telemetry service or Kubernetes requirement is introduced.

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
| `services.<service>.scenarios` | Select both journeys independently: Exchange `send-receive-mail`/`edit-reopen-draft`, Teams `publish-channel-message`/`reply-channel-message`, SharePoint `save-reopen-file`/`rename-reopen-file`; all default to `true` |
| `services.<service>.targets` | Account email addresses or approved site/team/channel IDs, never credentials |
| `services.<service>.configFile` | Service-owned file for independent cadence, timeout, mode, authentication and provider settings; relative to the root config's directory |
| `healthModel` | Root model name, subscription/resource group, report TTL, and success/mean-duration thresholds |

Service/scenario selection, targets, and report policy are configured **only in the root file**. The service-file parser rejects duplicate `enabled`, `targets`, and obsolete `telemetry` keys instead of silently ignoring them. Root service/scenario switches disable execution before credentials are initialized. No generic all-service scheduler is introduced: run each selected worker independently. Live execution and beta/provider permissions remain separate safety gates.

| Config | Cadence | Default |
| --- | --- | --- |
| [Exchange](./exchange/config.json) | 60 seconds | Simulated mail-flow result |
| [SharePoint](./sharepoint/config.json) | 300 seconds | Simulated file result |
| [Teams](./teams/config.json) | 120 seconds | Simulated channel publication; bot-backed live handler requires approved access |

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

Restart a worker after editing its file. Separate services do not share a scheduler. A worker never overlaps its own cycles; missed slots are skipped, not queued into catch-up bursts. Run one instance per target set until distributed ownership is implemented.

Each command reads the root config (default `../monitoring.config.json` from this Node project), then the selected `configFile`. Use `--project-config <file>` for a private/mounted root config and `--config <file>` to override only the service file. The latter path is relative to the process working directory; root `configFile` paths are relative to the project config. A service entry rejects another service's config before credentials or operations are initialized.

### Per-cycle health reports

After each complete cycle, aggregate actual attempts separately for each journey and business action. Send `synthetic-success-percentage`/`synthetic-mean-duration` to that journey's entity and each journey-scoped business-step entity in `<root-model-name>-<service>`. Both enabled journeys use the same product worker and cadence. Defaults remain below 99%/95% success and above 15/60 seconds mean duration for Degraded/Unhealthy; these are demo thresholds, **not per-action SLOs or p95 latency**.

Executed failures count as zero success. Skipped/unobserved actions have no artificial samples and receive Unknown reports without a numeric value. No aggregation history is retained across cycles. Simulation only prints `health-report-preview`; live mode publishes direct ARM health reports and console diagnostics. Publication failures remain explicit.

Reports default to a 15-minute TTL and are replaced each cycle. An incomplete/cancelled cycle explicitly skips synthetic reports rather than publishing a healthy partial aggregate. Expiry **removes** external signals; it does not guarantee Unhealthy or an alert. Independently detect stopped/stalled execution and broken publication. Reports are current-cycle aggregates, not a full metrics store, percentile history, or arbitrary logs query interface; means alone cannot reconstruct weighted historical statistics.

Live hosted workers do not substitute simulations when resources are unready. Real API/authorization failures make the journey unsuccessful. Valid-but-incomplete setup is reported as an actual unexecutable initialization failure: the journey gets a zero-success/Unhealthy report and unexecuted action signals remain Unknown. Recurring workers retry initialization on their service cadence; `--once` still fails after publishing. Invalid schemas and unavailable report credentials can prevent publication entirely.

## Optional Microsoft-reported context

Provider collection is read-only and runs once per service worker cycle in the existing process—not once per journey or target. Safe simulation configs keep it off; the live examples enable stable Service Health. Collection is independent of journey initialization, so missing targets/bot credentials do not block the Graph attempt. Explicit permission/collection errors are logged; no Microsoft health is fabricated. Provider data never changes journey results or the 1/0 synthetic/step measurements.

- `serviceHealth: true` reads stable `/v1.0/admin/serviceAnnouncement/healthOverviews` and `/issues` for the exact subscribed service name. Overview status reports directly to `${service}-service-health` as `microsoft-reported-service-status` in **External Reports**: **100 healthy, 50 degraded, 0 interruption**, with `impactSuppressed`. Failed/missing/unknown overview status produces Unknown without a value and with failure context. The existing trial observes Graph 403 until `ServiceHealth.Read.All` admin consent is granted. Issues/history remain console diagnostics and do not populate health signals.
- `serviceActivity: { "enabled": true, "aggregationIntervalMinutes": 15, "lookbackMinutes": 30 }` additionally requires **`ENABLE_BETA_SERVICE_ACTIVITY=true`**. Exchange connectivity percentages and Teams chat volumes are **experimental beta diagnostics only**, unsupported for production use; they never bubble into Experience/journey health. SharePoint beta configuration is rejected because no SharePoint-specific report is verified.
- Live mode still requires `ENABLE_LIVE_M365=true` and separately approved application permissions: `ServiceHealth.Read.All`, and optionally `ServiceActivity-Exchange.Read.All` or `ServiceActivity-Teams.Read.All`. These are additional provider permissions, not replacements for scoped journey access. Nothing grants them automatically. Tenant eligibility/enablement must be confirmed.

Business Basic can support the API-backed synthetics and stable Service Health where the subscribed service (including an appropriate Teams SKU) and administrator-approved access exist. Do **not** assume beta report entitlement on Basic: its API pages document permissions, not explicit Basic eligibility. Microsoft's separate [advanced Microsoft 365 monitoring](https://learn.microsoft.com/microsoft-365/enterprise/microsoft-365-monitoring) requires at least 5,000 qualifying Office 365/Microsoft 365 E3/E5 licenses and 50 monthly active users for a core service; that published monitoring eligibility is not proof of beta API entitlement. Confirm report availability with the tenant administrator.

Simulation skips configured sources without Graph credentials/network or fabricated Microsoft health. Provider failures (including missing/invalid data, permission errors, throttling, and bounded pagination) are explicit sanitized console diagnostics and summary failure counts, not successful empty snapshots. Historical overlapping beta windows are **diagnostics only**, never counters or success rates.

See the [exact configuration, diagnostic contract and bounds](./utils/README.md#optional-provider-collectors) and [measurement semantics](./utils/README.md#measurement-semantics). Each attempt contributes one binary success observation (1 or 0); total duration stays separate from request and confirmed delivery/publication durations. Reports aggregate separately by journey/business step, never by per-target dimensions or inventories.

## Administrator setup: enable authentication and live tests

These are setup instructions, **not permissions or deployments already applied**. Microsoft 365 admin center alone does not run these tests: an Azure administrator prepares the worker host/identity, and the relevant Microsoft 365/Entra administrators authorize its access.

### 1. Confirm the tenant and dedicated test resources

- Confirm that the Azure worker identity and Microsoft 365 resources belong to the **same Entra tenant**. Azure hosting/billing and Microsoft 365 licensing are separate; another Azure subscription does not automatically mean another tenant. A newly purchased lab tenant might differ from the existing Azure subscription's tenant.
- Provision an approved synthetic mailbox, dedicated SharePoint site/library/folder, and test team/standard channel as applicable. Confirm licensing, owners, cadence, cleanup/retention, and recipient restrictions. Business Basic supports the stable Service Health endpoints with administrator-granted access; it does not establish entitlement to optional beta reports.
- Record the mailbox address; SharePoint site/drive/folder IDs; and Teams tenant/team/channel IDs and approved bot conversation metadata. Do not target employee resources merely to get started.

### 2. Prepare and attach the hosted identity

Use a separate user-assigned managed identity per service/environment. The [shared hosting guide](./infra/README.md) and [Bicep](./infra/main.bicep) deploy all selected services with separate identities. Its foundation stage creates no workers, and real execution requires a separate live opt-in. Compiling creates nothing.

Hand off these non-secret outputs to the tenant administrator:

| Output | Use |
| --- | --- |
| `tenantId` | Verify the approved Microsoft 365 directory |
| `clientId` | Select the identity at runtime; application ID for service grants |
| `principalId` | Enterprise service-principal object ID for permission assignments |
| `identityResourceId` | Attach the Azure identity to its Container App |

An application-registration object ID is **not** the managed identity's `principalId`. Managed identities already have an enterprise service principal; do not create a duplicate application registration for hosted Graph access.

The deploying administrator needs scoped resource creation/identity-attachment rights. A private registry also needs the appropriate scoped image-pull authorization. These Azure permissions do not grant Microsoft 365 access, and the runtime identity does not need subscription Owner/Contributor or tenant administrator roles.

### 3. Authorize each journey

| Journey | Administrator action | Boundary to verify |
| --- | --- | --- |
| Exchange | Register the identity's service-principal reference in Exchange; assign **`Application Mail.ReadWrite`** and **`Application Mail.Send`** through Exchange RBAC for Applications | Scope only the dedicated mailbox; verify it is allowed and an approved control mailbox is denied |
| SharePoint | Assign Graph application permission **`Sites.Selected`**, then explicitly grant the identity **`write`** on the approved test site | `Sites.Selected` alone grants no site access; the site grant covers that site, not just the configured folder |
| Teams | Authorize the Graph observer with team-scoped **`ChannelMessage.Read.Group`** resource-specific consent through an approved Teams app installation; register/install the sending bot separately | Validate the exact team/channel, observer identity, bot identity, tenant, and conversation `serviceUrl` |

Follow the [Exchange administrator commands and effective-access checks](../MAILBOX-SYNTHETIC-ACCESS.md#4-illustrative-exchange-administrator-setup), [SharePoint setup](./sharepoint/README.md), and [Teams setup](./teams/README.md).

**Do not additionally grant tenant-wide Entra Graph `Mail.ReadWrite` or `Mail.Send`.** Entra grants and Exchange RBAC are a union; the scoped Exchange role cannot restrict a separate broad mail grant. Review both authorization paths. Allow propagation time and verify effective live access before scheduling.

Teams is **not fully keyless** in the current implementation: Graph can use managed identity, but Bot Connector uses a separate certificate-backed identity with `BOT_TENANT_ID`, `BOT_CLIENT_ID`, and `BOT_CLIENT_CERTIFICATE_PATH`. Securely mount its private-key certificate and establish rotation. Never supply a mailbox/user password.

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
| `AZURE_TENANT_ID` | Approved tenant ID; also used for Teams identity/tenant checks |
| `ENABLE_LIVE_M365` | Exactly `true`, only after authorization |
| Teams-only `BOT_*` settings | The separate bot tenant/client ID and securely mounted certificate path described above |

Managed identity authenticates Graph with `ManagedIdentityCredential({ clientId })`; there is no developer-login, system-identity, secret, or certificate fallback. The same explicitly selected identity obtains a separate ARM-audience token for mandatory live health reports and needs the health-model report action on its **service model**, independently of Graph grants. See [model permissions](../health-model/README.md).

**Local live development:** a normal laptop does not expose the Container Apps managed-identity endpoint. Explicitly choose `graphAuthentication: "certificate"` and use an administrator-authorized development application's `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_CERTIFICATE_PATH`. Upload its public certificate to that app registration, keep the private-key PEM secure, and authorize **that development service principal** using the same scoped journey permissions. Hosted identity grants do not transfer to it. `az login` alone does not authenticate these workers.

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
| Exchange, Teams, SharePoint journeys and named steps | Implemented with safe simulation defaults and HTTP-mocked tests; no live tenant acceptance completed |
| Root config, scheduling, direct aggregated reports, console diagnostics, provider callbacks | Connected in code; safe simulation previews by default; live examples collect stable provider context |
| Root model of service models and journey/step entities | Redeployed report-only: four models, 34 entities, 30 relationships, six journeys and 18 business steps; External Reports only; original PoC model retained without queries |
| Stable provider context / beta diagnostics | Stable overview status reports are impact-suppressed; missing/failed/unknown overviews report Unknown; issues and beta are diagnostics only, never synthetic success samples |
| Worker hosting and packaging | All three apps have ready/running `--0000005` revisions on the same immutable digest; no Application Insights environment settings or ingestion secrets, only root/service config secrets; see the shared deployment guide |
| Tenant authorization and runtime settings | Successful mailbox/site/team access, Graph/Exchange grants, stable Service Health consent, and bot installation/certificates still need acceptance |
| Production operations | Report-only rollout and telemetry deletion verified; fresh SharePoint provider Unknown/Graph 403 reporting verified; all-service end-to-end verification still running; successful journeys, independent failure detection and notification acceptance remain unproven |

The earlier deployed live failure-path trial used real authentication/requests and reported actual failures. The [current report-only deployment](./infra/README.md#verified-report-only-deployment) is verified on all three apps. Both the demo and original PoC telemetry pairs and associated smart-detector rules are deleted, along with four workspace-query settings and four scoped reader roles. Normal workspace deletion has a **14-day recovery window**, not a permanent purge. These facts do **not** establish completed all-service end-to-end verification, successful Microsoft 365 availability, or production readiness.

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
