# Exchange mailbox synthetic: administrator request and tenant access

This guide explains what to request from the people who manage Exchange Online and Microsoft Entra ID before running a real mailbox synthetic. It is an access-planning and handoff document, not authorization to create resources or grant permissions.

## Quick answer

- The mailbox belongs to a **Microsoft 365 tenant with Exchange Online**, not to an Azure subscription.
- We need a dedicated test mailbox and an application allowed to send, read, create, and delete messages **only in that mailbox**.
- The runner can be hosted in a different tenant from the mailbox, provided it authenticates using an application authorized in the mailbox's tenant.
- Cross-tenant hosting is feasible, but the current Azure-hosted runner needs authentication changes before supporting it. Do not promise a ready-to-deploy cross-tenant solution based on the local test command.

**Recommended mailbox starting point:** request one dedicated shared mailbox and a certificate-backed application in its tenant. Use the Exchange config and `--once` to prove a local send/receive/cleanup cycle before scheduling live tests. The separate [initial health-model deployment](./health-model/README.md) comes first on Azure and does not require mailbox access; ACA hosting remains unimplemented.

## 1. What the first test will do

The existing Exchange handler:

1. Authenticates as an application, without signing in as a person.
2. Creates a draft with a unique correlation ID and fixed, non-sensitive test content.
3. Sends the message from the test mailbox to itself.
4. Polls that mailbox's Inbox for the matching message and measures delivery time.
5. Deletes the test's draft/sent/received copies using known IDs or its exact unique subject.
6. Returns timings, success/failure, cleanup status, and an opaque correlation ID.

The test does not need real-user mailboxes, attachments, or business content. Message bodies, mailbox addresses, and tokens are not intended to enter Azure Monitor Health Models or execution logs.

Start with one manually initiated run. The Exchange config proposes a one-minute cadence: one message every minute means **1,440 messages per day, or approximately 43,200 per 30-day month**, per probe, plus sent and received copies. Multiply by the number of targets, and agree on the schedule before enabling it.

This proves a Graph-based, intra-tenant mailbox journey. It does **not** prove Outlook sign-in, external delivery, browser experience, or tenant-wide availability. A separate test tenant measures that test tenant, not another organization's production tenant.

## 2. What to ask the mailbox and identity administrators for

Mailbox creation and application authorization might belong to different teams. We do not need ongoing administrator access ourselves if those teams perform the setup and provide the handoff information.

| Request | Why we need it |
| --- | --- |
| One dedicated shared mailbox, for example `ahm-synthetic@<accepted-domain>` | Isolates synthetic activity from real users. The administrator must confirm an Exchange accepted SMTP domain; a verified Entra domain alone is not enough. |
| Mailbox primary SMTP address and stable mailbox/Entra object ID | Identifies the exact approved target and helps the administrator define the access scope. |
| Microsoft 365 tenant ID and tenant domain | Ensures authentication targets the mailbox tenant, not the operator's home tenant or the Azure subscription tenant by accident. |
| A named mailbox owner and an identity/application owner | Provides contacts for access changes, failures, certificate rotation, and eventual removal. |
| A dedicated application identity authorized in that tenant | Allows unattended testing without a user's password or interactive session. |
| Exactly scoped Exchange application permissions | Allows the send/read/cleanup journey without access to other mailboxes. See section 3. |
| Approval of test volume, send-to-self behavior, and mail-flow policies | Prevents surprises from transport rules, spam protection, quotas, or security controls. Do not disable protections broadly for the test. |
| An agreed retention and cleanup policy | Covers Deleted Items, delayed delivery, retention holds, and messages left after interrupted runs. |
| A known, out-of-scope control mailbox for an administrator-supervised authorization check | Demonstrates that the application cannot access an unrelated mailbox. Do not send or delete mail in that control mailbox. |
| Approval of the runner location and exported telemetry | Particularly important when the runner and mailbox belong to different tenants or organizations. |

