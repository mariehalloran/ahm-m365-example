# Programmatic OneDrive setup

Use the OneDrive setup command to discover every configured personal drive,
create/reuse its dedicated test folder, verify a worker `write` grant and save
generated user/drive/folder IDs in the adjacent gitignored `.env`.
The runtime identity never provisions its own access. Complete
[OneDrive account and permission approval](./onedrive-permissions.md) and the
[shared Azure foundation](./setup.md) first.

## Prerequisites and account input

In the matching `tenants[].config` of
[monitoring.onedrive.json](../monitoring.onedrive.json), configure:

- `identity`: the permanent OneDrive execution UAMI.
- `targets.<groupId>.userGroupName` and `users[]`: approved UPNs, dedicated
  `folderName` values and a deliberate `restoreVersion` choice.
- `setup.identity`: a **different**, dedicated setup UAMI, plus its concurrency
  and per-target deadline.

For example:

```json
"setup": {
  "identity": "<dedicated-setup-identity-name>",
  "concurrency": 4,
  "targetTimeoutSeconds": 300
}
```

The helper can create a setup identity named in this resource group; an explicitly
referenced existing identity must already exist. It refuses to use the execution
identity as the provisioner. No client certificate, private key or user-password
credential is used. Runtime consent to `Files.SelectedOperations.Selected` and,
when selected, `Files.ReadWrite.AppFolder` remains a separate administrator action.

Accounts must be licensed and their personal drives must already exist. These
commands do not create accounts, assign licenses or create personal sites. The
operator needs approved Azure job/Blob/role-assignment access and authority to
grant/revoke the setup identity's temporary Graph application permission.

## Provision personal OneDrives

Skip this step if the approved account-provisioning process already created the
drives. A licensed SharePoint Administrator can queue the selected accounts with
`Request-SPOPersonalSite` in an approved SharePoint administration connection.
From the repository root, read the configured account inventory only:

```powershell
$service = Get-Content -Raw -LiteralPath './monitoring.onedrive.json' | ConvertFrom-Json -Depth 100
$selection = ($service.tenants | Where-Object id -eq '<tenant-alias>').config
$upns = @($selection.targets.PSObject.Properties |
    ForEach-Object { $_.Value.users } |
    ForEach-Object { $_.userPrincipalName } | Sort-Object -Unique)
for ($offset = 0; $offset -lt $upns.Count; $offset += 200) {
    $last = [Math]::Min($offset + 199, $upns.Count - 1)
    Request-SPOPersonalSite -UserEmails $upns[$offset..$last] -NoWait
}
```

Each request has at most 200 users and is asynchronous. Wait for provisioning;
a missing drive is a failure, not a skipped/Healthy account. The administrator
and targets need the licenses/roles documented by
[`Request-SPOPersonalSite`](https://learn.microsoft.com/en-us/powershell/module/microsoft.online.sharepoint.powershell/request-spopersonalsite).
Multi-Geo tenants require the appropriate regional administration connection.
Application-only Graph setup does not create missing personal sites.

## Plan, apply and rerun

Run from `synthetic-tests/` after signing the approved operator into the configured
tenant/subscription with Azure CLI:

```sh
npm run setup:ids
npm run onedrive:setup
```

`setup:ids` resolves user IDs and other enabled live services' bindings.
The OneDrive **plan prints selected folder count and intent only**. It makes no
resource/permission changes and does not inspect existing Graph resources or
prove authorization.

After explicit tenant-wide provisioning approval:

```powershell
npm run onedrive:setup -- -Apply -GrantTemporaryPermission
```

[`setup/provision-onedrive.ps1`](../synthetic-tests/setup/provision-onedrive.ps1):

1. Resolves/creates the separate setup UAMI and refuses an existing standing
   `Files.ReadWrite.All` grant.
2. Assigns that tenant-wide application role just in time and launches
   [`onedrive-job.ps1`](../synthetic-tests/setup/onedrive-job.ps1) in a disposable
   managed-identity Container Apps Job using the Microsoft Azure PowerShell image.
3. Discovers drives, creates/reuses folders, adds or upgrades only this worker's
   direct folder grant, verifies write access and returns per-account results.
4. Merges successful `USER_ID`, `DRIVE_ID` and `FOLDER_ID` bindings into `.env`,
   then revokes the temporary Graph grant in `finally`, including operation failure.

The shared job helper also removes its job, uploaded inputs/results and any
temporary Blob role it created. Cleanup/revocation failures are explicit errors:
inspect `.monitoring-deployment/` and remove the recorded temporary grant/job
before rerunning. The helper does not audit or revoke unrelated broad grants.
Revocation does not invalidate already-issued access tokens immediately.

`setup.concurrency` is 1-10 (default 4); `targetTimeoutSeconds` is 30-3,600
(default 300). Ordinary target failures retain successful bindings and return a
nonzero status. Rerun after correcting prerequisites; existing matching folders
and writable grants are reused. Stale drive/folder bindings require review
rather than silent replacement. Run one apply per target set/`.env` at a time.

Selected folder grants can break permission inheritance and consume unique
permission capacity. Use dedicated non-root folders, as described in Microsoft's
[Selected permissions model](https://learn.microsoft.com/en-us/graph/permissions-selected-overview).
Do not give the execution identity `Files.ReadWrite.All` to bypass a setup failure.

## Provisioning Graph endpoints

Paths are relative to `https://graph.microsoft.com/v1.0`. These privileged setup
calls are **not additional runtime worker permissions**:

| Method and path | Purpose |
| --- | --- |
| `GET /users/{UPN}` | Resolve the configured user's ID |
| `GET /users/{UPN}/drive` | Discover the existing OneDrive for Business drive |
| `GET /drives/{driveId}/root` | Verify root metadata |
| `GET /drives/{driveId}/root:/{folderName}` or `GET /drives/{driveId}/items/{folderId}` | Find/revalidate the dedicated non-root folder |
| `POST /drives/{driveId}/root/children` | Create the folder if missing |
| `GET`, `POST /drives/{driveId}/items/{folderId}/permissions` | Read or add the worker's application write grant |
| `PATCH /drives/{driveId}/items/{folderId}/permissions/{permissionId}` | Upgrade this worker's existing direct grant |
| `POST /servicePrincipals/{setupPrincipalId}/appRoleAssignments` | Operator approves the temporary application role |
| `DELETE /servicePrincipals/{setupPrincipalId}/appRoleAssignments/{assignmentId}` | Operator revokes that role after setup |

Use the [OneDrive README](../synthetic-tests/onedrive/README.md#graph-endpoints)
for normal journey endpoints.

## Size the worker for hundreds of accounts

Setup concurrency is separate from execution scheduling and Graph request
capacity. A successfully provisioned inventory is not proof every journey can
finish within its configured cadence/deadline. Review `config.execution`, the
deployment plan and actual execution/publication freshness before increasing
targets. Do not mask missing attempts by extending report TTLs.

## Deploy and verify the actual health flow

After bindings/grants are ready, preview and redeploy from `synthetic-tests/`:

```sh
npm run deploy -- --plan
npm run deploy
```

Verify real file roundtrips, app-folder updates, prior-version bytes,
owned-artifact cleanup and accepted reports on the OneDrive journey/step entities.
Administrator grant readback or a completed provisioning job does not prove
runtime identity access or model/notification health. Audit existing broad
worker grants and an approved out-of-scope denied-access control, then complete
the [operational checks](./operations.md#enterprise-reliability-acceptance-gate).
