# SharePoint permissions and managed identity setup

The SharePoint worker uses one explicitly selected, same-tenant user-assigned
managed identity (UAMI). It exercises three Graph v1.0 journeys:
`document-library-roundtrip`, `document-versions` and `list-item-lifecycle`.
Complete the shared [Azure setup](./setup.md) and
[tenant-binding checks](./cross-tenant-access.md) first.

## Approve the site and fixtures

Choose an administrator-approved existing `/sites/...` or `/teams/...` site.
A Team-backed site is supported; consent applies to the **whole selected site**,
not only its synthetic folder/list. Use dedicated fixtures and review that scope
with the site owner:

- A document library with version history enabled and at least two revisions.
- One dedicated direct child test folder under that library's root.
- An ordinary list with the standard `Title` field.

Required checkout, content approval, extra required fields, sensitivity protection
or retention rules must not prevent the approved writes, reads and deletes.
Provisioning and policy choices remain administrator actions, not worker behavior.

## Required synthetic permissions

| Worker Graph application permission | Separate resource assignment |
| --- | --- |
| `Sites.Selected` | Administrator-approved application `write` on the chosen site |

Both application consent and the site assignment are necessary. Consent alone
grants no site access. An authorized administrator manages the
[`/sites/{siteId}/permissions` assignment](https://learn.microsoft.com/en-us/graph/api/site-post-permissions?view=graph-rest-1.0)
for the worker's application/client ID, not its principal/object ID.
Audit any pre-existing broad grants: runtime target checks do not narrow them.

Never grant the worker or its read-only discovery command `Sites.ReadWrite.All`,
`Files.ReadWrite.All` or `Sites.FullControl.All`. If approved one-time fixture
provisioning needs `Sites.FullControl.All`, use a **separate disposable admin
managed identity/job**, grant it just in time, and revoke the assignment and
remove the job immediately afterward, including failure paths. That identity is
not the worker, a discovery credential or a runtime fallback.

## Configure and discover IDs

Use only root [`monitoring.config.json`](../monitoring.config.json):

1. Select the real app and approved UAMI in
   `tenants[].services.sharepoint.worker.appName` / `worker.identity`.
2. Set ungrouped `targets[]` with the actual `siteUrl`, `libraryName`,
   `folderName` and `listName`. The folder name is one child, not a path.
   Do not assign target IDs or add discovered resource IDs.
3. Keep Graph and health-report authentication `managed-identity`, then enable
   the service in `live` mode only after access and fixtures are ready.
4. On an approved same-tenant Azure host with the worker UAMI attached, explicitly
   set its actual `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
   `ENABLE_LIVE_M365=true`. From `synthetic-tests/`, run:

   ```sh
   npm run setup:ids -- -SharePointOnly
   # For several configured tenants, add -Tenant <alias>.
   ```

Discovery only reads the existing selected resources. It creates no sites,
libraries, folders, lists or grants and has no Azure CLI, delegated, certificate
or secret credential fallback. For a compiled worker image the same entrypoint
is `node dist/sharepoint/src/setup-command.js --tenant <alias>`.

Approved fixture-provisioning outputs may bootstrap the four generated bindings
before deployment. The canonical `npm run deploy` grants the worker its normal
image/configuration/reporting roles. After rollout, run the compiled command in
a disposable job using **only that worker UAMI** and the deployed immutable
`MONITORING_CONFIG_BLOB_URL` / `MONITORING_CONFIG_SHA256`. It performs fresh
read-only discovery, requires all four IDs to match that snapshot and writes no
local `.env`. Administrative IDs enable bootstrap; they are not worker-access
proof or health measurements. No extra setup identity or duplicate worker
registry/Blob grant is needed for this verification.

Discovered `SITE_ID`, `DRIVE_ID`, `FOLDER_ID` and `LIST_ID` go in the adjacent
gitignored [`.env`](./deployment.md#generated-ids-in-env), keyed
`<TENANT>__SHAREPOINT_<SHA256>__<FIELD>`. The hash derives from normalized location
choices. Deployment and commands hydrate those bindings automatically.
Keep SharePoint disabled with no targets until real fixtures are approved.

## Run and verify

Review `npm run deploy -- --plan` before the separately approved deployment.
Use `npm run sharepoint -- --once` for the first real cycle. All three lanes use
a **240-second complete-journey deadline** and **300-second cadence**. The default
252-second cycle budget plus 12-second cleanup-settlement and 30-second publication
reserves fits the 299-second whole-cycle envelope. Actual cleanup has its own
10-second budget; latency thresholds remain **15 seconds Degraded / 60 seconds
Unhealthy**. Capacity validation includes every configured target.

Verify actual document bytes, prior-version bytes, persisted list fields,
owned-artifact cleanup, accepted reports and
[notification/freshness checks](./operations.md#enterprise-reliability-acceptance-gate).
Permission readback or offline checks do not establish live acceptance. Test
allowed access to the chosen site and denied access to an approved control site
before recurring use. Worker cancellation and cleanup-only outcomes are Unknown
without numeric samples; genuine failures and journey deadline expiry remain
failures, preserving successful business-step evidence.

The [worker reference](../synthetic-tests/sharepoint/README.md#api-reference)
lists the exact Graph v1.0 endpoints. Cleanup verifies the current attempt's
nonce, parent and resource metadata before deleting; it never deletes the
configured folder, library, list or site. Deleted files enter the recycle bin;
there is no permanent purge. These API-backed checks do not measure employee
browser, search, sharing or coauthoring experience.

## Optional provider context and revocation

The separately approved provider application needs `ServiceHealth.Read.All` for
stable overviews/issues and `ServiceMessage.Read.All` for selected Message Center
collection, with federation for the SharePoint worker UAMI. These are tenant-wide
read grants, not site permissions. SharePoint has no beta activity collector.

The stable `SharePoint` / `SharePoint Online` source reports only to the single
suppressed `sharepoint-service-health` entity. It cannot change synthetic
outcomes, business-step signals or Experience rollup. Follow the
[provider runbook](./provider-monitoring.md) for independent collection schedules.

Stop the worker before revoking its selected-site assignment and application
consent. Review only confirmed synthetic artifacts under the approved retention
policy; never purge a site, library, list or recycle bin.

Microsoft reference:
[Selected permissions overview](https://learn.microsoft.com/en-us/graph/permissions-selected-overview).
