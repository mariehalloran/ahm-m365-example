# Exchange synthetic permissions and managed identity setup

This is the administrator handoff for mailbox-scoped authorization. The default **same-Entra-tenant** path runs in Azure Container Apps and authenticates to Graph with an explicitly selected **user-assigned managed identity**. For a different M365 tenant, use a certificate-backed application registered in that tenant, with Azure report authentication kept separate; follow the [cross-tenant administrator walkthrough](./docs/cross-tenant-access.md). Both paths access only the approved synthetic participants.

No mailbox password is required. The same-tenant managed-identity path needs no application secret or customer-managed certificate. The explicit cross-tenant certificate path requires secure PEM storage/mounting and rotation; it never falls back from managed identity automatically.

The [shared Container Apps setup](./synthetic-tests/infra/README.md) separates identity creation from worker enablement and does not grant mailbox permissions. The separate health-model deployment does not establish Exchange access. Start with the [administrator walkthrough](./synthetic-tests/README.md#administrator-setup-enable-authentication-and-live-tests) for the full enablement sequence, including optional Graph app-role assignment.

## 1. What we need the administrators to provide

| Request | Why |
| --- | --- |
| Dedicated A/B shared/test mailboxes and an explicit synthetic distribution list with expected recipients | Complete cross-mailbox attachment/reply, list delivery and meeting journeys; keep business mailboxes outside the test |
| The Microsoft 365 tenant ID, primary SMTP address, mailbox object ID, and owner | Confirm the correct tenant/target and define a narrow scope |
| Approval for the Exchange worker's managed identity | Azure creates its service principal; Exchange must separately authorize it |
| Exchange RBAC application roles scoped only to approved participants | Permit draft/send/read/cleanup and the selected calendar actions |
| An approved out-of-scope control mailbox | Verify that unrelated mailbox access is denied, without sending/deleting there |
| Approved cadence, retention, mail-flow restrictions, and an escalation owner | Control volume, cleanup, and security impact |

The one-minute mail journey produces up to **1,440 messages/day or 43,200 per thirty-day month per target**, plus sent/received copies. The other five journey families run every five minutes and add mail/calendar operations. Agree on total volume before enabling live execution.

An eligible Exchange Online subscription must exist. A shared mailbox up to 50 GB generally needs no separate mailbox license; archive, hold, capacity, and advanced compliance/security features can change that. Human delegates need their own eligible licensing. Ask the tenant owner to confirm it.

An Azure subscription cannot itself host/create an Exchange Online mailbox. The default Graph managed-identity path assumes the **same Entra tenant**; explicit M365 certificate authentication supports different tenants without an Azure subscription in the mailbox tenant.

## 2. Permissions: separate the three responsibilities

### Azure deployment and identity attachment

The deploying operator needs rights to create the approved Container Apps resources and user-assigned identity, and to attach that identity. Examples are appropriately scoped resource Contributor/Managed Identity Contributor plus Managed Identity Operator where needed; use the organization's deployment role rather than granting broad access to the runtime identity.

If an existing private Azure Container Registry supplies the image, the attached identity needs the registry's appropriate image-pull role, commonly **AcrPull** for a registry using classic RBAC. ABAC-enabled registries have different repository roles. This is image access, not mailbox authorization.

**The worker identity does not need subscription Owner, Contributor, Exchange Administrator, Global Administrator, or Blob access.** It does need narrowly scoped health-report ingestion permission on its own service model, separate from mailbox authorization.

### Exchange mailbox authorization

Use **Exchange Online RBAC for Applications only**, scoped to the dedicated participants:

| Role | Journey steps that need it |
| --- | --- |
| `Application Mail.ReadWrite` | Create draft, look for Inbox delivery, find/delete this run's copies |
| `Application Mail.Send` | Submit the test draft as that mailbox |
| `Application Calendars.ReadWrite` | Create/read/update/delete recurring events, invite/accept/observe/cancel meetings; needed only for selected calendar journeys |

The administrator registers the existing managed identity's service-principal reference in Exchange, creates a resource scope, and assigns those roles only to approved A/B participants. Configure root `mailbox`, `recipientMailbox`, and `distributionList: { address, expectedRecipients }`; the worker neither discovers members nor adds grants. Verify actual Graph access as well as RBAC diagnostics after propagation, including denial of an unrelated control account. See [seven journeys, APIs and cleanup rules](./synthetic-tests/exchange/README.md).

**Do not additionally grant tenant-wide Entra Microsoft Graph `Mail.ReadWrite`, `Mail.Send`, or `Calendars.ReadWrite` app roles to this identity.** They are an independent authorization path. Entra and Exchange grants are a **union**, not an intersection; scoped Exchange RBAC cannot restrict an additional broad Entra grant.

Mailbox-scoped `Mail.ReadWrite` permits access to every message in the approved mailbox, not just synthetic messages. Keep the mailbox dedicated. `Mail.Send` restricts who the app can send **as**, not which addresses it can send **to**; apply an approved narrowly targeted mail-flow policy if that boundary also needs enforcement.

### Direct health reports

Live workers aggregate each complete cycle by journey/action and publish direct health reports. Authorize the independently selected **Azure report identity** for ingestion on the Exchange service model; see the [model permission contract](./health-model/README.md). `healthReportAuthentication` defaults to managed identity and obtains a separate ARM-audience token, without Graph-credential or default-credential fallback. A cross-tenant M365 application needs mailbox authorization, not Azure report permissions. Root account addresses belong in [monitoring.config.json](./monitoring.config.json), not credentials. Console diagnostics remain available; no separate telemetry destination or query-reader permission is required.

### Optional Microsoft-reported provider data

These are **additional tenant-level read permissions**, not prerequisites for the mailbox journey:

| Enabled collection | Microsoft Graph application permission |
| --- | --- |
| v1.0 Service Health overviews and issues | `ServiceHealth.Read.All` |
| Experimental Exchange serviceActivity reports | `ServiceActivity-Exchange.Read.All` |
| Experimental Teams serviceActivity reports | `ServiceActivity-Teams.Read.All` |

An authorized Entra administrator assigns the selected permissions to the service principal of the identity performing collection. Managed identities do not have an ordinary app-registration API-permissions page; use the approved service-principal app-role assignment procedure. Administrative permission to grant app roles belongs to the administrator, **not the running worker**.

Only request the rows actually enabled. These permissions read provider context and do not grant mailbox message access. The prohibition on unscoped Entra `Mail.ReadWrite`/`Mail.Send` grants still applies; do not add those mail roles while configuring provider reads.

Stable Service Health reports exact overview status directly to the single impact-suppressed `exchange-service-health` entity using `microsoft-reported-service-status`: 100 healthy, 50 degraded, 0 interruption. Issues and five approved beta signals share its External Reports group; there are no per-API child entities. Failed/missing/unknown overviews produce Unknown without a value. Collection has an independent provider lane even when journey initialization fails. Beta functions are explicitly opt-in; counts and percentages remain diagnostic unless customer thresholds are configured. They never contribute to synthetic/step success or Experience rollup. Microsoft documents `/beta` usage as unsupported in production applications. Validate tenant eligibility and permission availability rather than assuming a successful token means the report is available. See [exact provider contracts](./docs/provider-monitoring.md).

## 3. Infrastructure and non-secret handoff IDs

The [shared hosting guide](./synthetic-tests/infra/README.md) explains how to obtain each service identity's non-secret handoff values:

- `identityResourceId`: the Azure resource attached to the Container App.
- `clientId`: select this identity in the worker and use it as Exchange `-AppId`.
- `principalId`: the identity's **enterprise service-principal object ID**, used as Exchange `-ObjectId`/role-assignment principal.
- `tenantId`: must be the same approved Microsoft 365 tenant.

The client ID, principal ID, and an application-registration object ID are different things. A managed identity already has a service principal; this setup does not need a separate app registration.

The foundation stage creates identities without workers. Enabling live workers requires a separate `--enable-live` preparation opt-in. Compiling Bicep creates nothing; obtain stable IDs for administrator authorization before enabling a worker.

## 4. Illustrative Exchange administrator setup

These are **reviewable examples, not commands that have been executed**. Supply approved values and review any preexisting scope/role assignments before applying. An Exchange administrator with Organization Management or suitable delegated application-role assignment rights performs these changes; the worker never runs Exchange administration cmdlets.

Connect using the administrator's normal approved authentication, and verify the actual Exchange session tenant. A cached home-tenant session can differ from the selected Azure subscription.

```powershell
Connect-ExchangeOnline -UserPrincipalName "<approved-admin-in-the-mailbox-tenant>"

$expectedTenantId = "<tenantId from the identity output>"
$clientId = "<managed identity clientId>"
$principalId = "<managed identity principalId>"
$mailbox = "ahm-synthetic@<accepted-domain>"
$recipientMailbox = "ahm-synthetic-recipient@<accepted-domain>"
$controlMailbox = "<approved-existing-out-of-scope-mailbox>"
$scopeName = "AHM-Exchange-Synthetic-Mailbox"

if ((Get-ConnectionInformation | Select-Object -First 1).TenantID -ne $expectedTenantId) {
    throw "Connected Exchange tenant does not match the approved tenant."
}

if ((Get-OrganizationConfig).IsDehydrated) {
    throw "A tenant administrator must approve and run Enable-OrganizationCustomization once before creating custom scopes and role assignments."
}

New-ServicePrincipal -AppId $clientId -ObjectId $principalId `
    -DisplayName "AHM Exchange synthetic identity"

New-ManagementScope -Name $scopeName `
    -RecipientRestrictionFilter "(PrimarySmtpAddress -eq '$mailbox') -or (PrimarySmtpAddress -eq '$recipientMailbox')"

New-ManagementRoleAssignment -Name "AHM-Synthetic-MailReadWrite" `
    -App $principalId -Role "Application Mail.ReadWrite" `
    -CustomResourceScope $scopeName

New-ManagementRoleAssignment -Name "AHM-Synthetic-MailSend" `
    -App $principalId -Role "Application Mail.Send" `
    -CustomResourceScope $scopeName

New-ManagementRoleAssignment -Name "AHM-Synthetic-CalendarsReadWrite" `
    -App $principalId -Role "Application Calendars.ReadWrite" `
    -CustomResourceScope $scopeName

Test-ServicePrincipalAuthorization -Identity $principalId -Resource $mailbox
Test-ServicePrincipalAuthorization -Identity $principalId -Resource $recipientMailbox
Test-ServicePrincipalAuthorization -Identity $principalId -Resource $controlMailbox
```

Each allowed participant must show the selected roles in scope, and the control mailbox must be out of scope. This example covers an approved A/B pair; include every other explicitly selected expected recipient in the reviewed scope. Omit `Application Calendars.ReadWrite` when both calendar journeys are disabled. Preview actual scope membership and audit other grants as well; do not assume the scope name makes it narrow.

New test tenants may require the one-time, tenant-wide `Enable-OrganizationCustomization` prerequisite. Check `Get-OrganizationConfig`'s `IsDehydrated` property, obtain tenant-owner approval, and run the command only when it is `True`. Wait for completion before retrying the scoped setup; do not replace scoped grants with broader permissions.

`Test-ServicePrincipalAuthorization` **does not include separately granted Entra permissions**, so a passing control test alone does not rule out an accidental tenant-wide Graph grant. Verify effective live Graph access/denial under administrator supervision before scheduling.

Microsoft documents generic Entra service principals for Exchange application RBAC; a managed identity supplies that service-principal shape. The specific identity/tenant combination still requires the allowed/denied and live API acceptance checks above. Do not treat the local mock or a dry run as proof of live access.

Application permission changes can take roughly thirty minutes to two hours to propagate. The authorization test bypasses that cache. Revocation and incident procedures must account for propagation and existing tokens.

## 5. Runtime configuration

The service config selects:

```json
{
  "graphAuthentication": "managed-identity"
}
```

The Container App environment sets the identity's non-secret client ID:

```text
AZURE_CLIENT_ID=<user-assigned managed identity clientId>
```

The worker uses `ManagedIdentityCredential({ clientId })` for `https://graph.microsoft.com/.default`. It does not fall back to a developer login, system identity, application secret, or certificate if managed identity fails.

Live execution still requires dedicated target configuration, `mode: live`, `enabled: true`, and `ENABLE_LIVE_M365=true`. Start with a single manually initiated run after authorization checks. Simulation stays entirely local and acquires no managed-identity token.

For an approved **cross-tenant or local** M365 application, choose `graphAuthentication: certificate` explicitly and provide `M365_TENANT_ID`, `M365_CLIENT_ID`, and `M365_CLIENT_CERTIFICATE_PATH`. The public certificate belongs on the M365 app registration; its Enterprise application Object ID is the Exchange `$principalId`. Graph no longer reads `AZURE_*` certificate settings. A normal laptop also needs independently selected Azure report certificate authentication (`healthReportAuthentication: certificate` with `AZURE_*`); it does not expose the Container App managed-identity endpoint. Neither certificate option is a silent fallback.

Same-tenant hosted Exchange remains keyless by default. The shared hosting template supports explicit cross-tenant Graph PEM mounts through approved Key Vault references.

## 6. Journey and step boundaries

The [Exchange service](./synthetic-tests/exchange/) owns its config, worker, journeys, action functions and tests. Reusable HTTP, authentication, scheduling, console diagnostics and reporting utilities live in [utils/](./synthetic-tests/utils/).

The seven journeys are send/verify, draft lifecycle, attachment delivery, reply delivery, distribution-list fanout, recurring calendar, and meeting invitation/acceptance/cancellation. The reply journey retains a dedicated received starter message per approved pair, provisioned outside timed attempts with separately visible setup evidence. Each executed business action contributes its own 1/0 success and duration to cycle aggregation. A blocked action is skipped, not a fabricated failed request; for example, failed authentication must not be reported as a failed send that never happened.

The root health model references an independent Exchange model. Its seven journey entities receive whole-journey reports and 25 business-step children receive action reports through **External Reports**. Token acquisition and compensating cleanup remain internal; deliberate draft deletion and calendar deletion/cancellation are business steps. No mailbox inventory is sent to the model or retained between cycles. Reports replace current-cycle aggregates rather than storing full metrics or percentile history; TTL expiry removes signals, not a guaranteed Unhealthy state or alert. API-backed dedicated participants do not establish Outlook UI or tenant-wide availability.

## 7. Not required by this Exchange test

- A mailbox password, interactive sign-in to the shared mailbox, or a user's long-lived refresh token.
- Runtime Global Administrator/Exchange Administrator privileges.
- `Exchange.ManageAsApp`: that concerns Exchange administration, not this Graph mail journey.
- Delegated human FullAccess/SendAs assignments.
- Tenant-wide Graph mail grants, directory-wide read permissions, or Microsoft 365 Service Health access.
- A Key Vault credential, Blob checkpoint, separate telemetry worker, or worker health policy.

Teams Bot Connector authorization remains a separate implementation/installation concern. Do not assume changing Graph authentication makes the bot's send identity keyless automatically.

The optional provider collectors require the additional read permissions listed above only when enabled. They do not broaden the core Exchange journey's mailbox scope.

Cross-tenant managed identity and federation are not implemented. Different-tenant Graph access uses the explicit M365 application certificate path described in the [cross-tenant guide](./docs/cross-tenant-access.md); simply changing a tenant-ID setting on a managed identity does not move its identity into another directory.

## 8. Copy-and-send request

> **Subject: Dedicated Exchange test participants and scoped managed-identity authorization**
>
> Please approve dedicated A/B synthetic mailboxes and a synthetic distribution list with explicit expected recipients, and confirm the same Entra tenant as our Azure Container App identity.
>
> We will supply the user-assigned managed identity's client ID and enterprise service-principal object ID from the Azure setup. Please register its reference in Exchange and assign `Application Mail.ReadWrite`, `Application Mail.Send`, and selected calendar journeys' `Application Calendars.ReadWrite`, using Exchange RBAC for Applications scoped only to approved participants.
>
> Please do not add equivalent unscoped Entra Graph mail grants. We need allowed/denied authorization checks, a review of effective grants, and one live Graph validation before scheduling.
>
> The seven selected journeys cover A→B mail, drafts, separate attachment/reply delivery, list fanout, recurrence, and meeting acceptance/cancellation. Please approve the retained received reply fixture per pair, one-minute mail cadence and five-minute other journeys, mailbox licensing, recipient restrictions, owned-artifact cleanup/retention, an out-of-scope control mailbox, and named ownership/escalation.
>
> We do not need a mailbox password, application secret/certificate for hosted Exchange authentication, or administrator privileges for the running worker. Please return approved tenant/mailbox IDs, identity/scope/assignment details, test results, and operating constraints.

## 9. Cleanup and revocation

Stop the worker first. Revoke only its Exchange role assignments, verify loss of access after applicable caches/token lifetimes, and review owned artifacts under retention policy. Remove the Exchange service-principal reference, scope, Azure identity, and Container App only when no other approved consumer depends on them.

Never purge a whole mailbox/library, alter retention automatically, or delete unrelated resources in a shared subscription/resource group.

## Microsoft references

- [Container Apps managed identities](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity)
- [Exchange application RBAC, scopes, permission union, and authorization testing](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
- [ManagedIdentityCredential](https://learn.microsoft.com/en-us/javascript/api/@azure/identity/managedidentitycredential)
- [Shared-mailbox prerequisites and licensing](https://learn.microsoft.com/en-us/microsoft-365/admin/email/about-shared-mailboxes)
