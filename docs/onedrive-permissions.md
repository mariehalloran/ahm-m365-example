# OneDrive permissions and managed identity setup

The OneDrive worker uses an explicitly selected user-assigned managed identity
(UAMI) against dedicated Microsoft 365 test accounts. Complete the shared
[account and Azure setup](./setup.md) and use the
[bulk folder-provisioning runbook](./onedrive-setup.md), rather than manual
per-account folder IDs or grants. Keep the identity and accounts in the
[supported tenant binding](./cross-tenant-access.md).

## Accounts and root configuration

Each account needs a SharePoint Online/OneDrive entitlement and an already
provisioned personal OneDrive. Application-only Graph setup does not create
personal sites; follow the
[pre-provisioning instructions](./onedrive-setup.md#provision-personal-onedrives).
The accounts are resource owners, not worker login credentials.

Configure only root [`monitoring.config.json`](../monitoring.config.json):

- `tenants[].services.onedrive.targets.<groupId>` contains `userGroupName` and
  `users[]`; each user supplies `userPrincipalName`, `folderName` and the deliberate
  `restoreVersion` choice.
- Account keys derive automatically from the UPN. Do not assign target IDs or
  put `userId`, `driveId` or `folderId` in the config.
- `npm run setup:ids` resolves user IDs. The separate `npm run onedrive:setup`
  command discovers drives and creates/reuses folders and grants. Both save
  [generated bindings in the adjacent gitignored `.env`](./deployment.md#generated-ids-in-env);
  deployment and TypeScript commands hydrate them automatically.

Reporting groups and configured UPN filters do not grant tenant access.

## Required synthetic permissions

| Worker Graph application permission | Selected journey and resource grant |
| --- | --- |
| `Files.SelectedOperations.Selected` | `user-drive-roundtrip` and `document-versions`: an explicit application `write` grant on each dedicated test folder |
| `Files.ReadWrite.AppFolder` | Only `app-folder-lifecycle`: the application's special app folder in the selected user's drive |

Selected permission consent **alone** grants no folder access: the separate folder
grant is also required. Folder write access includes its contents, not merely
cycle-created artifacts; use dedicated folders. Selected grants can break
inheritance and consume unique-permission capacity, as described in the
[bulk setup guide](./onedrive-setup.md#plan-apply-and-rerun).

`Files.ReadWrite.AppFolder` is a distinct application permission, not an extension
of the selected-folder grant or a tenant-enforced allowlist of configured users.
Approve it separately. Do not grant the runtime worker `Files.ReadWrite.All` or
`Sites.ReadWrite.All`, and audit pre-existing broad grants: runtime target and
ownership checks do not narrow those permissions.

## Separate provisioning authorization

Use a **dedicated setup managed identity**, never the worker identity. The
[existing managed-identity job runbook](./onedrive-setup.md#run-with-a-managed-identity)
covers a disposable Container Apps Job:

1. Approve transient Graph application `Files.ReadWrite.All` on the setup identity.
   It is tenant-wide provisioning authority, not a worker requirement.
2. Set `setup.authentication: "managed-identity"`, `setup.setupClientId` and
   `setup.workerClientId` in the service's root config block. These are client IDs,
   not principal/object IDs; no `setup.enabled` switch is needed.
3. Run `setup:ids` first. Review the read-only `onedrive:setup` plan on the approved
   host, then use `--apply` to create/reuse each named folder and write grant.
4. Verify persisted grants/bindings, then revoke the temporary Graph app-role
   assignment and remove the disposable job **even if provisioning fails**.

The setup identity needs approved image-pull access but no standing Graph
permission between runs. No certificate, private key or account password is part
of this setup. The command provisions only root-selected accounts, checkpoints
successful targets and supports reruns; it does not create accounts/licenses,
grant application consent or silently skip failed accounts.

## Implemented Graph endpoints

All paths use `https://graph.microsoft.com/v1.0`. Runtime operations are:

| Method and path | Journey use |
| --- | --- |
| `GET /drives/{driveId}/items/{folderId}` | Verify the selected folder and owned-resource metadata |
| `POST /drives/{driveId}/items/{parentId}/children` | Create a cycle-owned child folder |
| `PUT /drives/{driveId}/items/{folderId}:/{fileName}:/content` | Write/update synthetic file content |
| `GET /drives/{driveId}/items/{folderId}/children`; `GET .../items/{fileId}/content` | Enumerate, download and verify persisted bytes/hash |
| `GET /users/{userId}/drive/special/approot` | Resolve the separately approved app folder |
| `GET /drives/{driveId}/items/{fileId}/versions`; `GET .../versions/{versionId}/content` | Enumerate versions and verify prior-version bytes |
| `GET /drives/{driveId}/items/{parentId}:/{folderName}`; `DELETE .../items/{folderId}` | Reconcile/remove the owned folder and verify removal |

When `restoreVersion` is enabled, the journey rewrites verified prior-version bytes
through the current-content `PUT`; it does not call a server-side version-restore API.
These are API-backed personal-drive checks, not OneDrive UI or SharePoint-site journeys.

The privileged [setup implementation](../synthetic-tests/onedrive/src/setup.ts)
separately calls `GET /users/{userId}/drive`, `GET /drives/{driveId}/root`,
`GET /drives/{driveId}/root:/{folderName}` and `POST /drives/{driveId}/root/children`.
It lists/adds `/drives/{driveId}/items/{folderId}/permissions` with `GET`/`POST`
and can `PATCH .../permissions/{permissionId}` to upgrade this worker's own direct
grant. It verifies the write grant before saving bindings. The administrator
[ID helper](../synthetic-tests/setup/generate-ids.ps1) separately looks up
`GET /users/{UPN}?$select=id`; these are not additional worker permissions.

## Enable and verify

Keep Graph and health-report authentication as `managed-identity`; live execution
requires an Azure host with the selected identity attached and the
[live gates](./deployment.md#live-execution-gates). Azure image/configuration/report
permissions are [separate](./deployment.md#identity-and-permissions).

Each complete journey retains a **120-second deadline** and **15-second latency
degradation threshold**, with separately bounded cleanup. Cadences belong to the
OneDrive execution lanes (300 seconds in the checked-in config), independently of
Exchange/Teams and providers. Worker cancellation and cleanup-only outcomes are
Unknown without numeric samples; genuine service failures/deadline expiry remain
failures. Validate real operations, owned-artifact cleanup, accepted reports and
[notification/freshness checks](./operations.md#enterprise-reliability-acceptance-gate);
administrator grant readback alone does not prove worker access.

## Optional provider context

The independently selected federated provider application needs
`ServiceHealth.Read.All` for stable overviews/issues and separately approved
`ServiceMessage.Read.All` for Message Center. These are tenant-wide read grants,
not file permissions. **No OneDrive beta `serviceActivity` collector is implemented.**

Use the [provider runbook](./provider-monitoring.md) for exact endpoints, federation
and independent provider cadence. Context stays on the single suppressed
`onedrive-service-health` entity and cannot change synthetic outcomes,
business-step measurements or Experience rollup.

Stop the worker before revocation. Review both selected-folder grants and AppFolder
consent separately, revoke temporary provisioning grants, and remove only confirmed
synthetic artifacts subject to retention. Never purge a drive or its recycle bin.

Microsoft references:
[Selected permissions](https://learn.microsoft.com/en-us/graph/permissions-selected-overview),
[application folders](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder).
