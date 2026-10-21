# Exchange synthetic permissions and managed identity setup

This is the administrator handoff for the **same-Entra-tenant** design. The worker runs in Azure Container Apps, authenticates to Graph with an explicitly selected **user-assigned managed identity**, and accesses only the dedicated synthetic mailbox.

No mailbox password, application secret, customer-managed certificate, or Key Vault credential is required for hosted Exchange authentication. Azure manages the identity's credentials.

The [shared Container Apps setup](./synthetic-tests/infra/README.md) separates identity creation from worker enablement and does not grant mailbox permissions. The separate health-model deployment does not establish Exchange access. Start with the [administrator walkthrough](./synthetic-tests/README.md#administrator-setup-enable-authentication-and-live-tests) for the full enablement sequence, including optional Graph app-role assignment.

## 1. What we need the administrators to provide

| Request | Why |
| --- | --- |
| One dedicated shared/test mailbox in an approved Exchange accepted SMTP domain | Keep business data and real-user mailboxes outside the test |
| The Microsoft 365 tenant ID, primary SMTP address, mailbox object ID, and owner | Confirm the correct tenant/target and define a narrow scope |
| Approval for the Exchange worker's managed identity | Azure creates its service principal; Exchange must separately authorize it |
| Exchange RBAC application roles scoped only to the test mailbox | Permit draft creation, send, Inbox checks, and owned-message cleanup |
| An approved out-of-scope control mailbox | Verify that unrelated mailbox access is denied, without sending/deleting there |
| Approved cadence, retention, mail-flow restrictions, and an escalation owner | Control volume, cleanup, and security impact |

At one message per minute, one target produces up to **1,440 messages/day or 43,200 per thirty-day month**, plus sent/received copies. Agree on volume before enabling live execution.

An eligible Exchange Online subscription must exist. A shared mailbox up to 50 GB generally needs no separate mailbox license; archive, hold, capacity, and advanced compliance/security features can change that. Human delegates need their own eligible licensing. Ask the tenant owner to confirm it.

An Azure subscription cannot itself host/create an Exchange Online mailbox. Azure and Microsoft 365 resources may be in different subscriptions, but this implementation's default assumes the **same Entra tenant**.

## 2. Permissions: separate the three responsibilities

### Azure deployment and identity attachment

The deploying operator needs rights to create the approved Container Apps resources and user-assigned identity, and to attach that identity. Examples are appropriately scoped resource Contributor/Managed Identity Contributor plus Managed Identity Operator where needed; use the organization's deployment role rather than granting broad access to the runtime identity.

If an existing private Azure Container Registry supplies the image, the attached identity needs the registry's appropriate image-pull role, commonly **AcrPull** for a registry using classic RBAC. ABAC-enabled registries have different repository roles. This is image access, not mailbox authorization.

**The worker identity does not need subscription Owner, Contributor, Exchange Administrator, Global Administrator, or Blob access.** It does need narrowly scoped health-report ingestion permission on its own service model, separate from mailbox authorization.

### Exchange mailbox authorization

Use **Exchange Online RBAC for Applications only**, scoped to the dedicated mailbox:

| Role | Journey steps that need it |
| --- | --- |
| `Application Mail.ReadWrite` | Create draft, look for Inbox delivery, find/delete this run's copies |
| `Application Mail.Send` | Submit the test draft as that mailbox |

The administrator registers the existing managed identity's service-principal reference in Exchange, creates a resource scope, and assigns those roles using that scope.

**Do not additionally grant tenant-wide Entra Microsoft Graph `Mail.ReadWrite` or `Mail.Send` app roles to this identity.** They are an independent authorization path. Entra and Exchange grants are a **union**, not an intersection; scoped Exchange RBAC cannot restrict an additional broad Entra grant.

Mailbox-scoped `Mail.ReadWrite` permits access to every message in the approved mailbox, not just synthetic messages. Keep the mailbox dedicated. `Mail.Send` restricts who the app can send **as**, not which addresses it can send **to**; apply an approved narrowly targeted mail-flow policy if that boundary also needs enforcement.

### Direct health reports

Live workers aggregate each complete cycle by journey/action and publish direct health reports. Authorize the selected identity for health-report ingestion on the Exchange service model; see the [model permission contract](./health-model/README.md). It obtains a separate ARM-audience token using the same explicitly selected identity, without a default-credential fallback. Root account addresses belong in [monitoring.config.json](./monitoring.config.json), not credentials. Console diagnostics remain available; no separate telemetry destination or query-reader permission is required.

### Optional Microsoft-reported provider data

These are **additional tenant-level read permissions**, not prerequisites for the mailbox journey:

| Enabled collection | Microsoft Graph application permission |
| --- | --- |
| v1.0 Service Health overviews and issues | `ServiceHealth.Read.All` |
| Experimental Exchange serviceActivity reports | `ServiceActivity-Exchange.Read.All` |
| Experimental Teams serviceActivity reports | `ServiceActivity-Teams.Read.All` |

An authorized Entra administrator assigns the selected permissions to the service principal of the identity performing collection. Managed identities do not have an ordinary app-registration API-permissions page; use the approved service-principal app-role assignment procedure. Administrative permission to grant app roles belongs to the administrator, **not the running worker**.

Only request the rows actually enabled. These permissions read provider context and do not grant mailbox message access. The prohibition on unscoped Entra `Mail.ReadWrite`/`Mail.Send` grants still applies; do not add those mail roles while configuring provider reads.

Stable Service Health reports exact overview status directly to `exchange-service-health` using `microsoft-reported-service-status`: 100 healthy, 50 degraded, 0 interruption, with `impactSuppressed`. Failed/missing/unknown overviews produce Unknown without a value and with failure context; the existing trial receives Graph 403 until `ServiceHealth.Read.All` admin consent is granted. Collection runs once per cycle even if journey initialization fails. Beta reports are explicitly opt-in, console-diagnostic-only, and never contribute to synthetic/step success or Experience rollup. Microsoft documents `/beta` usage as unsupported in production applications. Validate tenant eligibility and permission availability rather than assuming a successful token means the report is available.

No SharePoint-specific serviceActivity function has been verified in the documented catalog. Do not invent one or grant unrelated Office Apps permissions as a substitute. API failures/no data must be visible as collection diagnostics, not defaulted to healthy service status.

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
$controlMailbox = "<approved-existing-out-of-scope-mailbox>"
$scopeName = "AHM-Exchange-Synthetic-Mailbox"

if ((Get-ConnectionInformation | Select-Object -First 1).TenantID -ne $expectedTenantId) {
    throw "Connected Exchange tenant does not match the approved tenant."
}

New-ServicePrincipal -AppId $clientId -ObjectId $principalId `
    -DisplayName "AHM Exchange synthetic identity"

New-ManagementScope -Name $scopeName `
    -RecipientRestrictionFilter "PrimarySmtpAddress -eq '$mailbox'"

New-ManagementRoleAssignment -Name "AHM-Synthetic-MailReadWrite" `
    -App $principalId -Role "Application Mail.ReadWrite" `
    -CustomResourceScope $scopeName

New-ManagementRoleAssignment -Name "AHM-Synthetic-MailSend" `
    -App $principalId -Role "Application Mail.Send" `
    -CustomResourceScope $scopeName

Test-ServicePrincipalAuthorization -Identity $principalId -Resource $mailbox
Test-ServicePrincipalAuthorization -Identity $principalId -Resource $controlMailbox
```

The allowed test must show both roles in scope, and the control mailbox must be out of scope. Preview actual scope membership and audit other grants as well; do not assume the scope name makes it narrow.

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

For an approved **local development** application, choose `graphAuthentication: certificate` explicitly and provide `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_CERTIFICATE_PATH`. A normal laptop does not expose the Container App managed-identity endpoint. The certificate option does not become a silent production fallback.

Hosted Exchange uses the managed-identity path and needs no mailbox certificate/secret.

## 6. Journey and step boundaries

The [Exchange service](./synthetic-tests/exchange/) owns its config, worker, journeys, action functions and tests. Reusable HTTP, authentication, scheduling, console diagnostics and reporting utilities live in [utils/](./synthetic-tests/utils/).

The mail journey is authenticate -> create draft -> send -> confirm Inbox delivery -> cleanup. A second journey edits and reopens an owned draft without sending. Each executed business action contributes its own 1/0 success and duration to cycle aggregation. A blocked action is skipped, not a fabricated failed request; for example, failed authentication must not be reported as a failed send that never happened.

The root health model references an independent Exchange model. Its two journey entities receive whole-journey reports and six separate business-step child entities receive action reports, using **External Reports** only. Token acquisition and cleanup remain internal, with no standalone step reports or graph nodes. No mailbox inventory is sent to the model or retained between cycles. Reports replace current-cycle aggregates rather than storing full metrics or percentile history; TTL expiry removes signals, not a guaranteed Unhealthy state or alert. One mailbox sending to itself is not employee-to-employee delivery, Outlook UI coverage, or tenant-wide availability.

## 7. Not required by this Exchange test

- A mailbox password, interactive sign-in to the shared mailbox, or a user's long-lived refresh token.
- Runtime Global Administrator/Exchange Administrator privileges.
- `Exchange.ManageAsApp`: that concerns Exchange administration, not this Graph mail journey.
- Delegated human FullAccess/SendAs assignments.
- Tenant-wide Graph mail grants, directory-wide read permissions, or Microsoft 365 Service Health access.
- A Key Vault credential, Blob checkpoint, separate telemetry worker, or worker health policy.

Teams Bot Connector authorization remains a separate implementation/installation concern. Do not assume changing Graph authentication makes the bot's send identity keyless automatically.

The optional provider collectors require the additional read permissions listed above only when enabled. They do not broaden the core Exchange journey's mailbox scope.

Cross-tenant managed identity is not enabled by this same-tenant implementation. A different tenant needs a separately reviewed federation/application authorization design; simply changing a tenant-ID setting on a managed identity does not move its identity into another directory.

## 8. Copy-and-send request

> **Subject: Dedicated Exchange test mailbox and scoped managed-identity authorization**
>
> Please provide one dedicated synthetic mailbox and confirm the same Entra tenant as our Azure Container App identity.
>
> We will supply the user-assigned managed identity's client ID and enterprise service-principal object ID from the Azure setup. Please register its reference in Exchange and assign only `Application Mail.ReadWrite` and `Application Mail.Send`, using Exchange RBAC for Applications scoped to that mailbox.
>
> Please do not add equivalent unscoped Entra Graph mail grants. We need allowed/denied authorization checks, a review of effective grants, and one live Graph validation before scheduling.
>
> The test creates a draft, sends to itself, confirms delivery, and deletes its own test copies. Please approve volume (up to one message/minute/target), mailbox licensing, recipient restrictions, retention, an out-of-scope control mailbox, and named ownership/escalation.
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
