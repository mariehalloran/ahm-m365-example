# Set up Microsoft 365 monitoring access

## Recommended: deploy in the customer's tenant

1. Use a customer-approved Azure subscription **associated with the same Entra
   tenant as Microsoft 365**. The subscription owner's email does not determine
   its tenant. Azure access does not confer Microsoft 365 permissions or licenses.
2. Approve dedicated Exchange/OneDrive test accounts and bot-only Teams resources.
   The test accounts own mailboxes/drives; Teams participants are selected
   managed-identity bots. A licensed organizer prepares the meeting but does not
   answer synthetic calls. SharePoint uses approved site/library/folder/list
   fixtures, not a user account.
3. Edit root [`monitoring.config.json`](../monitoring.config.json) and its referenced
   service files. Keep
   `graphAuthentication` and `healthReportAuthentication` as `managed-identity`
   in each service's `execution` block. `deployment.azureTenantId` defaults to
   the single monitored tenant's `tenantId`; it must match the actual subscription
   tenant ([configuration](./deployment.md#what-the-config-holds)).
4. Complete [shared Azure/Function API preparation](./setup.md), then run
   `npm run deploy` from `synthetic-tests/` with
   `deployment.stage: "foundation"` to create the models and worker foundation
   without live workers. This does not grant Microsoft 365 authorization.
5. Obtain the service-specific grants:

   | Service | Administrator runbook |
   | --- | --- |
   | Exchange | [Mailbox-scoped application RBAC](./exchange-permissions.md#exchange-application-rbac), without tenant-wide Entra mail/calendar grants |
   | Teams | [Managed-identity bot pairs and readback](./teams-permissions.md); install each primary app and approve calling separately for every participating UAMI |
   | OneDrive | [Selected-folder and AppFolder permissions](./onedrive-permissions.md), with separate transient provisioning authority for [bulk setup](./onedrive-setup.md) |
   | SharePoint | [Application `Sites.Selected` and site-scoped write](./sharepoint-permissions.md); read-only ID discovery uses the same selected worker UAMI |
   | Provider context | [Read-only provider application and federation](./provider-monitoring.md), independent of synthetic permissions |
   | Azure reporting | [Configuration/reporting roles](./deployment.md#identity-and-permissions), plus separately approved entity-scoped [annotation access](./provider-monitoring.md#notice-update-data-annotations) when selected |

6. Follow each service's guide above for administrator actions,
   including [mailbox-scope maintenance](./exchange-permissions.md#maintain-the-approved-mailbox-scope)
   and [Teams app installation](./teams-permissions.md#generated-ids-callback-and-installed-apps). Run
   `npm run setup:ids`, `npm run setup:reply-seeds` when SELF-REPLY is selected,
   and the separately approved OneDrive setup job. SharePoint-only discovery is
   `npm run setup:ids -- -SharePointOnly`, which launches a disposable PowerShell
   job using the same-tenant SharePoint execution UAMI.
   Generated IDs stay in the adjacent gitignored
   [`.env`](./deployment.md#generated-ids-in-env).
7. After allowed/denied access checks, select each approved service `config.identity`,
   set `execution.mode: "live"`, `deployment.enableLiveProbes: true` and
   `deployment.stage: "all"`, then deploy. Verify actual operations,
   cleanup, accepted reports and [notifications/freshness](./operations.md#enterprise-reliability-acceptance-gate).

**Same tenant does not eliminate permission or policy reviews.** Keep images,
identities, diagnostics and alerts customer-controlled. The checked-in Teams
configuration selects two independent bot pairs; all four participant identities
must be approved and attached. Provider credentials remain separate application-only
authorization and cannot change synthetic outcomes.

## Cross-tenant hosting boundary

Use **secretless managed-identity federation**, not uploaded keys, for an approved
cross-tenant access design. However, **generic cross-tenant synthetic federation
is not implemented in this runner**. The implemented provider and Teams readback
federation uses the actual Azure identity tenant; Teams additionally requires
matching Azure, bot and target tenants.

For the documented managed-identity setup, host the workers/identities in the
Microsoft 365 tenant. Do not relabel a UAMI's `AZURE_TENANT_ID` or assume changing
`tenantId`, `providerClientId` or the subscription creates cross-tenant trust.
Tenant-binding guards reject unsupported combinations before credential use.
An approved cross-tenant extension requires implementation and validation beyond
this documentation; there is no key-upload workaround in this setup path.
SharePoint requires the selected same-tenant managed identity for both runtime
and discovery; it has no CLI, delegated, certificate or secret fallback.

## Several tenants in one config

Each composed `tenants[]` entry has its own service execution and identity bindings. A tenant
`id` is a label, not authorization or a cross-tenant execution mechanism. With
several tenants, set `deployment.azureTenantId` to the actual Azure hosting tenant;
that setting does not relax the binding requirements above.

Each service has one health model shared by all tenants. With more than one tenant,
overall signal names use `tenant-<tenant id>--<signal>`, including journey/step,
Teams call-phase and provider signals. Single-tenant overall names stay plain.
Exchange/OneDrive [user-group signals](./monitoring-groups.md) keep
`group-<id>--tenant-<tenant id>--<signal>`, never qualified twice.
Adding a second tenant changes overall signal names: deploy models and workers
together; old reports expire after their TTL.

`npm run setup:ids` and `npm run setup:reply-seeds` select the configured tenant
matching the signed-in administrator. Repeat them per tenant under its approved
binding; they do not supply cross-tenant worker authentication. SharePoint-only
discovery uses the selected tenant's managed identity inside its one-off job.
