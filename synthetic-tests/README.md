# Microsoft 365 synthetic tests

**Run a test, report its result, repeat.** Each service has its own config and cadence. 

This directory is the self-contained Node project. For why synthetic journeys complement Microsoft-reported health and how Azure Monitor Health Models exposes experience gaps, see the [repository overview](../README.md).

Start with the service-owned journey guides: [Exchange send/receive](./exchange/README.md), [Teams channel publication](./teams/README.md), and [SharePoint save/reopen](./sharepoint/README.md). Each documents its exact endpoints, reusable actions, config, tests, and queries. These are API-backed journeys, not browser/desktop or employee sign-in tests. HTTP-level tests assume approved access; no real tenant execution or employee receipt is established.

```text
Exchange Container App   [test + OTel SDK, every 60 seconds]  --+
Teams Container App      [test + OTel SDK, every 120 seconds] --+
SharePoint Container App [test + OTel SDK, every 300 seconds] --+
                                                             |
                                         workspace-based Application Insights
                                                             |
                                                  Log Analytics / KQL
                                               success percentage and latency
                                                             |
                                              health-model query signals
```

The [sample health model and telemetry resources](../health-model/README.md) are managed independently in `rg-m365-demo`. Each service experience has **one AzureLogAnalytics entity displayed as User Journey**, with overall and named-step KQL signals inside it—not separate child step entities. Query signals evaluate **live-only** data; no live worker is connected yet. Azure Container Apps is the intended worker host, not an already deployed worker.

OpenTelemetry runs **inside each service's existing process**, not in another worker/container. Each service has its own Container App and config; no AKS cluster, sidecar, or OTel Collector is required for this export path.

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

Checked-in configs use **simulation** and **console output**: no real email/files, Azure ingestion, or local state writes. Stop with Ctrl+C.

All remaining npm and compiled-worker commands in this guide run from `synthetic-tests/`. From the repository root, `npm --prefix synthetic-tests run <command>` selects the same project without changing directories.

## Configure each service

| Config | Cadence | Default |
| --- | --- | --- |
| [Exchange](./exchange/config.json) | 60 seconds | Simulated mail-flow result |
| [SharePoint](./sharepoint/config.json) | 300 seconds | Simulated file result |
| [Teams](./teams/config.json) | 120 seconds | Simulated channel publication; bot-backed live handler requires approved access |

```json
{
  "type": "exchange",
  "enabled": true,
  "intervalSeconds": 60,
  "timeoutSeconds": 45,
  "mode": "simulation",
  "graphAuthentication": "managed-identity",
  "cohort": "exchange-global",
  "telemetry": "console",
  "targets": [{ "id": "exchange-probe-001" }]
}
```

Restart a worker after editing its file. Separate services do not share a scheduler. A worker never overlaps its own cycles; missed slots are skipped, not queued into catch-up bursts. Run one instance per target set until distributed ownership is implemented.

Each command defaults to its own `<service>/config.json`; use `--config <file>` to override it. A service entry rejects another service's config before credentials or operations are initialized.

## Optional Microsoft-reported context

Provider collection is **off by default**, read-only, and runs once per service worker cycle in the existing process—not once per mailbox/channel/site. It never changes journey results or the 1/0 synthetic/step measurements.

- `serviceHealth: true` reads stable `/v1.0/admin/serviceAnnouncement/healthOverviews` and `/issues` for the exact subscribed service name. Both are **context-only**; ServiceHealth entities remain impact-suppressed. Issues/history do not populate health signals.
- `serviceActivity: { "enabled": true, "aggregationIntervalMinutes": 15, "lookbackMinutes": 30 }` additionally requires **`ENABLE_BETA_SERVICE_ACTIVITY=true`**. Exchange connectivity percentages and Teams chat volumes are **experimental beta diagnostics only**, unsupported for production use; they never bubble into Experience/journey health. SharePoint beta configuration is rejected because no SharePoint-specific report is verified.
- Live mode still requires `ENABLE_LIVE_M365=true` and separately approved application permissions: `ServiceHealth.Read.All`, and optionally `ServiceActivity-Exchange.Read.All` or `ServiceActivity-Teams.Read.All`. These are additional provider permissions, not replacements for scoped journey access. Nothing grants them automatically. Tenant eligibility/enablement must be confirmed.

