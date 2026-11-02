# SharePoint Online synthetic journeys

The independent SharePoint worker validates real document-library and ordinary
list-item journeys through Microsoft Graph v1.0. It uses no test-user sign-in.
The checked-in profile selects one approved site/library/test-folder/list target.
Worker-identity discovery and live journey acceptance remain required before
accepting monitoring.

## Journeys

| Scenario | Completed flow |
| --- | --- |
| `document-library-roundtrip` | Create a cycle-owned folder under the approved test folder, upload, enumerate/download, verify exact bytes, delete and verify removal |
| `document-versions` | Write and verify two revisions, enumerate history, download and verify prior bytes, delete and verify removal |
| `list-item-lifecycle` | Create an item, read its Title, update, reopen/verify, delete and verify absence |

## Setup

1. Follow [SharePoint permissions](../../docs/sharepoint-permissions.md).
   An administrator prepares an approved SharePoint site (including a Team-backed
   site), document
   library, direct child test folder and ordinary list with standard `Title`.
   Enable library version history with at least two retained revisions. Use
   fixtures without required checkout, content approval, extra required fields,
   sensitivity protection or retention policies that prevent these operations.
2. Grant the explicitly selected worker managed identity application
   [`Sites.Selected`](https://learn.microsoft.com/en-us/graph/permissions-selected-overview)
   and administrator-approved **write** on that designated site. Consent alone
   grants no site access. An administrator separately manages the
   [`/sites/{site-id}/permissions` grant](https://learn.microsoft.com/en-us/graph/api/site-post-permissions?view=graph-rest-1.0);
   neither the worker nor the ID-discovery command receives tenant-wide
   write/full-control permission. Privileged fixture provisioning is a separate,
   administrator-controlled action.
3. In root [monitoring.config.json](../../monitoring.config.json), configure the real `sharepoint.worker`
   app/identity, set `enabled: true`, and add ungrouped `targets[]` with
   `siteUrl`, `libraryName`, `folderName`, `listName`. Names must match the
   prepared resources; `folderName` is one direct child, not a path. Do not
   supply target IDs, personal OneDrive UPNs or discovered resource IDs.
4. On an approved same-tenant managed-identity host with that identity attached,
   set its actual `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
   `ENABLE_LIVE_M365=true`, then run from [synthetic-tests/](../):

   ```sh
   npm run setup:ids -- -SharePointOnly
   # Multiple tenants: add -Tenant <alias>
   npm run deploy -- --plan
   ```

Discovery only reads existing resources and idempotently saves `SITE_ID`,
`DRIVE_ID`, `FOLDER_ID`, `LIST_ID` in the [adjacent gitignored `.env`](../../docs/deployment.md#generated-ids-in-env).
Keys are `<TENANT>__SHAREPOINT_<SHA256>__<FIELD>`; the hash derives from normalized
site URL/library/folder/list choices. Setup creates no resources or grants and
has no Azure CLI, delegated, secret or certificate authentication fallback.
Disabled selection skips discovery and execution without publishing health.

Approved fixture-provisioning outputs can bootstrap those generated bindings
before the normal deployment. They are not health samples or proof of worker
access. After rollout, run the compiled command from `/app` in a disposable job:

```sh
node dist/sharepoint/src/setup-command.js --tenant <alias>
```

Use only the worker UAMI and retain its deployed `MONITORING_CONFIG_BLOB_URL` /
`MONITORING_CONFIG_SHA256`; omit `--config`. With that immutable
snapshot, discovery verifies all four IDs match and writes no local `.env`;
no additional registry, Blob or Graph grant is needed beyond normal worker roles.

## Run and interpret

```sh
npm run sharepoint -- --once
npm run sharepoint -- --tenant <alias> --once
```

The configured defaults are three independent 300-second lanes, 240-second
journey deadlines, three concurrent attempts per lane and a 252-second cycle
budget. Cleanup has its own 10-second budget, with 12 seconds for settlement and
30 for publication inside a 299-second whole-cycle bound. Latency thresholds
remain the root policy (15 seconds Degraded / 60 seconds Unhealthy).
Failed authentication, permissions, bytes,
fields, deletion or a journey deadline remain failures. Worker/cycle/shutdown
cancellation and cleanup-only failures are Unknown without numeric samples;
successful executed steps survive later cancellation or cleanup failure.

Each attempt has a fresh correlation ID. Cleanup checks the exact owned
folder/item name and parent before deleting; it never deletes the configured
folder, library, list or site. Files move to SharePoint's recycle bin, not
permanent purge. Do not place human data in cycle-owned scratch folders.

Both direct reports and observations/KQL use the common measurement path.
Logs retain target ID and site/library/folder/list dimensions, not a synthetic
user. Optional stable `SharePoint` / `SharePoint Online` Service Health remains
suppressed supporting context with separately approved `ServiceHealth.Read.All`
and, for messages, `ServiceMessage.Read.All`. It does not alter synthetic health.

## API reference

All paths below are relative to `https://graph.microsoft.com/v1.0`.
Microsoft's [Selected permissions model](https://learn.microsoft.com/en-us/graph/permissions-selected-overview)
authorizes these operations on the assigned site; endpoint permission tables
also describe broader permissions, which this worker does not request.

| Operation | Exact path |
| --- | --- |
| [Resolve site](https://learn.microsoft.com/en-us/graph/api/site-getbypath?view=graph-rest-1.0), verify binding | `GET /sites/{hostname}:/{site-path}`, `GET /sites/{site-id}` |
| [Libraries](https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0), existing folder | `GET /sites/{site-id}/drives`, `GET /drives/{drive-id}/root:/{folder-name}` |
| [Create folder](https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0), enumerate | `POST /drives/{drive-id}/items/{parent-id}/children`, `GET /drives/{drive-id}/items/{item-id}/children` |
| [Upload/update](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0), [download](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0) | `PUT /drives/{drive-id}/items/{parent-id}:/{filename}:/content`, `GET /drives/{drive-id}/items/{item-id}/content` |
| [Versions](https://learn.microsoft.com/en-us/graph/api/driveitem-list-versions?view=graph-rest-1.0), [prior bytes](https://learn.microsoft.com/en-us/graph/api/driveitemversion-get-contents?view=graph-rest-1.0) | `GET /drives/{drive-id}/items/{item-id}/versions`, `GET /drives/{drive-id}/items/{item-id}/versions/{version-id}/content` |
| [Verify/delete artifacts](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0) | `GET`, `DELETE /drives/{drive-id}/items/{item-id}` |
| [Lists](https://learn.microsoft.com/en-us/graph/api/list-list?view=graph-rest-1.0) | `GET /sites/{site-id}/lists`, `GET /sites/{site-id}/lists/{list-id}` |
| [Create](https://learn.microsoft.com/en-us/graph/api/listitem-create?view=graph-rest-1.0), [read](https://learn.microsoft.com/en-us/graph/api/listitem-get?view=graph-rest-1.0), [update](https://learn.microsoft.com/en-us/graph/api/listitem-update?view=graph-rest-1.0), [delete](https://learn.microsoft.com/en-us/graph/api/listitem-delete?view=graph-rest-1.0) item | `POST /sites/{site-id}/lists/{list-id}/items`; `GET`, `DELETE .../items/{item-id}`; `PATCH .../items/{item-id}/fields` |

API-backed persistence does not establish employee browser, search, sharing or
coauthoring experience. Before recurring use, approve and verify real journeys,
cleanup, accepted reporting and notifications using [setup](../../docs/setup.md)
and [operations](../../docs/operations.md). Offline checks are not live validation.
