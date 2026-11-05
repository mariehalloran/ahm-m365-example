# Shared Azure setup

This runbook covers only the common tools, Azure resources and dispatcher-to-Function
authentication. **Microsoft 365 accounts, fixtures, application consent and resource
grants are documented separately by service:**

| Service | Setup and authorization | Journeys, health model and Graph endpoints |
| --- | --- | --- |
| Exchange | [Test mailboxes, application RBAC and reply fixtures](./exchange-permissions.md) | [Exchange README](../synthetic-tests/exchange/README.md) |
| Teams | [Bot pairs, installed apps, readback and meeting calling](./teams-permissions.md) | [Teams README](../synthetic-tests/teams/README.md) |
| OneDrive | [Accounts and worker permissions](./onedrive-permissions.md), then [folder provisioning](./onedrive-setup.md) | [OneDrive README](../synthetic-tests/onedrive/README.md) |
| SharePoint Online | [Sites, fixtures, Selected access and discovery](./sharepoint-permissions.md) | [SharePoint README](../synthetic-tests/sharepoint/README.md) |
| Optional provider context | [Service Health, Message Center and beta activity consent/federation](./provider-monitoring.md) | Exact provider endpoints are in the same runbook |

Azure roles do not confer Microsoft 365 administrator rights, service licenses or
Graph application permissions. Use an approved Azure subscription associated with
the monitored Microsoft 365 tenant; see [tenant binding](./cross-tenant-access.md).

## Tools and operator access

Install Node.js 22 or 24, npm, Git, Azure CLI with Bicep, and PowerShell 7.4+.
Exchange administration additionally needs the module in its own setup guide.
From the repository root:

```sh
npm ci --prefix synthetic-tests
az login --tenant <approved-tenant-id>
az account set --subscription <approved-subscription-id>
```

| Operator action | Required authority |
| --- | --- |
| Deploy Azure resources and scoped role assignments | Owner, or Contributor plus User Access Administrator, on the approved resource scope |
| Upload/download one-off setup inputs and results | Storage Blob Data Contributor on the configuration container; deployment grants its operator this access |
| Create/verify the Function API app and service principal | Tenant-approved app-registration/enterprise-app administration rights |
| Grant Microsoft 365 application permissions | The separately authorized administrator named in each service/provider guide |

Administrator Azure CLI sessions are used for setup/deployment only. Runtime
Functions use explicitly selected managed identities, never that CLI session.
Do not store passwords, tokens, private keys or certificates in config or Git.

## Configure the deployment and selected services

Root [monitoring.config.json](../monitoring.config.json) owns `healthModel`,
`deployment`, `logAnalytics`, `serviceHealth`, tenant IDs and the optional tenant
`providerClientId`. Its `serviceFiles` map loads four files:

| File | Matching `tenants[].config` owns |
| --- | --- |
| [monitoring.exchange.json](../monitoring.exchange.json) | Exchange identity, mailbox groups, scenarios and execution |
| [monitoring.teams.json](../monitoring.teams.json) | Teams identity, bot pairs, channels/meetings, readback and execution |
| [monitoring.onedrive.json](../monitoring.onedrive.json) | OneDrive identity, account groups, setup identity and execution |
| [monitoring.sharepoint.json](../monitoring.sharepoint.json) | SharePoint identity, site/library/folder/list targets and execution |

