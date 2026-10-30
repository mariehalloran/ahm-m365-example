# Setup: Microsoft 365 test accounts and Azure access

Start here before the first deployment. Create dedicated test accounts, configure
the project, grant access, then generate required service IDs and fixtures and deploy. Repeat the relevant
steps whenever you add a tenant, service or target.

## Prerequisites

You need an approved Microsoft 365 test tenant with available licenses for the
selected services, and an Azure subscription for Azure Monitor Health Models and
the workers. An Azure subscription alone does not provide Microsoft 365 accounts
or licenses.

Install Node.js 22 or 24, npm, Git, the Azure CLI and PowerShell 7.4+. Exchange
administration also needs the `ExchangeOnlineManagement` PowerShell module:
`Install-Module ExchangeOnlineManagement -Scope CurrentUser`.
From the repository root, install the project's dependencies:

```sh
npm ci --prefix synthetic-tests
```

## Create and license test Microsoft 365 accounts

Use dedicated, non-administrator accounts rather than employee accounts: the
journeys create mail, drafts, private appointments and files. The project does
**not** create user accounts, buy licenses or assign licenses.

1. Sign in to the [Microsoft 365 admin center](https://admin.microsoft.com) as a
   **User Administrator** in the tenant you intend to monitor. Go to **Users >
   Active users > Add a user**.
2. Enter a recognizable display name and username, such as `m365-monitor-001`,
   and select one of your tenant's verified domains. Record the resulting user
   principal name (UPN), such as `m365-monitor-001@yourtenant.onmicrosoft.com`.
3. Set the user's usage location. For Exchange Multi-Geo, follow the
   [PDL setup below](#optional-exchange-multi-geo-placement) before licensing.
   Assign a license covering the services below. Expand **Apps** and confirm the
   required service plans are enabled; not every Microsoft 365 subscription includes Teams.
4. Leave the account without administrator roles. Store its generated password in
   your approved password manager, never in the config, `.env` or Git. Retain your
   normal sign-in protections; the hosted workers use application identities,
   not these users' passwords or refresh tokens.
5. Finish creating the user and repeat for each required account. Wait for license
   assignment and service provisioning to complete before generating fixtures or
   running live journeys.

| Account use | Required service | Root config field under `tenants[].services` |
| --- | --- | --- |
| Exchange mailbox | Exchange Online, including mail and calendar | `exchange.targets.<groupId>.users[].mailbox` |
| OneDrive owner | SharePoint Online / OneDrive entitlement | `onedrive.targets.<groupId>.users[].userPrincipalName` |
| Teams meeting organizer | Microsoft Teams | `teams.callTargets[].organizer` |

Each Exchange target exercises its **own** mailbox for every selected
journey. Teams synthetic
participants are **managed-identity bots**, not licensed user accounts. A licensed
test user prepares the test team/meeting fixtures; it does not answer probe calls.

Verify each Exchange mailbox exists in the Exchange admin center before applying
the mailbox scope below. For OneDrive, either open OneDrive once as the test user
or have a licensed SharePoint Administrator
[pre-provision the personal site](https://learn.microsoft.com/en-us/sharepoint/pre-provision-accounts).
Users must be licensed and allowed to sign in for pre-provisioning. Application-only
Graph setup does not create personal OneDrives; wait until the drive exists before
running [folder setup](./onedrive-setup.md#provision-personal-onedrives).

For hundreds of accounts, use **Users > Active users > Add multiple users** and
the admin center's downloadable CSV template instead of adding them one by one.
Keep bulk-upload files and exported passwords outside Git. Microsoft's
[account creation guide](https://learn.microsoft.com/en-us/microsoft-365/admin/add-users/add-users)
and [license assignment guide](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/assign-licenses-to-users)
cover bulk creation and existing accounts.

### Optional Exchange Multi-Geo placement

To monitor mailboxes in different geographies, follow Microsoft's
[Exchange Online Multi-Geo administration guide](https://learn.microsoft.com/en-us/microsoft-365/enterprise/administering-exchange-online-multi-geo?view=o365-worldwide).
This requires appropriate Multi-Geo licensing and an enabled destination geography.

- **New cloud-only accounts:** create the user without an Exchange license, set
  `PreferredDataLocation` (PDL) on its Entra user with Microsoft Graph PowerShell
  (for example, `EUR`), then assign the license.
- **Synchronized accounts:** configure PDL in on-premises Active Directory and
  synchronize it through Microsoft Entra Connect.
- **Existing mailboxes:** changing PDL initiates an asynchronous relocation.
  Verify the actual mailbox database geography in Exchange Online PowerShell;
  the requested PDL alone does not prove that the move has completed.

Country and `UsageLocation` alone do not select mailbox placement. PDL selects a
geography, not a particular stamp or database. Reporting group names do not change
mailbox placement.

## Configure the project

Edit the repository-root [monitoring.config.json](../monitoring.config.json) for
your Azure destination and Microsoft 365 tenants, replacing this repository's
real test-tenant settings. 

Use the account fields in the table above, the selected scenarios and execution settings.
Exchange uses the mailbox address and OneDrive uses the UPN as the account identity;
do not assign account target IDs. Teams channel and meeting targets retain their `id`.
Put Exchange/OneDrive user targets in
[`targets.<groupId>.users`](./monitoring-groups.md), with `userGroupName` alongside
each `users` array; there is no separate root group list. Supply the ungrouped Teams channel and meeting
references and approved provider/readback app registrations where selected.
See [what the config holds](./deployment.md#what-the-config-holds) for each field.
The root `logAnalytics.enabled` toggle selects direct container health reports
(`false`) or the optional Event Hub/Function/DCR/Log Analytics pipeline (`true`).
Pipeline resource names are required only when enabled; Capture is optional within
that mode. Select the active mode explicitly. Both modes use private configuration
storage named by `deployment.configurationStorageAccount`; that store is not a log
pipeline. No additional Microsoft 365 permissions are needed for either Azure reporting path.
Reference existing Azure Monitor action groups with `healthModel.alertActionGroupIds`;
manage recipients in the action groups, not this config
([root alerts](../health-model/README.md#root-health-alerts)).

**Review the live settings:** the checked-in config enables live probes, Azure
Monitor export, stable Service Health, Exchange beta Service Activity and root
health alerts. Optional features default off when omitted, but this config is not
an offline example. Beta collection requires separate approval.

## What the setup helpers do

Two PowerShell helpers read the root config and write generated bindings to the
gitignored `.env` beside it. They do not create or license accounts or grant
application permissions:

- `npm run setup:ids` ([`setup/generate-ids.ps1`](../synthetic-tests/setup/generate-ids.ps1)):
  finds or creates the named Teams channel, and looks up the peer bot's client ID, the Teams
  calling callback URL, the meeting organizer's user ID and each OneDrive account's user ID.
- `npm run setup:reply-seeds` ([`setup/provision-reply-seeds.ps1`](../synthetic-tests/setup/provision-reply-seeds.ps1)):
  provisions the retained SELF-REPLY message each reply-mail mailbox answers.

Both are idempotent (safe to run again) and read the same root config. Run them after the
grants below exist; [deployment.md](./deployment.md#generated-ids-in-env) lists the exact
`.env` keys they write. OneDrive's folders are a separate, separately approved command,
[`npm run onedrive:setup`](./onedrive-setup.md).

## Roles you need

| Step | Role |
| --- | --- |
| Test account creation and licensing | User Administrator; License Administrator can manage licenses separately |
| Personal OneDrive pre-provisioning | SharePoint Administrator with a SharePoint license |
| 1-3 (Azure resources, identities, AcrPull) | Owner, or Contributor + User Access Administrator, on the subscription or resource group |
| 4 (Exchange) | Exchange Organization Management, or an equivalent delegated role |
| 5 (Entra application roles, federated credentials) | Privileged Role Administrator or Global Administrator, and Application Administrator |
| 6 (Teams bots, app) | The Azure role above, plus a Teams administrator to publish the app |

Azure roles do not confer Microsoft 365 administrator roles. Before the commands
below, sign in with `az login` to the appropriate tenant and subscription. The
PowerShell helpers select the configured tenant matching your current Azure CLI
login; repeat the Microsoft 365 steps and helpers for each configured tenant.

## 1. Resource providers and the resource group

```sh
az provider register --namespace Microsoft.ManagedIdentity --wait
az provider register --namespace Microsoft.ContainerRegistry --wait
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.BotService --wait
az provider register --namespace Microsoft.CloudHealth --wait
# Only when logAnalytics.enabled is true:
az provider register --namespace Microsoft.OperationalInsights --wait
az provider register --namespace Microsoft.Insights --wait
az provider register --namespace Microsoft.EventHub --wait
az provider register --namespace Microsoft.Web --wait

# Required for private configuration storage in both modes:
az provider register --namespace Microsoft.Storage --wait

az group create --name <healthModel.resourceGroup> --location <deployment.location>
```

## 2. Container registry, Container Apps environment and managed identities

Only the resources a bare name in the config asks for; skip any that are already a full
`/subscriptions/...` resource ID (someone else's). This example matches the Consto test
tenant's config:

```sh
RG=rg-m365-consto; LOCATION=centralus

az acr create --name crm365ctbcoagujf67a --resource-group $RG --location $LOCATION \
  --sku Basic --admin-enabled false --public-network-enabled true

az containerapp env create --name cae-m365-experience-consto --resource-group $RG --location $LOCATION \
  --enable-workload-profiles true --logs-destination none

# One identity per hosted service named in worker.identity, plus the second Teams bot's
# identity in access.peerIdentity, only when scheduled-meeting is selected:
for NAME in uami-m365-experience-consto-exchange uami-m365-experience-consto-teams \
            uami-m365-experience-consto-onedrive uami-m365-experience-consto-teams-peer; do
  az identity create --name $NAME --resource-group $RG --location $LOCATION
done
```

A managed identity has no access of its own; creating one grants nothing until steps 4-5.

## 3. AcrPull on the registry

Skip this: `npm run deploy` grants it itself, to every identity a worker needs, as part of
its foundation stage (`synthetic-tests/infra/registry-pull.bicep`). It is listed here only
so an audit of "who can pull from the registry" finds it in one place.

## 4. Exchange: mailbox access

Follow [MAILBOX-SYNTHETIC-ACCESS.md, section 4](../MAILBOX-SYNTHETIC-ACCESS.md#4-illustrative-exchange-administrator-setup)
for the first mailbox and role assignments, then extend the same scope's filter to cover
every mailbox in `tenants[].services.exchange.targets.<groupId>.users[].mailbox`,
deduplicated across groups and joined with `-or`:

```powershell
Connect-ExchangeOnline -UserPrincipalName "<approved-admin>"

$scopeName = "AHM-Exchange-<alias>-ManagedIdentity"
$mailboxes = "user1@contoso.example", "user2@contoso.example"   # every configured target
$filter = ($mailboxes | ForEach-Object { "(PrimarySmtpAddress -eq '$_')" }) -join ' -or '
Set-ManagementScope -Identity $scopeName -RecipientRestrictionFilter $filter

foreach ($mailbox in $mailboxes) { Test-ServicePrincipalAuthorization -Identity $principalId -Resource $mailbox }
```

Grant only the roles the selected scenarios use: `Application Mail.ReadWrite` and
`Application Mail.Send` for send-receive-mail/edit-reopen-draft/attachment-mail/reply-mail,
`Application Calendars.ReadWrite` for recurring-calendar. `Test-ServicePrincipalAuthorization`
reflects a scope change immediately; the running worker can still see HTTP 403 for a newly
added mailbox for up to 2 hours.

## 5. Microsoft Graph application roles and federated credentials

Grant each only where the matching scenario is selected, to the identity's own service
principal (`az ad sp show --id <principalId>` or `az identity show ... --query principalId`):

| Identity | Role | When |
| --- | --- | --- |
| Teams worker, Teams peer | `Calls.JoinGroupCall.All` | `scheduled-meeting` selected |
| OneDrive worker | `Files.SelectedOperations.Selected` | OneDrive enabled |
| OneDrive worker | `Files.ReadWrite.AppFolder` | `app-folder-lifecycle` selected |
| `tenants[].providerClientId` app | `ServiceHealth.Read.All` | `serviceHealth.enabled` |
| `tenants[].providerClientId` app | `ServiceActivity-Exchange.Read.All` / `-Teams.Read.All` | that service's `serviceActivity.enabled` and `deployment.enableBetaServiceActivity` |

```sh
GRAPH_SP=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)
ROLE_ID=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 \
  --query "appRoles[?value=='Calls.JoinGroupCall.All'].id" -o tsv)
az rest --method post --url "https://graph.microsoft.com/v1.0/servicePrincipals/$PRINCIPAL_ID/appRoleAssignments" \
  --body "{\"principalId\":\"$PRINCIPAL_ID\",\"resourceId\":\"$GRAPH_SP\",\"appRoleId\":\"$ROLE_ID\"}"
```

Each identity that calls the **provider** app registration (`providerClientId`) or the
**Teams readback** app registration (`teamsReadbackClientId`) needs a federated credential
on that app, so it can sign in as that app with no secret:

```sh
az rest --method post --url "https://graph.microsoft.com/v1.0/applications/<app object id>/federatedIdentityCredentials" \
  --body "{\"name\":\"<tenant alias>-<service>-worker\",\"issuer\":\"https://login.microsoftonline.com/<tenantId>/v2.0\",\"subject\":\"<identity principalId>\",\"audiences\":[\"api://AzureADTokenExchange\"]}"
```

If you ever recreate an identity (a new resource group, a deleted-and-recreated identity),
its `principalId` changes: repoint that identity's federated credential(s) to the new value,
on both the provider app and, for the Teams worker, the readback app.

## 6. Teams: bots, team and channel, app

**Bots.** One Azure Bot per identity in `access.bot` and (when `scheduled-meeting` is
selected) `access.peerBot`, bound to that identity, with its Teams channel:

```sh
az bot create --name <access.bot name> --resource-group $RG --app-type UserAssignedMSI \
  --appid <identity clientId> --msi-resource-id <identity resource ID> \
  --tenant-id <tenants[].tenantId> --sku F0 --location global

# Only when scheduled-meeting is selected, the calling callback URL (from npm run setup:ids):
az bot msteams create --name <access.bot name> --resource-group $RG \
  --enable-calling --calling-web-hook "https://<teams worker appName>.<environment default domain>/api/calls"
```

**Team and channel.** Prepare an approved dedicated test team for each ungrouped
Teams target's `teamId`, and create the channel named by its `channelName`
(or run `npm run setup:ids`, which does both the channel lookup/creation and the client-ID
and URL lookups above in one pass once the bots and identities exist).
Exchange/OneDrive user groups do not grant Teams membership.

**Teams app.** The project's app template lives in
[`synthetic-tests/setup/teams-app/`](../synthetic-tests/setup/teams-app/) (`manifest.json`
with `{{placeholders}}`, plus the two icons). Fill in `version`, `appId` (reuse the existing
app's `externalId` when updating it, otherwise the bot's client ID), `botId` (the bot's
client ID), `calling` (`true`/`false`), `host` (`<teams worker appName>.<environment default
domain>`) and `readbackClientId`, then zip the three files and, as a Teams administrator:

1. Teams admin center > Teams apps > Manage apps > upload the package (or update the
   existing "M365 Synthetic Bot").
2. Teams > the team > Manage team > Apps > add or update "M365 Synthetic Bot" (it asks to
   consent to `ChannelMessage.Read.Group` for that team only).

**Fixing a stale app after the bot is recreated.** The installed Teams app is a
Microsoft 365 tenant object, independent of the Azure resource group. If the bot's
identity is ever deleted and recreated (for example, rebuilding the resource group),
the previously installed app still points at the old bot's client ID, and channel
messages start failing at the `post-message` step with `diagnosticCategory:
"permission-failure"` / `httpStatus: 403` even though the app still shows as
installed. To fix it:

1. Run `npm run setup:ids` to regenerate the package with the current bot's client ID
   (bump `version` first if you edited the template manually instead).
2. Re-upload it and re-add it to the team as in the two steps above.
3. If Teams creates a separate "M365 Synthetic Bot" entry instead of updating the
   existing one in place (happens when the new package's `id` doesn't match the
   previously uploaded app's `externalId`), remove the old, stale entry from the team
   and the org catalog so no dead binding is left behind.
4. Confirm the fix by checking the Teams worker's logs on the next cycle for
   `post-message`/`permission-failure` entries to stop appearing (see
   [Verify monitoring](#verify-monitoring)).

## 7. Generate the `.env` values and deploy

Obtain administrator-approved [access](./cross-tenant-access.md) before enabling
live workers. Each hosted service explicitly selects its managed identity in
`worker.identity`; Teams participants use bot identities, never employee tokens.

Set the service's `execution.mode` to `"live"` and
`deployment.enableLiveProbes` to `true`. Deployment rejects live workers without
that approval and sets `ENABLE_LIVE_M365=true` for them. A local live run must set
that environment variable explicitly.

OneDrive folder setup needs a separately approved `tenants[].services.onedrive.setup`
identity and a suitable host. Review its plan before applying, following the
[OneDrive setup guide](./onedrive-setup.md#plan-apply-and-rerun).

```sh
cd synthetic-tests
npm run setup:ids
npm run setup:reply-seeds    # only when reply-mail is selected
npm run onedrive:setup -- --apply   # only when OneDrive is selected; see docs/onedrive-setup.md
npm run deploy -- --plan
npm run deploy
```

Before deploying, use the Azure subscription in `healthModel.subscriptionId`;
its tenant must match `deployment.azureTenantId`, which defaults to the monitored
tenant for a single-tenant config. Deployment creates the health models before
building and rolling out the workers; see
[deployment order and options](./deployment.md#deploy-with-one-command).

## Verify monitoring

Neither fixture generation nor a successful deployment proves a journey passed.

Run one real cycle first and inspect completed operations, cleanup, accepted
reports, service/root roll-up and notification delivery. Follow the
[operational acceptance gate](./operations.md#enterprise-reliability-acceptance-gate).
For local simulation and individual service commands, see the
[runtime README](../synthetic-tests/README.md).