Business Basic can support the API-backed synthetics and stable Service Health where the subscribed service (including an appropriate Teams SKU) and administrator-approved access exist. Do **not** assume beta report entitlement on Basic: its API pages document permissions, not explicit Basic eligibility. Microsoft's separate [advanced Microsoft 365 monitoring](https://learn.microsoft.com/microsoft-365/enterprise/microsoft-365-monitoring) requires at least 5,000 qualifying Office 365/Microsoft 365 E3/E5 licenses and 50 monthly active users for a core service; that published monitoring eligibility is not proof of beta API entitlement. Confirm report availability with the tenant administrator.

Simulation skips configured sources without Graph credentials/network or fabricated Microsoft health. Provider failures (including missing/invalid data, permission errors, throttling, and bounded pagination) are explicit sanitized diagnostic logs and summary failure counts, not successful empty snapshots. Historical overlapping beta windows are **logs only**, never counters or success rates.

See the [exact configuration, diagnostic contract and bounds](./utils/README.md#optional-provider-collectors), plus service-owned analytics: [Exchange context](./exchange/queries/analytics/service-health-context.kql), [Teams context](./teams/queries/analytics/service-health-context.kql), [SharePoint context](./sharepoint/queries/analytics/service-health-context.kql), [Exchange beta](./exchange/queries/analytics/service-activity-diagnostics.kql), [Teams beta](./teams/queries/analytics/service-activity-diagnostics.kql).

## Send telemetry to Log Analytics

Use a **workspace-based Application Insights resource linked to the intended Log Analytics workspace**, then:

1. Set the service config's `telemetry` to `azure-monitor`.
2. Supply its `APPLICATIONINSIGHTS_CONNECTION_STRING` as an environment variable/secret, not in JSON or source control.
3. Run a single cycle and check `AppMetrics` and `AppTraces` in the linked workspace after ingestion.

The worker exports:

- One success measurement per attempt: **1 = success, 0 = unsuccessful**.
- A total probe-duration histogram in seconds.
- An Exchange send-request-duration histogram in seconds.
- An Exchange confirmed-delivery-duration histogram in seconds.
- Teams Connector send/publication and SharePoint upload/read duration histograms in seconds.
- `synthetic.step.success` (1/0) and `synthetic.step.duration` (seconds) for every executed action, including failed actions and cleanup.
- Structured per-attempt and per-step diagnostics. Blocked actions are `skipped`, with no fabricated duration or success sample.

[Telemetry semantics](./utils/README.md#measurements-and-queries) describe **average success × 100**, average durations, and reporting gaps. Each service owns its `queries/analytics/` and `queries/health-model/` files. Overall metric dimensions are service, journey, mode, and outcome; step metrics add only the bounded step ID. Mailbox/probe inventories are not required.

## Administrator setup: enable authentication and live tests

These are setup instructions, **not permissions or deployments already applied**. Microsoft 365 admin center alone does not run these tests: an Azure administrator prepares the worker host/identity, and the relevant Microsoft 365/Entra administrators authorize its access.

### 1. Confirm the tenant and dedicated test resources

- Confirm that the Azure worker identity and Microsoft 365 resources belong to the **same Entra tenant**. Azure hosting/billing and Microsoft 365 licensing are separate; another Azure subscription does not automatically mean another tenant. A newly purchased lab tenant might differ from the existing Azure subscription's tenant.
- Provision an approved synthetic mailbox, dedicated SharePoint site/library/folder, and test team/standard channel as applicable. Confirm licensing, owners, cadence, cleanup/retention, and recipient restrictions. Business Basic supports the stable Service Health endpoints with administrator-granted access; it does not establish entitlement to optional beta reports.
- Record the mailbox address; SharePoint site/drive/folder IDs; and Teams tenant/team/channel IDs and approved bot conversation metadata. Do not target employee resources merely to get started.

### 2. Prepare and attach the hosted identity

Use a separate user-assigned managed identity per service/environment. The [Exchange mock hosting guide](./exchange/infra/README.md) and [Bicep](./exchange/infra/main.bicep) illustrate the intended Container Apps setup. Both deployment/live gates default to false. Compiling creates nothing; a reviewed future deployment with `deployWorker: false` creates the identity only, so it can be authorized before enabling a worker.

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

Copy the disabled live template for [Exchange](./exchange/config.live.example.json), [Teams](./teams/config.live.example.json), or [SharePoint](./sharepoint/config.live.example.json) to an approved private runtime-config location. Replace targets and select the intended cadence. For example, a complete Exchange config after approval is:

```json
{
  "type": "exchange",
  "enabled": true,
  "intervalSeconds": 60,
  "timeoutSeconds": 45,
  "mode": "live",
  "graphAuthentication": "managed-identity",
  "cohort": "exchange-global",
  "telemetry": "azure-monitor",
  "serviceHealth": true,
  "serviceActivity": { "enabled": false },
  "targets": [
    { "id": "exchange-probe-001", "mailbox": "replace-with-approved-mailbox@example.invalid" }
  ]
}
```

Set these in the hosted worker's environment; keep secrets out of JSON and source control:

| Setting | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Attached user-assigned identity's client ID |
| `AZURE_TENANT_ID` | Approved tenant ID; also used for Teams identity/tenant checks |
| `ENABLE_LIVE_M365` | Exactly `true`, only after authorization |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Securely supplied connection string for the intended workspace-based Application Insights resource |
| Teams-only `BOT_*` settings | The separate bot tenant/client ID and securely mounted certificate path described above |

Managed identity authenticates Graph with `ManagedIdentityCredential({ clientId })`; there is no developer-login, system-identity, secret, or certificate fallback. Telemetry ingestion is configured separately from Graph access.

**Local live development:** a normal laptop does not expose the Container Apps managed-identity endpoint. Explicitly choose `graphAuthentication: "certificate"` and use an administrator-authorized development application's `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_CERTIFICATE_PATH`. Upload its public certificate to that app registration, keep the private-key PEM secure, and authorize **that development service principal** using the same scoped journey permissions. Hosted identity grants do not transfer to it. `az login` alone does not authenticate these workers.

### 6. Prove one cycle before enabling recurrence

1. Run the checked-in simulation commands first; these make no Microsoft 365 calls and require no credentials.
2. Complete allowed/denied access checks. From the approved host, invoke a single live cycle using its private config:

   ```sh
   npm run exchange -- --config /absolute/path/to/approved/exchange.live.json --once
   # Or in a built container, with the config mounted at the approved path:
   node dist/exchange/src/worker.js --config /etc/probe/exchange.json --once
   ```

3. Inspect every journey/step result and cleanup outcome. A completed process is not proof of a successful journey. Check explicit provider diagnostics if collection is enabled.
4. Verify real live `AppMetrics`/`AppTraces` ingestion into the intended workspace, then the model's User Journey signals and suppressed Service Health context. Simulation cannot satisfy live-only model queries. Check separately that optional beta records never enter those signals.
5. Only then run without `--once`. The mock Bicep's generated config currently leaves provider collection off; the root README example does not automatically update that generated config. Review the [operations acceptance gates](../docs/operations.md), independent missing-results/worker alerts, and end-to-end notification tests before calling this production-ready.

## Wiring and readiness

| Surface | Current state |
| --- | --- |
| Exchange, Teams, SharePoint journeys and named steps | Implemented with safe simulation defaults and HTTP-mocked tests; no live tenant acceptance completed |
| Per-service scheduling, authentication, embedded OTel, provider callbacks | Connected in code; provider collection defaults off, runs alongside the journey, and records API failures separately |
| Model, workspace, Application Insights and query-reader identity | PoC resources deployed; 12 entities, 11 relationships, 37 signals; no live worker data connected |
| Stable provider context / beta diagnostics | Stable overview signals are impact-suppressed; issues and beta are diagnostics only, never synthetic success samples |
| Worker hosting and packaging | Exchange mock Bicep only; no deployed Container Apps, published worker image/build pipeline, or equivalent Teams/SharePoint hosting templates |
| Tenant authorization and runtime settings | Actual worker identities, mailbox/site/team approvals, Graph/Exchange grants, bot installation/certificates, and hosted telemetry settings still need setup |
| Production operations | Live access, end-to-end telemetry/model updates, independent failure detection, notifications, and reliability acceptance are not yet proven/configured |

The implementation is wired for an administrator-approved live trial, **not a deployed or production-validated monitoring service**.

## Components

| Folder | Responsibility |
| --- | --- |
| [health-model/](../health-model/) | Independently deployed topology and query signals |
| [exchange/](./exchange/) | Exchange worker, config, journey/actions, tests, queries and optional mock hosting template |
| [teams/](./teams/) | Teams worker, config, journey/actions, tests and queries |
| [sharepoint/](./sharepoint/) | SharePoint worker, config, journey/actions, tests and queries |
| [utils/](./utils/README.md) | Shared auth/config, clients, measured steps, execution/scheduling and embedded OTel |
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

This npm package builds all three entries into `dist/`; tests are excluded from production output. See [shared worker configuration](./utils/README.md), [operations](../docs/operations.md), and [deployment boundaries](../docs/deployment.md). No worker publishes Healthy/Unhealthy or calls the Health Report Ingestion API.
