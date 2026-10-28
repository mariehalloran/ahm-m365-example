# Set up Microsoft 365 monitoring access

## Recommended: deploy in the customer's tenant

1. Use a customer-approved Azure subscription **associated with the same Entra tenant as Microsoft 365**. The subscription owner's email does not determine its tenant. Use the organization's approved subscription provisioning and billing process.
2. Approve dedicated test mailboxes, a Teams team/standard channel and bot-only meeting, and provisioned OneDrive accounts with dedicated test folders. Existing licensed mailboxes work; shared mailboxes are optional and do not simplify application authentication. Confirm ownership, cadence and cleanup limits.
3. Edit [monitoring.config.json](../monitoring.config.json) with approved targets and the Azure model destination. Keep both `graphAuthentication` and `healthReportAuthentication` set to `managed-identity` in each service's `execution` block. Leave `deployment.azureTenantId` out: it defaults to the single tenant's `tenantId` ([what the config holds](./deployment.md#what-the-config-holds)).
4. Run `npm run deploy` with `deployment.stage: "foundation"` to deploy the [health models](../health-model/README.md#apply-and-migrate) and the [worker foundation](../synthetic-tests/infra/README.md#provision-and-publish) without workers. The foundation creates a separate user-assigned managed identity per service (`worker.identityName`).
5. Have the customer's administrators grant:

   | Service | Required access |
   | --- | --- |
   | Exchange | Mailbox-scoped `Application Mail.ReadWrite`, `Application Mail.Send`, and calendar journeys' `Application Calendars.ReadWrite` through [Exchange application RBAC](../MAILBOX-SYNTHETIC-ACCESS.md#4-illustrative-exchange-administrator-setup), **not tenant-wide Graph mail/calendar permissions**. This is the one-time approval; step 6 then keeps its scope current |
   | Teams | [Managed-identity bots](../synthetic-tests/teams/README.md#primary-setup-unattended-bot), installed Teams app and separate Entra readback registration with team-scoped RSC and worker-UAMI federation; meeting access requires separate application-permission approval |
   | OneDrive | [Bulk Selected-folder setup](./onedrive-setup.md) with a separate approved provisioning identity; writes real drive/folder IDs to `.env` and scoped worker write grants. Approve AppFolder separately; no broad runtime file-permission fallback |
   | Provider context | Optional `ServiceHealth.Read.All` on the provider app (the tenant's `providerClientId`) and its federation trust for each selected service UAMI; Exchange/Teams beta permissions need separate approval |
   | Health reports | The foundation grants each Azure identity ingest-only access on its own service model |

6. Follow [`docs/setup.md`](./setup.md) as an Exchange and Teams administrator
   ([what it covers](./deployment.md#set-up-microsoft-365)) to grant, and keep current by hand
   as targets change, the Exchange mailbox scope and Teams membership. Then run
   `npm run setup:ids` for the IDs the config leaves out and, when `reply-mail` is selected,
   `npm run setup:reply-seeds` for the single-user SELF-REPLY fixtures — neither touches
   OneDrive's drives and folders or the Exchange approval above.
7. Enable live execution only after allowed/denied access checks: name each approved identity in `worker.identity`, set `execution.mode: "live"` and `deployment.enableLiveProbes: true`, remove `deployment.stage` (default `workers`) and run `npm run deploy` (see the [worker rollout](../synthetic-tests/infra/README.md#provision-and-publish)). Verify real journeys and cleanup, then fresh reports and service/root rollup.

**Same tenant does not eliminate permission or policy reviews.** Keep images, identities, diagnostics and alerts customer-controlled. Teams uses only `teamsAuthentication: "bot"` and `botAuthentication: "managed-identity"`; hosted `BOT_CLIENT_ID`/`BOT_TENANT_ID` select the attached UAMI for Bot Connector, with a second explicitly selected UAMI for meetings. Graph read permissions alone do not authorize posting: approve and install the matching bot. No delegated-user sign-in, bootstrap or token cache exists. Provider credentials remain application-only and separate from synthetic access.

## Temporary cross-tenant lab: reuse existing Azure hosting

Use this only with approval from both hosting and M365 tenant owners. No Azure subscription is needed in the M365 tenant. The explicit certificate alternative below is for **Exchange**; Teams bot participants remain managed-identity-only.

Do not bypass tenant restrictions on application creation. If cross-tenant hosting
is explicitly approved, the implemented option is **certificate authentication with
a single-tenant application owned by the M365 tenant**. Generic cross-tenant
managed-identity federation is not implemented; the Teams readback federation in
the recommended setup is same-tenant only.

`npm run setup:reply-seeds` runs the Exchange worker's own managed identity in a temporary
job, so it only works with a same-tenant managed identity. Skip it when
`deployment.azureTenantId` differs from the tenant's `tenantId` (it defaults to that, so only
cross-tenant hosting sets it); provision the reply seed by hand instead, with a local
`npm run exchange:mail-test -- --apply` using explicit certificate authentication, which
writes it to `.env`. Teams membership, covered by hand in [`docs/setup.md`](./setup.md), and
`npm run setup:ids`'s lookups are unaffected: both act as the signed-in administrator, not a
managed identity.

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

1. Set `graphAuthentication: "certificate"` and `healthReportAuthentication: "managed-identity"` in the Exchange `execution` block of `monitoring.config.json`. Set `mode: "live"` and keep optional `serviceHealth` off for the first test.
2. Set the approved mailbox in the Exchange `targets`. Keep the **existing Azure** subscription/model destination; do not replace it with the M365 tenant ID.
3. Store `exchange.client.pem` as a **raw UTF-8 PEM secret** in the approved hosting-tenant Key Vault. Do not use a base64 PFX certificate secret.

   ```sh
   az keyvault secret set --subscription '<hosting-subscription>' \
     --vault-name '<approved-vault>' --name exchange-client-pem \
     --file '/secure/location/exchange.client.pem' --encoding utf-8 \
     --query id --output tsv
   ```

4. Grant the Exchange worker UAMI **Key Vault Secrets User** on that secret and verify vault network reachability. Obtain approval for any new vault or role assignment. **If the vault is private-only, do not enable public access:** establish approved private connectivity or, only with explicit approval, use the [encrypted Container Apps secret procedure](../synthetic-tests/infra/README.md#approved-temporary-alternative-native-container-apps-certificate-secret).
5. Add the references to the Exchange service's `access` block in `monitoring.config.json`: `m365TenantId`, `m365ClientId`, `m365CertificateSource: "key-vault"` and `m365CertificateSecretUri`; prefer the versioned URI returned above.
6. Set `deployment.enableLiveProbes: true` and run `npm run deploy` (see the [shared deployment](../synthetic-tests/infra/README.md#separate-m365-and-azure-credentials)); it builds and pins the image and rolls out the workers.

The template sets **`M365_*` for Graph** and leaves **`AZURE_*` for Azure reports**. It mounts the PEM from the explicitly selected secret source. No developer-login, storage-source or credential fallback occurs.

### 5. Verify and extend

From an approved host with the configured identity and mounts, [run one live cycle](../synthetic-tests/README.md#prove-one-cycle-before-enabling-recurrence) and inspect every selected Exchange journey, cleanup, and fresh Azure reports. A successful deployment or token request is not a successful mailbox test. Enable recurrence only after allowed/denied checks and reporting are verified.

Use the service-specific setup guides before extending access to another workload.
Teams readback/providers prefer approved managed-identity federation; observer
Graph credentials do not authorize Connector posting or meeting participants.
Revoke only owned grants/certificates and review retained synthetic artifacts
when the certificate trial ends.

## Several tenants in one config

Each `tenants[]` entry has its own workers, `access` and identity bindings. A tenant
`id` or `tenantId` is a label, not authorization. Explicit certificate Graph bindings
for Exchange and OneDrive may target a different tenant while Azure reporting keeps its
own identity. The direct managed-identity/federated and Teams bot/readback guards
require the actual identity tenants to match the entry's `tenantId`, and unsupported
bindings fail before credential use; never relabel a hosting UAMI's `AZURE_TENANT_ID`.
A tenant's `providerClientId`, used by every service of it that collects provider data,
must also match that tenant; a certificate Graph binding does not rebind it. With several
tenants, set `deployment.azureTenantId` to the tenant that hosts the Azure resources; with
one it defaults to that tenant's `tenantId`.

Each service has one health model shared by all tenants. With more than one tenant in
the config, every overall signal a worker publishes is named
`tenant-<tenant id>--<signal>`, for example
`tenant-contoso--synthetic-success-percentage`. That covers journey and step
success/duration, the `teams-call` phase signals, and the Service Health
and activity signals, so tenants never overwrite one another and the shared
`<service>-service-health` entity carries one set per tenant. With exactly one tenant the names
stay plain, and Exchange/OneDrive [user-group](./monitoring-groups.md) signals keep
`group-<id>--tenant-<tenant id>--<signal>`, never qualified twice. Adding a second
tenant renames every overall signal in one step: run `npm run deploy` so the models and
workers change together; reports under the old plain names expire after the report TTL.
`npm run setup:ids` and `npm run setup:reply-seeds` each work on the one config tenant that
matches the signed-in tenant: run them once per tenant, signed in to that tenant.
