# OneDrive permissions and managed identity setup

The OneDrive execution Function uses an explicitly selected user-assigned
managed identity (UAMI) against dedicated Microsoft 365 test accounts. Complete the shared
[Azure setup](./setup.md) and use the
[bulk folder-provisioning runbook](./onedrive-setup.md), rather than manual
per-account folder IDs or grants. Keep the identity and accounts in the
[supported tenant binding](./cross-tenant-access.md).

## Accounts and service configuration

A User Administrator creates dedicated non-administrator users in **Microsoft
365 admin center > Users > Active users**, assigning usage location and a
SharePoint Online/OneDrive entitlement. Use **Add multiple users** and the
admin center CSV template for bulk creation; a License Administrator can manage
licenses separately. Keep passwords/exports outside Git and retain normal
sign-in protections. The project creates no accounts and assigns no licenses.

Each account needs an already provisioned personal OneDrive. Application-only Graph setup does not create
personal sites; follow the
[pre-provisioning instructions](./onedrive-setup.md#provision-personal-onedrives).
The accounts are resource owners, not worker login credentials.

Configure the matching tenant entry in
[`monitoring.onedrive.json`](../monitoring.onedrive.json), referenced by root
[`monitoring.config.json`](../monitoring.config.json):

- `tenants[].config.targets.<groupId>` contains `userGroupName` and
  `users[]`; each user supplies `userPrincipalName`, `folderName` and the deliberate
  `restoreVersion` choice.
- Account keys derive automatically from the UPN. Do not assign target IDs or
  put `userId`, `driveId` or `folderId` in the config.
- `config.identity` selects the permanent execution UAMI; `config.setup.identity`
  selects a different one-off provisioning UAMI.
- `npm run setup:ids` resolves user IDs. The separate approved `npm run onedrive:setup`
  apply discovers drives and creates/reuses folders/grants, also returning user IDs. Both save
  [generated bindings in the adjacent gitignored `.env`](./deployment.md#generated-ids-in-env);
  deployment and TypeScript commands hydrate them automatically.

Reporting groups and configured UPN filters do not grant tenant access. A
Privileged Role Administrator or Global Administrator approves the runtime
Graph application roles on the execution UAMI's enterprise service principal;
folder grants are separate.

## Required synthetic permissions

| Worker Graph application permission | Selected journey and resource grant |
| --- | --- |
| `Files.SelectedOperations.Selected` | `user-drive-roundtrip`, including version checks: an explicit application `write` grant on each dedicated test folder |
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
[managed-identity job runbook](./onedrive-setup.md#plan-apply-and-rerun)
covers a disposable Container Apps Job:

1. Configure `config.setup.identity` (name or existing resource ID),
   `setup.concurrency` and `setup.targetTimeoutSeconds`. The helper resolves the
   worker's actual client ID from `config.identity`, not a hand-maintained setup ID.
2. With the shared Azure foundation deployed, sign the approved operator into
   the configured Azure CLI tenant/subscription. The operator needs job/Blob/role
   access and authority to grant/revoke Graph application permissions.
3. Review `npm run onedrive:setup`. This is a local count/intent plan, **not**
   readback of folders/grants. Explicitly approve transient tenant-wide
   `Files.ReadWrite.All` only on the separate setup UAMI:
   ```powershell
   npm run onedrive:setup -- -Apply -GrantTemporaryPermission
   ```
4. The helper grants that permission just in time, runs PowerShell under the
   setup identity, saves successful bindings and revokes its temporary Graph
   assignment in `finally`. Job/Blob cleanup is tracked too; resolve any reported
   revocation/cleanup failure before retrying.

The setup identity has no standing Graph permission between runs; the job uses a
Microsoft Azure PowerShell image, not the Node worker image. No certificate,
private key or account password is part of this setup. The command provisions
only selected accounts, retains successful bindings returned by the job and
supports reruns; it does not create accounts/licenses, grant runtime application
consent or silently skip failed accounts.

## Implemented Graph endpoints

The [OneDrive README](../synthetic-tests/onedrive/README.md#graph-endpoints)
lists exact runtime Graph v1.0 paths and maps them to the two journeys.

When `restoreVersion` is enabled, the journey rewrites verified prior-version bytes
through the current-content `PUT`; it does not call a server-side version-restore API.
These are API-backed personal-drive checks, not OneDrive UI or SharePoint-site journeys.

The [provisioning endpoint inventory](./onedrive-setup.md#provisioning-graph-endpoints)
separately documents user/drive discovery, root-folder creation and permission
management in [the PowerShell job](../synthetic-tests/setup/onedrive-job.ps1).
Those privileged calls are not extra runtime permissions.

## Enable and verify

Keep Graph and health-report authentication as `managed-identity`; live execution
requires an Azure host with the selected identity attached and the
[live gates](./deployment.md#live-execution-gates). Azure image/configuration/report
permissions are [separate](./deployment.md#identity-and-permissions).

The current service config selects a **240-second complete-journey deadline**;
latency above **15 seconds is Degraded only**,
with separately bounded cleanup.
All selected OneDrive lanes currently run every **600 seconds**; cadence and
budgets come from `config.execution`, not hardcoded runtime limits.
Provider schedules remain independent. Worker cancellation and cleanup-only outcomes are
Unknown without numeric samples; genuine service failures/deadline expiry remain
failures. Validate real operations, owned-artifact cleanup, accepted reports and
[notification/freshness checks](./operations.md#enterprise-reliability-acceptance-gate);
administrator grant readback alone does not prove worker access.

## Optional provider context

The independently selected federated provider application needs
`ServiceHealth.Read.All` for stable overviews/issues and separately approved
`ServiceMessage.Read.All` for Message Center. These are tenant-wide read grants,
not file permissions. **No OneDrive beta `serviceActivity` collector is implemented.**

Use the [provider authentication runbook](./provider-monitoring.md#provider-authentication)
and [OneDrive optional endpoint inventory](../synthetic-tests/onedrive/README.md#optional-provider-endpoints)
for separate consent/federation. Selection lives in `config.execution` with root
`serviceHealth.enabled`. Provider cadence is independent. Context stays on the single suppressed
`onedrive-service-health` entity and cannot change synthetic outcomes,
business-step measurements or Experience rollup.

Stop service scheduling before revocation. Review both selected-folder grants and AppFolder
consent separately, revoke temporary provisioning grants, and remove only confirmed
synthetic artifacts subject to retention. Never purge a drive or its recycle bin.

Microsoft references:
[Selected permissions](https://learn.microsoft.com/en-us/graph/permissions-selected-overview),
[application folders](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder).
