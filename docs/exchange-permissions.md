# Exchange permissions and managed identity setup

Use this guide to prepare Exchange test accounts and authorize the execution Function's explicitly selected
user-assigned managed identity (UAMI). Start with the shared
[Azure setup](./setup.md); identities and Microsoft 365 resources
must use the [supported tenant binding](./cross-tenant-access.md).
No mailbox password, user refresh token or runtime administrator role is needed.

## Approve the mailboxes and workload

In the Microsoft 365 admin center, a **User Administrator** creates dedicated,
non-administrator test users and assigns an Exchange Online license with mail
and calendar enabled. A License Administrator can manage licenses separately.
Wait for provisioning and verify each mailbox in the Exchange admin center
before granting access. The project creates no accounts or licenses.

Use **Users > Active users > Add a user**, or **Add multiple users** with the
admin center CSV template for larger inventories. Keep account passwords and
bulk exports in the approved password manager/storage, never Git or `.env`.
Normal sign-in protections remain in place; runtime does not sign in as users.

Configure dedicated test mailboxes in
[`monitoring.exchange.json`](../monitoring.exchange.json), under the matching
`tenants[].config.targets.<groupId>.users[].mailbox`.
Use the mailbox address, not a manually assigned target ID or sender/recipient pair.
Reporting groups do not grant mailbox access.

The checked-in configuration runs every selected journey for every mailbox on
aligned **600-second boundaries**, with a **240-second complete-journey deadline**.
Cadence and budgets come from `config.execution`, not hardcoded runtime limits:

| Journey | Completed operation |
| --- | --- |
| `send-receive-mail` | Create, read, edit and reopen a draft, then send it to the same mailbox and verify Inbox delivery |
| `attachment-mail` | Send an attachment to self, download it and verify its bytes/hash |
| `reply-mail` | Send and verify a SELF-REPLY to a retained received self-addressed fixture |
| `recurring-calendar` | Create, verify, update and delete a private recurring series without attendees |

With all three sending journeys selected, the nominal load is **432 submitted
messages/day/mailbox**, or 12,960 per thirty days, plus the retained setup fixture,
message copies, draft and calendar operations. A hundred mailboxes select 400
journey attempts every ten minutes; that is requested load, not proven capacity.
Agree on cadence, mail-flow restrictions, retention and an escalation owner.

Cleanup is separately bounded; latency above **15 seconds is Degraded only**.
Genuine service failures
and journey deadline expiry remain failures. Worker cancellation and cleanup-only
outcomes are Unknown without numeric success/failure samples; skipped actions are
not failed requests.

### Optional Exchange Multi-Geo placement

