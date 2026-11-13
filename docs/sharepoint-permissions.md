# SharePoint permissions and managed identity setup

The SharePoint execution Function uses one explicitly selected, same-tenant user-assigned
managed identity (UAMI). It exercises two Graph v1.0 journeys:
`document-library-roundtrip` (including version checks) and `list-item-lifecycle`.
Complete the shared [Azure setup](./setup.md) and
[tenant-binding checks](./cross-tenant-access.md) first.

## Approve the site and fixtures

A SharePoint Administrator/site owner prepares an approved existing `/sites/...`
or `/teams/...` site. A separately authorized Entra administrator approves Graph
application consent and an authorized site-permission administrator assigns the
Selected resource grant.
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
[`POST /sites/{siteId}/permissions` assignment](https://learn.microsoft.com/en-us/graph/api/site-post-permissions?view=graph-rest-1.0)
for the worker's application/client ID, not its principal/object ID.
Audit any pre-existing broad grants: runtime target checks do not narrow them.

Never grant the worker or its read-only discovery command `Sites.ReadWrite.All`,
`Files.ReadWrite.All` or `Sites.FullControl.All`. If approved one-time fixture
provisioning needs `Sites.FullControl.All`, use a **separate disposable admin
managed identity/job**, grant it just in time, and revoke the assignment and
remove the job immediately afterward, including failure paths. That identity is
not the worker, a discovery credential or a runtime fallback.

## Configure and discover IDs

In the matching `tenants[].config` of
[`monitoring.sharepoint.json`](../monitoring.sharepoint.json), referenced by root
[`monitoring.config.json`](../monitoring.config.json):

1. Select the approved existing UAMI in `config.identity`. The deployment creates
   the service Function host using root `deployment.functions`.
2. Set ungrouped `targets[]` with the actual `siteUrl`, `libraryName`,
   `folderName` and `listName`. The folder name is one child, not a path.
   Do not assign target IDs or add discovered resource IDs.
3. Keep Graph and health-report authentication `managed-identity`, then enable
   the service in `live` mode only after access and fixtures are ready.
4. After the shared Azure foundation, sign the operator into the configured
   Azure CLI tenant/subscription and run from `synthetic-tests/`:

   ```sh
   npm run setup:ids -- -SharePointOnly
   # For several configured tenants, add -Tenant <alias>.
   ```

[`setup/discover-sharepoint.ps1`](../synthetic-tests/setup/discover-sharepoint.ps1)
launches a disposable PowerShell job using **only the selected SharePoint UAMI
for Graph**. The operator's Azure session creates the job, handles protected
Blob input/output and temporary Azure role assignments; it is not a Graph
discovery fallback. The job reads existing resources and creates no sites,
libraries, folders, lists or Graph grants. It uses no delegated user token,
secret or certificate.

Discovery verifies the configured URL, named document library, non-root test
folder and ordinary list before returning bindings. Job/Blob/temporary Azure-role
cleanup failures are explicit errors. These read checks prove selected-resource
read access, not successful writes, deletions or health measurements.

Discovered `SITE_ID`, `DRIVE_ID`, `FOLDER_ID` and `LIST_ID` go in the adjacent
gitignored [`.env`](./deployment.md#generated-ids-in-env), keyed
`<TENANT>__SHAREPOINT_<SHA256>__<FIELD>`. The hash derives from normalized location
choices. Deployment and commands hydrate those bindings automatically.
For a new deployment, keep SharePoint disabled until fixtures/access are approved.
The checked-in profile already selects one real site/library/folder/list.

## Run and verify

Review `npm run deploy -- --plan` before the separately approved deployment.
For a first real cycle, use `npm run sharepoint -- --once` on an Azure host with
the selected identity attached and `ENABLE_LIVE_M365=true`. The current config
selects a **240-second complete-journey deadline** and **600-second cadence**;
those values and budgets come from `config.execution`. The default
252-second cycle budget plus 12-second cleanup-settlement and 30-second publication
reserves fits the 599-second whole-cycle envelope. Actual cleanup has its own
10-second budget; latency above **15 seconds is Degraded only**.
Capacity validation includes every configured target.

Verify actual document bytes, prior-version bytes, persisted list fields,
owned-artifact cleanup, accepted reports and
[notification/freshness checks](./operations.md#enterprise-reliability-acceptance-gate).
Permission readback or offline checks do not establish live acceptance. Test
allowed access to the chosen site and denied access to an approved control site
before recurring use. Worker cancellation and cleanup-only outcomes are Unknown
without numeric samples; genuine failures and journey deadline expiry remain
failures, preserving successful business-step evidence.

The [service README](../synthetic-tests/sharepoint/README.md#api-reference)
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
[provider authentication runbook](./provider-monitoring.md#provider-authentication)
and [SharePoint optional endpoints](../synthetic-tests/sharepoint/README.md#optional-provider-endpoints).
Provider selection lives in `config.execution` with root `serviceHealth.enabled`;
it has independent collection schedules.

Stop service scheduling before revoking its selected-site assignment and application
consent. Review only confirmed synthetic artifacts under the approved retention
policy; never purge a site, library, list or recycle bin.

Microsoft reference:
[Selected permissions overview](https://learn.microsoft.com/en-us/graph/permissions-selected-overview).