### Mailbox licensing

The organization must already have an eligible Exchange Online subscription. A shared mailbox of up to 50 GB generally does not need its own mailbox license. Archive, hold, capacity, and advanced compliance/security features can require additional licenses. Human delegates accessing the mailbox need their own eligible licenses.

Ask the tenant administrator to confirm licensing rather than buying a new user license automatically. Do not enable interactive sign-in to the shared mailbox or request its password.

## 3. Exact permissions to request

### Runtime application permissions: required for mail flow

Use **Exchange Online RBAC for Applications**, with a custom resource scope containing only the approved test mailbox.

| Exchange application role | Purpose | Required scope |
| --- | --- | --- |
| `Application Mail.ReadWrite` | Create the draft, find delivery, and delete test copies | Only the dedicated synthetic mailbox |
| `Application Mail.Send` | Send the draft as the synthetic mailbox | Only the dedicated synthetic mailbox |

The administrator needs to:

1. Identify the application's client ID and its **enterprise application/service-principal object ID** in the mailbox tenant. The application-registration object ID is a different identifier.
2. Register the service-principal reference in Exchange Online.
3. Create a narrowly defined mailbox resource scope.
4. Assign both application roles to that service principal using that scope.
5. Audit existing permissions and verify allowed and denied access.

An Exchange administrator with the appropriate Organization Management or delegated application-role assignment rights should perform these steps. The runner itself needs neither Exchange Administrator nor Global Administrator.

**Important boundaries:**

- Do not additionally grant unscoped Microsoft Graph `Mail.ReadWrite` or `Mail.Send` application permissions in Entra ID. Exchange RBAC and Entra permissions are additive; a broad grant can bypass the intended mailbox restriction.
- Do not request delegated user permissions, human `FullAccess`/`SendAs` assignments, `Exchange.ManageAsApp`, directory-wide read permissions, or Teams/SharePoint access for this Graph mailbox test.
- `Mail.ReadWrite` permits access to **all messages in the allowed mailbox**, not just synthetic messages. Correlation-based cleanup is a code safeguard, not a message-level authorization boundary. Keep business data out of the mailbox.
- Scoping `Mail.Send` restricts the mailbox the application can send **as**, not the recipient addresses it could send **to**. The code sends only to itself; administrators should consider a narrowly targeted mail-flow restriction if they need that enforced independently.

### Provider context: optional and separate

Microsoft 365 Service Health collection uses Microsoft Graph **`ServiceHealth.Read.All` application permission**, granted by an authorized Entra administrator in the tenant whose service health we want to observe.

That permission is tenant-level provider context, not mailbox-scoped access. It is **not needed by the Exchange worker**. Request it separately for a future collector; no Service Health collector is currently wired into the worker. It is not a substitute for a real mail-flow test.

### Azure permissions: separate from mailbox permissions

The stateless worker exports OTel results/metrics through workspace-based Application Insights to Log Analytics. It does not call the Health Report Ingestion API or use Blob state, so it needs neither model-ingestion permission nor Blob access.

Approve the telemetry destination, ingestion authentication, and retention separately. A future model-side query identity needs workspace query access; that is not a mailbox permission. Azure subscription Owner does not authorize mailbox creation or access, and the mailbox application does not need subscription-wide Contributor/Owner.

## 4. Can the runner and mailbox be in different tenants?

**Yes, as an architecture.** An application in the mailbox tenant can authenticate from a process hosted elsewhere, subject to both organizations' policies.

```text
Tenant A: Azure subscription
  Runner
    |-- Embedded OTel --> Application Insights / Log Analytics in A
    |
    `-- Mailbox application B --> Microsoft Graph --> test mailbox in tenant B

Tenant B: Microsoft 365
  Dedicated single-tenant application and service principal
  Exchange application roles scoped to the dedicated test mailbox