For geographically placed mailbox targets, obtain Multi-Geo licensing and follow
[Exchange Online Multi-Geo administration](https://learn.microsoft.com/en-us/microsoft-365/enterprise/administering-exchange-online-multi-geo?view=o365-worldwide).
For a new cloud-only account, set its Entra `PreferredDataLocation` (for example
`EUR`) before assigning the Exchange license. For synchronized users, set it in
on-premises AD and synchronize through Entra Connect.

Existing mailbox moves are asynchronous: verify actual mailbox database geography
in Exchange Online PowerShell. Country, `UsageLocation`, requested PDL and reporting
group names do not prove mailbox placement or select a specific database.

## Required synthetic permissions

Use **Exchange Online RBAC for Applications**, scoped to the approved mailboxes:

| Exchange application role | Selected operations |
| --- | --- |
| `Application Mail.ReadWrite` | Drafts, Inbox/retained-fixture reads, attachments, reply drafts and owned-message cleanup |
| `Application Mail.Send` | Self-mail, attachment delivery, SELF-REPLY and retained-fixture submission; not needed for draft-only execution |
| `Application Calendars.ReadWrite` | Only `recurring-calendar`, including owned-series cleanup |

**Do not also grant tenant-wide Entra Graph `Mail.ReadWrite`, `Mail.Send` or
`Calendars.ReadWrite` application permissions.** Entra and Exchange permissions are
a union, not an intersection: an additional broad Entra grant bypasses the intended
mailbox boundary. `Exchange.ManageAsApp` and delegated FullAccess/SendAs are not
required by these Graph journeys.

Mailbox-scoped read/write covers every message in an approved mailbox, not only
synthetic content. `Mail.Send` limits who the app sends **as**, not who it sends
**to**. Dedicated mailboxes and any required tenant mail-flow policy remain
administrator responsibilities; runtime self-recipient checks are not a tenant
permission boundary.

## Exchange application RBAC

Create/select the UAMI during [shared Azure preparation](./setup.md#prepare-azure-resources-and-identities)
and obtain its non-secret handoff values:
its resource ID selects the attached identity, `clientId` is the application ID,
and `principalId` is the **Enterprise application/service-principal object ID**,
not an app-registration object ID. The identity tenant must match Microsoft 365.
A same-tenant UAMI already has a service principal; it needs no new app registration.

An Exchange administrator with Organization Management or equivalent delegated
rights reviews and runs this **first-time example**, not the worker. Check existing
service-principal references, scopes and assignments before creating them.
Install `ExchangeOnlineManagement` if needed:
`Install-Module ExchangeOnlineManagement -Scope CurrentUser`.

```powershell
Connect-ExchangeOnline -UserPrincipalName "<approved-admin-in-the-mailbox-tenant>"

$expectedTenantId = "<Microsoft 365 tenant ID>"
$clientId = "<Exchange worker managed identity clientId>"
$principalId = "<Exchange worker managed identity principalId>"
$mailbox = "<first-approved-mailbox>"
$controlMailbox = "<approved-existing-out-of-scope-mailbox>"
$scopeName = "AHM-Exchange-<alias>-ManagedIdentity"

if ((Get-ConnectionInformation | Select-Object -First 1).TenantID -ne $expectedTenantId) {
    throw "Connected Exchange tenant does not match the approved tenant."
}
if ((Get-OrganizationConfig).IsDehydrated) {
    throw "Obtain tenant-owner approval for Enable-OrganizationCustomization before continuing."
}

New-ServicePrincipal -AppId $clientId -ObjectId $principalId `
    -DisplayName "AHM Exchange synthetic identity"
New-ManagementScope -Name $scopeName `
    -RecipientRestrictionFilter "(PrimarySmtpAddress -eq '$mailbox')"
New-ManagementRoleAssignment -Name "AHM-Synthetic-MailReadWrite" `
    -App $principalId -Role "Application Mail.ReadWrite" -CustomResourceScope $scopeName
New-ManagementRoleAssignment -Name "AHM-Synthetic-MailSend" `
    -App $principalId -Role "Application Mail.Send" -CustomResourceScope $scopeName
# Only when recurring-calendar is selected:
New-ManagementRoleAssignment -Name "AHM-Synthetic-CalendarsReadWrite" `
    -App $principalId -Role "Application Calendars.ReadWrite" -CustomResourceScope $scopeName

Test-ServicePrincipalAuthorization -Identity $principalId -Resource $mailbox
Test-ServicePrincipalAuthorization -Identity $principalId -Resource $controlMailbox
```

Omit roles unused by the selected journeys. If organization customization is
required, obtain approval, run it once and wait for completion. Extend this same
scope to every configured mailbox using [scope maintenance below](#maintain-the-approved-mailbox-scope).

Every approved mailbox must be in scope and the control mailbox out of scope.
`Test-ServicePrincipalAuthorization` does **not** evaluate separate Entra grants;
audit those too. Under administrator supervision, verify actual allowed Graph
operations and a read-only denied-access control before scheduling. Permission
changes can take roughly 30 minutes to two hours to propagate to live requests.

## Maintain the approved mailbox scope

In the authorized Exchange administrator connection, include **every** approved
mailbox from all configured groups, deduplicated. Review existing scope members:
`Set-ManagementScope` replaces the whole filter, not just the new clauses.

```powershell
$principalId = "<Exchange execution UAMI principalId>"
$scopeName = "AHM-Exchange-<alias>-ManagedIdentity"
$mailboxes = "user1@contoso.example", "user2@contoso.example"
$filter = ($mailboxes | ForEach-Object { "(PrimarySmtpAddress -eq '$_')" }) -join ' -or '
Set-ManagementScope -Identity $scopeName -RecipientRestrictionFilter $filter
foreach ($mailbox in $mailboxes) {
    Test-ServicePrincipalAuthorization -Identity $principalId -Resource $mailbox
}
```

Audit an approved out-of-scope control and broad Entra grants too.
Review Exchange recipient-filter length limits as the inventory grows.
Authorization readback reflects a scope change before live Graph caches
necessarily do; allow propagation before accepting monitoring.

## Fixtures, configuration and verification

Select `config.identity` in the Exchange service file and keep `execution.graphAuthentication` and
`execution.healthReportAuthentication` as `managed-identity` (their defaults).
Hosted Graph authentication uses the selected `AZURE_CLIENT_ID` and
`https://graph.microsoft.com/.default`, without a developer-login or credential fallback.
Live commands require an Azure host with that identity attached.

For `reply-mail`, run `npm run setup:reply-seeds` from `synthetic-tests/` after
the shared Azure foundation and authorization. The operator uses the approved
Azure CLI session to launch a disposable PowerShell Container Apps Job; Graph
operations inside it use only the selected Exchange identity to provision/validate
one retained received self-addressed fixture per mailbox, outside timed journeys.
It writes generated reply bindings to the adjacent gitignored
[`.env`](./deployment.md#generated-ids-in-env); do not put fixture IDs in the config.
There is no second account, attendee or distribution-list requirement.

Follow the [live gates](./deployment.md#live-execution-gates) and
[operational verification](./operations.md#enterprise-reliability-acceptance-gate)
before recurrence. Azure configuration-reader, image-pull, report-ingestion and
optional Logs Ingestion permissions are separate from Exchange authorization; see
[reporting permissions](./deployment.md#identity-and-permissions).

## Implemented Graph endpoints

The [Exchange README](../synthetic-tests/exchange/README.md#graph-endpoints)
maps every Graph v1.0 message, attachment and calendar path to its journey.
Self-addressed fixtures use the same scoped message operations, outside the timed
reply attempt. These are API-backed mailbox journeys, not Outlook UI checks.

## Optional provider context

Provider permissions belong to the independently selected federated provider
application, not the Exchange mailbox RBAC grant:

| Enabled source | Graph application permission |
| --- | --- |
| Stable Service Health overviews/issues | `ServiceHealth.Read.All` |
| Message Center | `ServiceMessage.Read.All` |
| Nine optional Exchange beta `serviceActivity` methods | `ServiceActivity-Exchange.Read.All` |

These are tenant-wide read grants; runtime service filters do not scope consent.
Use the [provider runbook](./provider-monitoring.md#provider-authentication) for
consent/federation, and the [Exchange endpoint summary](../synthetic-tests/exchange/README.md#optional-provider-endpoints)
for the selected sources. Provider settings live in `config.execution`;
root `serviceHealth.enabled` must also be true. Follow the runbook for independent
provider cadence, federation and live/beta gates. All collected context stays on
the single suppressed `exchange-service-health` entity and cannot alter synthetic
outcomes, business-step measurements or Experience rollup. A beta 403 does not
establish a licensing cause.

## Handoff and revocation

Ask the tenant owner to return the approved mailbox inventory, identity/scope/role
details, allowed/denied test results, retention/mail-flow constraints and named
escalation owner. Stop service scheduling before revocation; remove only its owned grants,
allow for propagation/existing tokens and review only confirmed synthetic artifacts.
Never purge a mailbox or remove a shared scope/identity without checking its consumers.

Microsoft references:
[Exchange application RBAC and permission union](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac),
[Container Apps managed identities](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity).
