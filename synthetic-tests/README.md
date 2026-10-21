# Microsoft 365 synthetic tests

**Run a test, aggregate its actions, report health, repeat.** Each service has its own config and cadence; one root configuration selects services, journeys, targets, and optional OTEL.

This directory is the self-contained Node project. For why synthetic journeys complement Microsoft-reported health and how Azure Monitor Health Models exposes experience gaps, see the [repository overview](../README.md).

Start with the service-owned journey guides: [Exchange send/receive](./exchange/README.md), [Teams channel publication](./teams/README.md), and [SharePoint save/reopen](./sharepoint/README.md). Each documents its exact endpoints, reusable actions, config, tests, and queries. These are API-backed journeys, not browser/desktop or employee sign-in tests. HTTP-level tests assume approved access; no real tenant execution or employee receipt is established.

```text
Exchange Container App   [test + aggregation, every 60 seconds]  --+
Teams Container App      [test + aggregation, every 120 seconds] --+
SharePoint Container App [test + aggregation, every 300 seconds] --+
                                                                |
                            Direct health reports to service model entities
                                                                |
                                    Root model of service health models

Optional parallel path in each process:
OTel -> workspace-based Application Insights -> Log Analytics
     -> query signals on the same journey/action entities
```

The [health model templates](../health-model/README.md) create a root model referencing separate enabled service models. Each journey/action has its own entity receiving two aggregated external reports: success percentage and mean duration. Optional query signals on those entities evaluate **live-only** OTEL data. The isolated development model family replaces neither nor modifies the earlier PoC; use the [shared worker deployment](./infra/README.md) for the cloud rollout.

When enabled, OpenTelemetry runs **inside each service's existing process**, not in another worker/container. When disabled, no SDK/exporter is constructed. Each service has its own Container App and cadence; no AKS cluster, sidecar, or OTel Collector is required.

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
| `services.<service>.scenarios` | Enable supported journeys (`send-receive-mail`, `publish-channel-message`, `save-reopen-file`); all default to `true` |
| `services.<service>.targets` | Account email addresses or approved site/team/channel IDs, never credentials |
| `services.<service>.configFile` | Service-owned file for independent cadence, timeout, mode, authentication and provider settings; relative to the root config's directory |
| `otel.enabled` | Default `true`; `false` disables SDK/exporters and model query resources/signals, **not health reports** |
| `otel.destination` | `console` by default for safe local runs; `azure-monitor` for approved Application Insights ingestion |
| `healthModel` | Root model name, subscription/resource group, report TTL, and success/mean-duration thresholds |

Service/scenario selection, targets, and OTEL are configured **only in the root file**. The service-file parser rejects duplicate `enabled`, `targets`, and `telemetry` keys instead of silently ignoring them. Root service/scenario switches disable execution before credentials/exporters are initialized. No generic all-service scheduler is introduced: run each selected worker independently. Live execution and beta/provider permissions remain separate safety gates.

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

### Health reports without Log Analytics

After each complete cycle, aggregate actual attempts across the configured targets separately for the whole journey and each action. Submit `synthetic-success-percentage` and `synthetic-mean-duration` to that entity in `<root-model-name>-<service>`. The defaults are below 99%/95% success for Degraded/Unhealthy and above 15/60 seconds mean duration for Degraded/Unhealthy. These are provisional demo thresholds, **not per-action SLOs or p95 latency**.

Executed failures count as zero success. Skipped/unobserved actions have no artificial samples and receive Unknown reports without a numeric value. No aggregation history is retained across cycles. Simulation only prints `health-report-preview`; live mode always publishes direct ARM health reports, even with `otel.enabled: false`. Telemetry export and health reporting are independent: a failure in either is explicit and does not prevent attempting the other.

Reports default to a 15-minute TTL and are replaced each cycle. An incomplete/cancelled cycle explicitly skips reports rather than publishing a healthy partial aggregate. Expiry **removes** external signals; optional query signals may still determine entity health, so TTL is not an independent stale-worker alert.