Match each service entry's `id` to the root tenant alias. Paths such as
`config.identity` in service guides refer to that service-file entry; the loader
composes it into `tenants[].services.<service>` for deployment/runtime.
Generated IDs belong in the adjacent gitignored [`.env`](./deployment.md#generated-ids-in-env),
not user-maintained target fields.

**Review before running:** the checked-in profile is live, not an offline
example. It enables all services, stable health/messages, Exchange/Teams beta
activity, Azure reporting and health alerts. Keep unapproved services disabled;
optional provider approvals are independent of synthetic access.

`logAnalytics.enabled: false` sends aggregate reports directly from execution
Functions to Azure Monitor Health Models. `true` sends observations directly
through the Logs Ingestion API/DCR to Log Analytics for KQL-backed model health.
Neither mode uses Event Hubs, Capture or an intermediary ingestion Function.
Both require private configuration storage. Action-group IDs select existing
Azure Monitor action groups; recipients remain managed in those groups.

## Prepare Azure resources and identities

Register the providers used by the selected deployment:

```sh
az provider register --namespace Microsoft.ManagedIdentity --wait
az provider register --namespace Microsoft.ContainerRegistry --wait
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.CloudHealth --wait
az provider register --namespace Microsoft.Web --wait
az provider register --namespace Microsoft.Storage --wait
az provider register --namespace Microsoft.Insights --wait
# When Teams is selected:
az provider register --namespace Microsoft.BotService --wait
# When logAnalytics.enabled is true:
az provider register --namespace Microsoft.OperationalInsights --wait

az group create --name <healthModel.resourceGroup> --location <deployment.location>
```

Prepare the registry and Container Apps environment named by
`deployment.foundation` when using `mode: "existing"`:

```sh
az acr create --name <registry-name> --resource-group <resource-group> \
  --location <location> --sku Basic --admin-enabled false
az containerapp env create --name <environment-name> --resource-group <resource-group> \
  --location <location> --enable-workload-profiles true --logs-destination none
```

Skip existing approved resources. A bare resource name resolves in the root
subscription/resource group; use a full resource ID for an existing resource
elsewhere. Create each configured service `identity` and every distinct Teams
primary/peer identity **before deployment preflight**:

```sh
az identity create --name <configured-identity-name> \
  --resource-group <resource-group> --location <location>
```

Creating an identity grants no Microsoft 365 access. Keep its non-secret
`clientId` (application ID), `principalId` (service-principal object ID) and resource
ID distinct. Teams Bot registrations are prepared in the
[Teams setup guide](./teams-permissions.md#prepare-the-bots-readback-and-callback).
Deployment manages normal image-pull, configuration, Function storage and reporting
roles; do not broaden service Graph grants to solve Azure reporting failures.

## Authenticate scheduled Function dispatch

From `synthetic-tests/`, using the approved operator session:

```sh
npm run setup:function-auth
```

[`setup/function-auth.ps1`](../synthetic-tests/setup/function-auth.ps1) creates or
verifies a dedicated single-tenant Function API registration with v2 tokens and
the selected dispatcher UAMI. It writes `FUNCTION_API_CLIENT_ID` and
`COORDINATOR_CLIENT_ID` to `.env`. Existing explicitly bound applications must
already satisfy its checks.

The dispatcher requests an application token for that API; the Functions validate
the token and enforce the single configured dispatcher identity. This is separate
from Graph authorization: the helper grants no Microsoft 365 permission and
creates no client secret, certificate or Function key. Teams calling notifications
have their own signed-notification validation.

## Deploy the foundation, authorize services, then enable scheduling

1. Set root `deployment.stage: "foundation"` and run from `synthetic-tests/`:
   ```sh
   npm run deploy -- --plan
   npm run deploy
   ```
   This establishes health models, configuration/reporting infrastructure and
   Function hosts before recurring execution. It does not grant Microsoft 365
   access. Preflight still requires the selected identities/bot registrations.
2. Complete each selected service's setup guide in the table above. Approve only
   its required roles, prepare fixtures and generate IDs. The ordinary
   `npm run setup:ids` processes all enabled live services; it performs operator
   lookups for Teams/OneDrive and dispatches SharePoint discovery as its selected
   UAMI. One-off commands need the deployed configuration storage and Container
   Apps environment. They launch tracked PowerShell jobs and report failures.
3. If provider context is wanted, separately approve the
   [provider application's roles and each service identity's federation](./provider-monitoring.md#provider-authentication).
4. After authorization, set each approved service's `execution.mode: "live"`,
   root `deployment.enableLiveProbes: true` and `deployment.stage: "all"`.
   Selected beta activity also requires `deployment.enableBetaServiceActivity: true`.
   Preview and deploy again with the same commands.

The Container App dispatches one Function invocation per selected journey case;
execution Functions publish results directly. Configuration and service-file
changes require redeployment of the resolved snapshot. Before relying on recurring
monitoring, verify actual operations, cleanup, accepted reports and notification/
freshness behavior using [operations](./operations.md). A successful setup or
deployment is not evidence that a Microsoft 365 journey passed.
