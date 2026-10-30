# Programmatic OneDrive setup

One administrator command prepares every approved account in
`monitoring.config.json`: discover its drive, create/reuse the named dedicated folder,
grant the worker folder-scoped write access, verify the grant, and save the real
drive and folder IDs to the gitignored `.env` beside the config
([generated IDs](./deployment.md#generated-ids-in-env)). It supports up to 1,000
configured accounts without per-account commands. The worker remains least-privilege
and never provisions its own access. This command is separate from `npm run setup:ids`, which
only looks up each account's user ID (`USER_ID` in `.env`) and leaves the drives and
folders to this command ([setup](./deployment.md#set-up-microsoft-365)).

## Prerequisites and account input

Follow the [deployment order](./deployment.md#deploy-with-one-command): `npm run deploy`
creates the health models and worker foundation/identities first
(`deployment.stage: "foundation"` stops there until approvals are in place), then
approve M365 access following [`docs/setup.md`](./setup.md), run `npm run setup:ids` and
then this setup, and deploy the live workers. Keep certificates and keys outside Git.

Generate [user groups](./monitoring-groups.md) under
`tenants[].services.onedrive.targets` in `monitoring.config.json`, each keyed by its
group ID with `userGroupName` and a `users` array from your approved
account-provisioning output. Each user target needs the account's `userPrincipalName`
and a dedicated `folderName`,
normally `AHM-Synthetic-Tests`. Set `restoreVersion` deliberately. Leave out `userId`,
`driveId` and `folderId`: `npm run setup:ids` looks up `userId` from the `userPrincipalName`,
this command writes the drive and folder IDs, and deploy fills all three in using an
account key derived automatically from the case-insensitive UPN. Do not supply a target `id`.
The generated [binding keys](./deployment.md#generated-ids-in-env) use that account key.
Run `npm run setup:ids` first, with the OneDrive service in `live` mode (it acts only on live
services), because this command reads the user IDs. Shared users use the same UPN/settings
and are provisioned only once.
The configured user targets are the only
account inventory; neither setup command enumerates the tenant or silently adds users.

The worker application must already have administrator-approved
`Files.SelectedOperations.Selected` and, for the app-folder journey,
`Files.ReadWrite.AppFolder`. Setup creates the individual folder write grants;
it does not grant application consent.

Use a **separate, explicitly approved setup identity**. Application-based setup
needs Graph `Files.ReadWrite.All`, which is tenant-wide and belongs only to the
provisioning identity, never the runtime worker. Certificate or managed-identity
authentication supports unattended provisioning after approval. An explicit
Azure CLI operator mode can instead use an existing authorized administrator
session with suitable delegated file access. Global/SharePoint administrator
roles alone do not add Graph file permissions.

Setup creates no privileged application, consent, licenses or Azure role
assignments. Obtain those approvals through your normal administration pipeline;
do not attach the provisioning identity to the worker or reuse its credentials
for tests. Revoke temporary provisioning access according to that approval.

`setup.workerClientId` is the worker's **application/client ID**, not its principal
or application-object ID. The foundation identity can be queried programmatically:

```sh
az identity show --subscription '<approved-subscription>' \
  --resource-group '<approved-resource-group>' \
  --name '<worker.identityName>' --query clientId --output tsv
```

## Provision personal OneDrives

Accounts must be licensed and their personal OneDrives must already exist.
Application-only Graph setup does not create personal sites. Skip this step if
your account-provisioning pipeline already does it.

In an approved SharePoint administrator connection, queue only the root-selected
accounts in batches of **at most 200**:

```powershell
$root = Get-Content -Raw -LiteralPath './monitoring.config.json' | ConvertFrom-Json
$tenant = $root.tenants | Where-Object id -eq '<tenant id>'
$upns = @($tenant.services.onedrive.targets.PSObject.Properties |
    ForEach-Object { $_.Value.users } |
    ForEach-Object { $_.userPrincipalName } | Sort-Object -Unique)
for ($offset = 0; $offset -lt $upns.Count; $offset += 200) {
    $last = [Math]::Min($offset + 199, $upns.Count - 1)
    Request-SPOPersonalSite -UserEmails $upns[$offset..$last] -NoWait
}
```

This is asynchronous and ignores existing personal sites. Wait for provisioning
before applying folder setup; a missing drive is reported as an account failure,
not silently skipped or treated as Healthy. The administrator and target users
need the licenses/roles documented by
[`Request-SPOPersonalSite`](https://learn.microsoft.com/en-us/powershell/module/microsoft.online.sharepoint.powershell/request-spopersonalsite).
Multi-Geo tenants require the appropriate regional administration connection.
This is resource administration, not a SharePoint synthetic workload.

## Plan, apply and rerun

Select the provisioning credential in the tenant's OneDrive service block of
`monitoring.config.json`. The M365 tenant is that tenant entry's `tenantId`:

```json
"setup": {
  "authentication": "managed-identity",
  "workerClientId": "<worker-client-id>",
  "setupClientId": "<dedicated-setup-identity-client-id>"
}
```

`authentication` is `managed-identity` (requires `setupClientId`, no certificate or
key material) for an approved managed identity attached to the host running the
command, `certificate` (requires `setupClientId` and `certificatePath`; avoid this —
it means a private key file exists on disk and must be stored and rotated securely)
for environments that cannot attach a managed identity, or `azure-cli` (neither) for
an already-authorized operator session. There is no credential fallback.
Managed-identity/certificate setup refuses the worker client ID as the setup
identity, and `workerClientId` must match `worker.identityClientId` when that is set.
**Prefer `managed-identity`**: no certificates, keys or passwords ever exist on disk.
Azure CLI sessions commonly lack delegated `Files.ReadWrite.All` consent and fail
with Graph 403s unless that consent was separately granted tenant-wide, which is
broader than this setup needs — use managed-identity instead of widening CLI consent.

### Run with a managed identity

Managed identities only authenticate from Azure-hosted compute that has the identity
attached, so run the command inside a short-lived
[Azure Container Apps Job](https://learn.microsoft.com/en-us/azure/container-apps/jobs)
using the same worker image, rather than from a workstation:

1. Create a dedicated setup identity, separate from the OneDrive worker identity, and
   grant it `AcrPull` on the registry so it can pull the worker image:

   ```sh
   az identity create --name <setup-identity-name> --resource-group <approved-resource-group>
   az role assignment create --assignee-object-id <setup-identity-principal-id> \
     --assignee-principal-type ServicePrincipal --role AcrPull --scope <registry-resource-id>
   ```

2. Immediately before provisioning, grant that identity's service principal the Graph
   application role `Files.ReadWrite.All` (admin consent required):

   ```sh
   az rest --method post \
     --url "https://graph.microsoft.com/v1.0/servicePrincipals/<setup-identity-principal-id>/appRoleAssignments" \
     --body '{"principalId":"<setup-identity-principal-id>","resourceId":"<graph-service-principal-id>","appRoleId":"75359482-378d-4052-8f01-80520e7db3cd"}'
   ```

3. Run `node dist/onedrive/src/setup-command.js --config monitoring.config.json --tenant <id> --apply`
   in a Container Apps Job with the setup identity attached
   (`identity.type: UserAssigned`) and `AZURE_CLIENT_ID` set to its client ID, mounting
   the config and `.env` text as the job's command input. Review the plan (omit
   `--apply`) before applying, exactly as in a local run.

4. Delete the job execution and **revoke the `Files.ReadWrite.All` grant** right after
   a successful apply — delete the app role assignment created in step 2. The setup
   identity is left with zero standing Graph permissions between runs; only `AcrPull`
   persists, which is low-risk read-only registry access. Re-grant `Files.ReadWrite.All`
   only when about to provision again.

This keeps the broad `Files.ReadWrite.All` grant transient and off any
continuously-running identity, with no certificate or key ever written to disk.

Run from `synthetic-tests/` with its Node dependencies installed. After a normal
build, production-only installations can invoke
`node dist/onedrive/src/setup-command.js` with the same arguments.
Use that entry or `npm --silent` when consuming JSON progress in automation.
Add `--tenant <id>` when the config has several tenants. The default is a
**read-only plan**, including when existing folders need grants:

```sh
npm run onedrive:setup
```

Review the per-target `folderAction` / `permissionAction`, then apply:

```sh
npm run onedrive:setup -- --apply
```

`setup.concurrency` is 1-10, default 4; `setup.targetTimeoutSeconds` bounds each
target to 30-3,600 seconds, default 300. Credential acquisition is also bounded. Graph
throttling uses bounded retries and honors `Retry-After` up to 60 seconds; longer
delays fail explicitly for a later rerun. Ambiguous writes are reconciled by reading
actual resources, not blindly resending mutations. Short bounded polling verifies
grant propagation; an unobserved grant is never checkpointed as ready.

Each successful account is checkpointed into the gitignored `.env` beside the config
(`<TENANT>__<TARGET>__DRIVE_ID` and `…__FOLDER_ID`, merged and replaced atomically with
mode 0600); `monitoring.config.json` is never rewritten. Other accounts continue after
ordinary permission/provisioning failures. Authentication or checkpoint failures stop new
scheduling. The summary includes `ready`,
`planned`, `failed`, and `notStarted`; failure, interruption or incomplete work
returns a nonzero exit status. Logs contain opaque target IDs/categories, not
tokens, certificate contents or raw API responses.

Rerun the same command after fixing the reported prerequisites. Existing folders
and write grants are reused. Only this worker's direct read grant can be upgraded;
setup does not patch unrelated or inherited permission entries.
[Selected resource grants break permission inheritance](https://learn.microsoft.com/en-us/graph/permissions-selected-overview#how-selected-scopes-work-with-sharepoint-and-onedrive-permissions),
so use dedicated folders and account for unique-permission limits.
Setup never deletes resources to roll back a partial run.
A stale folder ID (from `.env`) or mismatched drive/name
requires explicit review rather than silently rebinding a different resource.

There is no lock file: run one provisioning job per target set and one apply at a time
against the same `.env`. SIGINT/SIGTERM retain completed checkpoints; rerun to
reconcile any uncheckpointed grants.

## Size the worker for hundreds of accounts

Setup concurrency and synthetic execution concurrency are independent.
The service's `execution` block owns `maxConcurrentProbes` (1-20, default 3) and
`cycleTimeoutSeconds` (1-86,400, default 170). Every selected account executes
every selected journey. Up to 1,000 accounts/3,000 OneDrive attempts are supported;
health reports remain aggregated by the same journey/business-step IDs, not
per-account entities.

Live configuration requires each lane's cycle budget to cover:

```text
ceil(selected lane attempts / maxConcurrentProbes) * (lane timeoutSeconds + 12)
```

For **500 accounts**, three separate 120-second lanes and concurrency 20, each
lane needs at least `ceil(500 / 20) * 132 = 3,300` seconds. For example, set
these fields in `tenants[].services.onedrive.execution`:

```json
{
  "maxConcurrentProbes": 20,
  "cycleTimeoutSeconds": 3600
}
```

With 300-second lanes, set root `healthModel.signalWindowMinutes` to at least 75 for
that example. The signal window must exceed cadence + configured cycle budget + 42 seconds
for cleanup/publication, or +54 with OTEL; enabled providers have an independent
budget too. Configuration rejects insufficient capacity or observation windows before live work.
Keep existing lane assignments and the separate [live gates](./deployment.md#live-execution-gates).

Concurrency is **per lane**: three simultaneous lanes at 20 can run 60 attempts.
Lanes never overlap themselves and missed slots are skipped. This conservative
example does **not** guarantee five-minute completion or outage detection:
worst-case account timeouts can take nearly an hour. Do not merely extend TTL to
hide missing progress. Measure Graph throttling, cycle duration, memory and
freshness against your detection target, and obtain approval before increasing
traffic. The default 0.25 CPU/0.5 GiB is not a tested production sizing guarantee.
Additional Container App replicas duplicate work; they do not shard this inventory.

## Deploy and verify the actual health flow

Setup does not deploy, restart workers, run journeys or publish health. Preview with
`npm run deploy -- --plan`, then run `npm run deploy` again: it fills the saved `.env`
bindings into the config it mounts in a new worker revision, rebuilding the image when
`deployment.image.mode` is `build`
([worker rollout](../synthetic-tests/infra/README.md#provision-and-publish)).
Confirm the ready revision uses the expected immutable image and account bindings.

On an approved host, verify a real
[single worker cycle](../synthetic-tests/README.md#prove-one-cycle-before-enabling-recurrence),
owned-artifact cleanup, and actual accepted reports. Confirm fresh values on
`onedrive-planned-user-drive-roundtrip`, `onedrive-planned-app-folder-lifecycle`,
`onedrive-planned-document-versions` and their existing `step-1` through `step-4`
entities. Do not rename those deployed IDs or suppress genuine failures.

Administrator readback does not prove worker access, healthy journeys, model
evaluation or notification delivery. Setup does not audit or revoke pre-existing
broad grants; separately check worker permission assignments and an approved
out-of-scope denied-access control. Continue the independent
[reliability acceptance checks](./operations.md#enterprise-reliability-acceptance-gate);
TTL expiry alone is not a guaranteed Unhealthy alert.

Graph contracts:
[create folders](https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0),
[grant application access](https://learn.microsoft.com/en-us/graph/api/driveitem-post-permissions?view=graph-rest-1.0),
[list permissions](https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions?view=graph-rest-1.0),
and [update roles](https://learn.microsoft.com/en-us/graph/api/permission-update?view=graph-rest-1.0).
