# Set up Microsoft 365 monitoring access

## Recommended: deploy in the customer's tenant

1. Use a customer-approved Azure subscription **associated with the same Entra tenant as Microsoft 365**. The subscription owner's email does not determine its tenant. Use the organization's approved subscription provisioning and billing process.
2. Create dedicated test mailboxes, a SharePoint site/library/folder, and a Teams team/standard channel. Existing licensed user mailboxes work; shared mailboxes are optional and do not simplify application authentication. Confirm licenses, ownership, cadence and cleanup limits.
3. Create a private [root configuration](../monitoring.config.json) with approved targets and Azure model destination. Keep both `graphAuthentication` and `healthReportAuthentication` set to `managed-identity` in the service files.
4. Deploy the [health models](../health-model/README.md#apply-and-migrate), then the [worker foundation](../synthetic-tests/infra/README.md#provision-and-publish), leaving workers disabled. It creates a separate user-assigned managed identity per service.
5. Have the customer's administrators grant:

   | Service | Required access |
   | --- | --- |
   | Exchange | Mailbox-scoped `Application Mail.ReadWrite` and `Application Mail.Send` through [Exchange application RBAC](../MAILBOX-SYNTHETIC-ACCESS.md#4-illustrative-exchange-administrator-setup), **not tenant-wide Graph mail permissions** |
   | SharePoint | Graph `Sites.Selected`, admin consent and an explicit `write` grant on the [dedicated site](../synthetic-tests/sharepoint/README.md#authentication-and-permissions) |
   | Teams | [Managed-identity bot](../synthetic-tests/teams/README.md#primary-setup-unattended-bot), installed Teams app and separate Entra readback registration with team-scoped RSC and worker-UAMI federation; delegated coverage is opt-in |
   | Health reports | The foundation grants each Azure identity ingest-only access on its own service model |

6. Enable live execution only after allowed/denied access checks. Follow the [worker rollout](../synthetic-tests/infra/README.md#provision-and-publish), verify real journeys and cleanup, then fresh reports and service/root rollup.

**Same tenant does not eliminate permission or policy reviews.** Keep images, identities, diagnostics and alerts customer-controlled. Default Teams bot mode uses `teamsAuthentication: "bot"` and independent `botAuthentication: "managed-identity"`; hosted `BOT_CLIENT_ID`/`BOT_TENANT_ID` select the attached UAMI for Bot Connector. Graph read permissions alone do not authorize posting: approve and install the matching bot. No user bootstrap/cache is needed. Optional delegated mode requires [human bootstrap](./teams-user-bootstrap.md), may require reauthentication/MFA and may be blocked by Conditional Access. Provider Graph credentials remain application-only. Enable optional `ServiceHealth.Read.All` application-provider consent only if approved.

## Temporary cross-tenant lab: reuse existing Azure hosting

Use this only with approval from both hosting and M365 tenant owners. No Azure subscription is needed in the M365 tenant. Start with **Exchange** to prove access before adding SharePoint and Teams.

Do not bypass tenant restrictions on application creation. If cross-tenant hosting
is explicitly approved, the implemented option is **certificate authentication with
a single-tenant application owned by the M365 tenant**. Generic cross-tenant
managed-identity federation is not implemented; the Teams readback federation in
the recommended setup is same-tenant only.

### 1. Register the lab application in the M365 tenant

Sign in to [Entra](https://entra.microsoft.com) as an authorized tenant administrator. Open **App registrations -> New registration**, name it `M365 Synthetic Exchange`, and select **Accounts in this organizational directory only**. No redirect URI or client secret is needed.

Record its **tenant ID**, **Application/client ID**, and **Enterprise application Object ID**. The last is the service-principal ID, not the app-registration Object ID.

### 2. Create and register its certificate

From an existing private directory **outside this repository**, on an approved machine:

```sh
umask 077
openssl req -x509 -newkey rsa:3072 -sha256 -days 30 -nodes \
  -keyout exchange.key.pem -out exchange.public.pem \
  -subj "/CN=M365 Synthetic Exchange Lab"
cat exchange.key.pem exchange.public.pem > exchange.client.pem
```

In the app registration, open **Certificates & secrets -> Certificates -> Upload certificate** and upload **only `exchange.public.pem`**. Protect the private-key files; never put them in Git, chat, images or deployment parameters.

### 3. Approve the test mailbox

An Exchange administrator follows the [scoped Exchange commands](../MAILBOX-SYNTHETIC-ACCESS.md#4-illustrative-exchange-administrator-setup), using:

- `$expectedTenantId`: M365 tenant ID.
- `$clientId`: the lab application's client ID.
- `$principalId`: its **Enterprise application Object ID in M365**, not the Azure UAMI ID.
- `$mailbox`: the dedicated test mailbox; use an approved different mailbox as the denied-access control.

Verify both authorization paths: Exchange scope tests **and** the absence of broad Entra mail grants. Do not grant tenant-wide Graph `Mail.ReadWrite` or `Mail.Send`. The worker needs no administrator role or mailbox password.

For a new tenant, check `(Get-OrganizationConfig).IsDehydrated`. If `True`, obtain tenant-owner approval and run `Enable-OrganizationCustomization` once before creating scopes/role assignments; wait for completion before retrying.

### 4. Connect the hosted worker

1. Set `graphAuthentication: "certificate"` and `healthReportAuthentication: "managed-identity"` in the private Exchange service file. Set `mode: "live"` and keep optional `serviceHealth` off for the first test.
2. Set the approved mailbox in the private root configuration. Keep the **existing Azure** subscription/model destination; do not replace it with the M365 tenant ID.
3. Store `exchange.client.pem` as a **raw UTF-8 PEM secret** in the approved hosting-tenant Key Vault. Do not use a base64 PFX certificate secret.

   ```sh
   az keyvault secret set --subscription '<hosting-subscription>' \
     --vault-name '<approved-vault>' --name exchange-client-pem \
     --file '/secure/location/exchange.client.pem' --encoding utf-8 \
     --query id --output tsv
   ```

4. Grant the Exchange worker UAMI **Key Vault Secrets User** on that secret and verify vault network reachability. Obtain approval for any new vault or role assignment. **If the vault is private-only, do not enable public access:** establish approved private connectivity or, only with explicit approval, use the [encrypted Container Apps secret procedure](../synthetic-tests/infra/README.md#approved-temporary-alternative-native-container-apps-certificate-secret).
5. Copy the `exchange` entry from [service-access.example.json](../synthetic-tests/infra/service-access.example.json) into a private access file. Replace its tenant/client IDs and `m365CertificateSecretUri`; prefer the versioned URI returned above. Omit unused service entries.
6. Build/publish the updated image and prepare the [shared deployment](../synthetic-tests/infra/README.md#separate-m365-and-azure-credentials):

   ```sh
   npm --prefix synthetic-tests run deployment:prepare -- \
     /absolute/path/monitoring.private.json /absolute/path/workers.parameters.json \
     '<registry>/m365-synthetic@sha256:<digest>' \
     --enable-live --access-config /absolute/path/service-access.private.json
   ```

The template sets **`M365_*` for Graph** and leaves **`AZURE_*` for Azure reports**. It mounts the PEM from the explicitly selected secret source. No developer-login, storage-source or credential fallback occurs.

### 5. Verify and extend

From an approved host with the configured identity and mounts, [run one live cycle](../synthetic-tests/README.md#6-prove-one-cycle-before-enabling-recurrence) and inspect both Exchange journeys, cleanup, and fresh Azure reports. A successful deployment or token request is not a successful mailbox test. Enable recurrence only after acceptance.

Add separate SharePoint and Teams observer applications using the same steps and the permissions above. The same-tenant bot MI default does not extend to a cross-tenant lab; a separately approved installed bot can explicitly select `botAuthentication: "certificate"` and separate `BOT_*` credentials. Do not claim fully keyless cross-tenant Teams or customer production readiness from this lab. Revoke lab grants, remove the uploaded public certificate and review retained synthetic artifacts when finished.
