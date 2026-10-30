# Exchange permissions and managed identity setup

Use this guide to authorize the Exchange worker's explicitly selected
user-assigned managed identity (UAMI). Start with the shared
[account and Azure setup](./setup.md); identities and Microsoft 365 resources
must use the [supported tenant binding](./cross-tenant-access.md).
No mailbox password, user refresh token or runtime administrator role is needed.

## Approve the mailboxes and workload

Configure dedicated test mailboxes in root
[`monitoring.config.json`](../monitoring.config.json), under
`tenants[].services.exchange.targets.<groupId>.users[].mailbox`.
Use the mailbox address, not a manually assigned target ID or sender/recipient pair.
Confirm Exchange Online provisioning/licensing with the tenant owner using the
[test-account runbook](./setup.md#create-and-license-test-microsoft-365-accounts).
Reporting groups do not grant mailbox access.

Every selected journey runs for every mailbox on aligned **120-second boundaries**:

| Journey | Completed operation |
| --- | --- |
| `send-receive-mail` | Send to the same mailbox and verify its Inbox delivery |
| `edit-reopen-draft` | Create, read, edit, reopen and delete an own-mailbox draft |
| `attachment-mail` | Send an attachment to self, download it and verify its bytes/hash |
| `reply-mail` | Send and verify a SELF-REPLY to a retained received self-addressed fixture |
| `recurring-calendar` | Create, verify, update and delete a private recurring series without attendees |

With all three sending journeys selected, the nominal load is **2,160 submitted
messages/day/mailbox**, or 64,800 per thirty days, plus the retained setup fixture,
message copies, draft and calendar operations. A hundred mailboxes select 500
journey attempts every two minutes; that is requested load, not proven capacity.
Agree on cadence, mail-flow restrictions, retention and an escalation owner.

Each complete journey has a **60-second execution deadline**, separately bounded
cleanup and a **15-second latency degradation threshold**. Genuine service failures
and journey deadline expiry remain failures. Worker cancellation and cleanup-only
outcomes are Unknown without numeric success/failure samples; skipped actions are
not failed requests.

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

Obtain the UAMI's non-secret handoff values after
[foundation deployment](./deployment.md#deploy-with-one-command):
its resource ID selects the attached identity, `clientId` is the application ID,
and `principalId` is the **Enterprise application/service-principal object ID**,
not an app-registration object ID. The identity tenant must match Microsoft 365.
A same-tenant UAMI already has a service principal; it needs no new app registration.

An Exchange administrator with Organization Management or equivalent delegated
rights reviews and runs this **first-time example**, not the worker. Check existing
service-principal references, scopes and assignments before creating them.

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
scope to every configured mailbox using the
[manual scope-maintenance runbook](./setup.md#4-exchange-mailbox-access).
Review the full filter and Exchange recipient-filter length limits as the inventory grows.

Every approved mailbox must be in scope and the control mailbox out of scope.
`Test-ServicePrincipalAuthorization` does **not** evaluate separate Entra grants;
audit those too. Under administrator supervision, verify actual allowed Graph
operations and a read-only denied-access control before scheduling. Permission
changes can take roughly 30 minutes to two hours to propagate to live requests.

## Fixtures, configuration and verification

Select `worker.identity` and keep `execution.graphAuthentication` and
`execution.healthReportAuthentication` as `managed-identity` (their defaults).
Hosted Graph authentication uses the selected `AZURE_CLIENT_ID` and
`https://graph.microsoft.com/.default`, without a developer-login or credential fallback.
Live commands require an Azure host with that identity attached.

For `reply-mail`, run `npm run setup:reply-seeds` after authorization. This uses the
Exchange worker identity in a disposable Container Apps Job to provision/validate
one retained received self-addressed fixture per mailbox, outside timed journeys.
It writes generated reply bindings to the adjacent gitignored
[`.env`](./deployment.md#generated-ids-in-env); do not put fixture IDs in the config.
There is no second account, attendee or distribution-list requirement.

Follow the [live gates](./deployment.md#live-execution-gates) and
[operational verification](./operations.md#enterprise-reliability-acceptance-gate)
before recurrence. Azure configuration-reader, image-pull, report-ingestion and
optional Event Hubs permissions are separate from Exchange authorization; see
[reporting permissions](./deployment.md#identity-and-permissions).

## Implemented Graph endpoints

All paths below are under `https://graph.microsoft.com/v1.0`.
`{mailbox}` is always the selected mailbox; query strings select/filter owned
messages or the recurrence time window.

| Method and path | Use |
| --- | --- |
| `POST /users/{mailbox}/messages` | Create a draft, optionally containing an attachment |
| `GET /users/{mailbox}/messages`; `GET /users/{mailbox}/mailFolders/inbox/messages` | Locate owned copies, retained fixtures and delivered self-mail |
| `GET`, `PATCH`, `DELETE /users/{mailbox}/messages/{messageId}` | Verify/edit drafts, read the fixture and remove owned messages |
| `POST /users/{mailbox}/messages/{messageId}/send` | Submit a draft or SELF-REPLY |
| `POST /users/{mailbox}/messages/{messageId}/createReply` | Create the SELF-REPLY draft |
| `GET /users/{mailbox}/messages/{messageId}/attachments`; `GET .../attachments/{attachmentId}` | Read attachment metadata and `contentBytes` for verification |
| `POST`, `GET /users/{mailbox}/events`; `GET`, `PATCH`, `DELETE /users/{mailbox}/events/{eventId}` | Private recurring-series lifecycle and owned-artifact reconciliation |
| `GET /users/{mailbox}/events/{eventId}/instances` | Verify recurring occurrences |

These are API-backed mailbox journeys, not Outlook UI checks.
The [Exchange implementation](../synthetic-tests/exchange/src/) contains the
operation and ownership checks.

## Optional provider context

Provider permissions belong to the independently selected federated provider
application, not the Exchange mailbox RBAC grant:

| Enabled source | Graph application permission |
| --- | --- |
| Stable Service Health overviews/issues | `ServiceHealth.Read.All` |
| Message Center | `ServiceMessage.Read.All` |
| Nine optional Exchange beta `serviceActivity` methods | `ServiceActivity-Exchange.Read.All` |

These are tenant-wide read grants; runtime service filters do not scope consent.
Use the [provider runbook](./provider-monitoring.md) for exact endpoints, independent
provider cadence, federation and live/beta gates. All collected context stays on
the single suppressed `exchange-service-health` entity and cannot alter synthetic
outcomes, business-step measurements or Experience rollup. A beta 403 does not
establish a licensing cause.

## Handoff and revocation

Ask the tenant owner to return the approved mailbox inventory, identity/scope/role
details, allowed/denied test results, retention/mail-flow constraints and named
escalation owner. Stop the worker before revocation; remove only its owned grants,
allow for propagation/existing tokens and review only confirmed synthetic artifacts.
Never purge a mailbox or remove a shared scope/identity without checking its consumers.

Microsoft references:
[Exchange application RBAC and permission union](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac),
[Container Apps managed identities](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity).