Live hosted workers do not substitute simulations when resources are unready. Real API/authorization failures make the journey unsuccessful. Valid-but-incomplete setup is reported as an actual unexecutable initialization failure: the journey gets a zero-success/Unhealthy report and unexecuted action signals remain Unknown. Recurring workers retry initialization on their service cadence; `--once` still fails after publishing. Invalid schemas and unavailable report credentials can prevent publication entirely.

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

1. Set root `otel.enabled` to `true` and `otel.destination` to `azure-monitor`.
2. Supply its `APPLICATIONINSIGHTS_CONNECTION_STRING` as an environment variable/secret, not in JSON or source control.
3. Run a single cycle and check `AppMetrics` and `AppTraces` in the linked workspace after ingestion.

With OTEL enabled, the worker additionally exports:

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

Use a separate user-assigned managed identity per service/environment. The [shared hosting guide](./infra/README.md) and [Bicep](./infra/main.bicep) deploy all selected services with separate identities. Its foundation stage creates no workers, and real execution requires a separate live opt-in. The older [Exchange-only mock](./exchange/infra/README.md) remains a compile-only illustration. Compiling creates nothing.

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

Copy the live settings example for [Exchange](./exchange/config.live.example.json), [Teams](./teams/config.live.example.json), or [SharePoint](./sharepoint/config.live.example.json) to an approved private runtime-config location. Select that file in a private root config, replace **root** targets and `healthModel.subscriptionId`/resource group/name, and choose the intended cadence. These files contain no targets, enablement, or telemetry destination; those belong only at the root. Live execution still requires root selection and `ENABLE_LIVE_M365=true` after approval. For example, an Exchange service file is:

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
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Only with root OTEL enabled and destination `azure-monitor`; securely supplied connection string |
| Teams-only `BOT_*` settings | The separate bot tenant/client ID and securely mounted certificate path described above |

Managed identity authenticates Graph with `ManagedIdentityCredential({ clientId })`; there is no developer-login, system-identity, secret, or certificate fallback. The same explicitly selected identity obtains a separate ARM-audience token for mandatory live health reports and needs the health-model report action on its **service model**, independently of Graph grants. See [model permissions](../health-model/README.md). Telemetry ingestion is configured separately from both.

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
4. Verify direct external reports and propagation through the service and root models **with OTEL disabled first**. If enabling Azure OTEL, additionally verify live `AppMetrics`/`AppTraces` ingestion and queries on the same journey/action entities. Simulation cannot satisfy live-only queries. Check separately that provider/beta diagnostics never change synthetic reports.
5. Only then run without `--once`. The mock Bicep's generated config currently leaves provider collection off; the root README example does not automatically update that generated config. Review the [operations acceptance gates](../docs/operations.md), independent missing-results/worker alerts, and end-to-end notification tests before calling this production-ready.

## Wiring and readiness

| Surface | Current state |
| --- | --- |
| Exchange, Teams, SharePoint journeys and named steps | Implemented with safe simulation defaults and HTTP-mocked tests; no live tenant acceptance completed |
| Root config, scheduling, direct aggregated reports, optional embedded OTEL, provider callbacks | Connected in code; safe simulation previews by default; provider collection remains separately disabled |
| Root model of service models, action entities and optional query resources | Isolated development model family provisioned with OTEL disabled; previous single-model PoC retained separately |
| Stable provider context / beta diagnostics | Stable overview signals are impact-suppressed; issues and beta are diagnostics only, never synthetic success samples |
| Worker hosting and packaging | Non-root Docker image, private registry/shared environment template, three independent apps and root-driven parameter preparation; see the shared deployment guide |
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
| [utils/](./utils/README.md) | Shared root/service config, clients, measured steps, execution/scheduling, aggregation/health reports and optional OTEL |
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

This npm package builds all three entries into `dist/`; tests are excluded from production output. See [shared worker configuration](./utils/README.md), [operations](../docs/operations.md), and [deployment boundaries](../docs/deployment.md). Direct health reporting is required for live execution and independent of optional OTEL.