```

For the initial cross-tenant approach:

1. The Microsoft 365 team creates or approves a single-tenant application in **tenant B**.
2. We generate and protect a certificate/private key for the runner. Only the **public certificate** is supplied for registration in tenant B; nobody should email private keys or tokens.
3. Tenant B's administrator grants that application's service principal the scoped Exchange roles.
4. The runner acquires a Graph token from **tenant B**, using B's tenant ID, application client ID, and approved certificate.
5. Embedded OTel exports telemetry to the approved Application Insights/Log Analytics destination in tenant A, independently of the Graph application identity. No worker-side model or state-store access is needed.

This does not require moving the Azure subscription, migrating the mailbox, or enabling mailbox forwarding. Being a guest in tenant B does not automatically grant Exchange administration rights.

### Managed identity is not automatically cross-tenant

A managed identity from tenant A cannot simply be assigned Exchange roles in tenant B and used as if it were B's local application identity. Microsoft documents that managed identities do not directly support cross-directory resource access.

For a future hosted cross-tenant deployment, use an explicitly approved authentication design for B's application, with protected certificate storage and rotation, or a separately validated workload-federation design. Do not assume federation is already configured or replace it with a long-lived client secret as a shortcut.

### What this repository currently supports

| Path | Current status |
| --- | --- |
| Local per-service `npm run probe` worker | Reads its [Exchange config](./probes/exchange/config.json), runs on its own cadence, or executes once with `--once`. Live execution requires approved targets, certificate credentials, and explicit live opt-in. Console mode exports nothing to Azure; Azure Monitor mode embeds OTel export in the same process. The Graph token targets the approved mailbox tenant independently of the Azure CLI subscription. Real cross-tenant operation has not been validated. |
| Intended Azure Container Apps host | **Not implemented or deployed.** Local scheduling exists, but container hosting, hosted credential selection, and replica ownership must be established separately. |
| Azure-hosted live runner in A, mailbox in B | **Not implemented.** It needs separately authorized mailbox-tenant credentials, secure loading/rotation, and end-to-end validation. |
| Local telemetry export and downstream model evaluation | Export uses the configured workspace-based Application Insights destination, not a worker health-report client. Log Analytics/model queries and their authorization must be configured separately. No live end-to-end cross-tenant ingestion is established by local tests. |

See [authentication selection](./runner/src/runtime.ts), the [config-driven worker](./runner/README.md), and the [Exchange handler](./probes/exchange/src/probe.ts). No cross-tenant hosting changes are part of this document.

## 5. Handoff and acceptance checks

Ask the administrators to return:

- Approved tenant ID/domain, mailbox SMTP address/object ID, and resource owners.
- Application client ID, enterprise service-principal object ID, and the registered public-certificate thumbprint/expiry. Never request the private key or a mailbox password.
- Exchange scope and role-assignment names, their exact mailbox membership, and confirmation that no unscoped equivalent Entra mail permissions remain.
- Approved test cadence, runner location, mail-flow restrictions, retention requirements, and a cleanup/escalation contact.
- Results of authorization checks for both the test mailbox and the agreed control mailbox.

Before the first send:

1. Verify the actual Exchange session tenant and administrator command access, not just the selected Azure subscription. A cached home-tenant sign-in can target a different organization.
2. Run `Test-ServicePrincipalAuthorization` with the target resource specified: both roles must be in scope for the test mailbox and out of scope for the control mailbox.
3. Review Entra application grants as well. That Exchange test command does **not** account for separately granted Entra permissions.
4. Allow for propagation: Microsoft documents Exchange application-permission caching of roughly 30 minutes to two hours. The test command bypasses that cache; a passing result alone does not prove live Graph authorization is ready.
5. Verify actual Graph access to the approved mailbox and denial for the known control mailbox. An approved Inbox-folder-metadata request is sufficient for the negative check; do not read messages, send, or delete there. A missing mailbox/404 is not proof of correctly scoped authorization.
6. Configure the approved Exchange target and live mode, then run `npm run probe -- --config probes/exchange/config.json --once` after explicit live opt-in. Inspect results for delivery confirmation and cleanup. Authentication/permission failures mean the test could not execute, not that Exchange is down. One target is sufficient to report measurements; no worker-side sample/health policy is required, and it is not tenant-wide evidence.

Only after this works should we enable a schedule and Azure telemetry export. Analyze success rate, latency, and missing observations in Log Analytics; model-side query signals are a separate step. Monitor certificate expiry, cleanup failures, and stopped-worker evidence before relying on it operationally.

## 6. Copy-and-send request

> **Subject: Request dedicated Exchange Online mailbox and scoped app access for synthetic testing**
>
> We are building an Azure Monitor Health Models proof of concept and need one dedicated Exchange Online shared mailbox for a synthetic send-to-self/delivery/cleanup test.
>
> Please help us:
>
> 1. Confirm the Microsoft 365 tenant and create a dedicated shared mailbox in an approved accepted SMTP domain, with a named owner and confirmed licensing.
> 2. Create or approve a dedicated application identity in that tenant. We can supply a public certificate; we do not need a mailbox password or human administrator access.
> 3. Register its service principal in Exchange and grant only `Application Mail.ReadWrite` and `Application Mail.Send`, scoped through Exchange RBAC for Applications to that mailbox alone. Please do not add equivalent tenant-wide Entra mail permissions.
> 4. Verify allowed access to the test mailbox and denied access to an agreed control mailbox, including a review for any broader existing permissions.
> 5. Approve the runner location, initially one manual run, and a possible later schedule of one message every minute per probe. We will confirm the target count and total volume before enabling it. The runner might be hosted in a different Azure tenant; please confirm that use is permitted. Cross-tenant Azure hosting still needs implementation and validation on our side.
> 6. Agree on send-to-self restrictions, retention, cleanup of late/interrupted test messages, credential rotation, and a shutdown/revocation owner.
>
> Please return the mailbox and tenant identifiers, application client and enterprise service-principal IDs, certificate thumbprint/expiry, scope/assignment names, authorization-check results, and any policy constraints. Do not send private keys, passwords, or tokens.
>
> We are not requesting real-user mailbox access, tenant-wide mail permissions, or Global Administrator rights. Optional Microsoft 365 Service Health access will be a separate request for `ServiceHealth.Read.All`.

## 7. Cleanup and revocation

Agree on the shutdown procedure when requesting access:

1. Stop the local runner or scheduled Function and confirm it is no longer sending.
2. Revoke only the synthetic application's Exchange role assignments and credentials, following the tenant's revocation procedure. Account for permission/token caching when verifying loss of access.
3. Have the mailbox owner review remaining correlated test messages, including late arrivals. Normal deletion can leave messages in Deleted Items or retained under policy; do not purge or change retention automatically.
4. Remove the dedicated Exchange service-principal reference and scope only when no other assignments depend on them. Remove the dedicated Entra application/credentials when no other approved consumer uses them.
5. Delete the test mailbox only with owner and retention approval. Remove private-key material from its approved storage after decommissioning.
6. Separately remove only the Azure resources and role assignments created for the proof of concept. Never delete a shared subscription or unrelated resource group.

## Microsoft references

- [Exchange Online RBAC for Applications: roles, scoping, additive permissions, and caching](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
- [Test-ServicePrincipalAuthorization](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/test-serviceprincipalauthorization)
- [Shared mailbox prerequisites and licensing](https://learn.microsoft.com/en-us/microsoft-365/admin/email/about-shared-mailboxes)
- [Application authentication with client credentials and certificates](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow)
- [Managed identity FAQ: cross-directory limitations](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/managed-identities-faq#can-i-use-a-managed-identity-to-access-a-resource-in-a-different-directorytenant)
- [Microsoft Graph Service Health API permissions](https://learn.microsoft.com/en-us/graph/api/serviceannouncement-list-healthoverviews?view=graph-rest-1.0)
