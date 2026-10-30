# OneDrive API-backed synthetic journeys

One independent Container App supports three journeys, executing every enabled
journey for **every configured account** on independent 300-second lanes. Workers
keep no cross-cycle state/outbox; each cycle publishes aggregated success percentages
and mean journey/action durations directly when `logAnalytics.enabled` is false,
with console diagnostics in both modes. Enabling that single root toggle publishes
per-attempt observations through the logging pipeline for KQL-backed model health.
See [architecture diagrams](../../docs/architecture.md) for both reporting paths.

These tests exercise Graph, not employee sign-in, browser rendering or sync.
Sharing/search/browser prototypes and SharePoint are not selectable.
Local source validation does not establish successful live access or ingestion; see
[deployment evidence](../../docs/deployment.md#deployment-status-and-order).

## Primary setup

Run npm commands from `synthetic-tests/`; maintain only root `monitoring.config.json`.
Setup requires `deployment.foundation.mode: "existing"` even when creating missing
bare-name foundation resources.

1. Define [user groups](../../docs/monitoring-groups.md) under
   `tenants[].services.onedrive.targets` in `monitoring.config.json`, with a
   `userGroupName` and approved, licensed account targets inside each `users` array.
   Provision their personal OneDrives first; missing personal sites can be queued
   [in administrator batches](../../docs/onedrive-setup.md#provision-personal-onedrives).
2. Name the service UAMI in `worker.identity`. For an enabled live service, follow
   [`docs/setup.md`](../../docs/setup.md) as an approved administrator: it creates missing
   named foundation resources/identities and grants `Files.SelectedOperations.Selected` and,
   when selected, `Files.ReadWrite.AppFolder`, all by hand. Then run `npm run setup:ids`,
   which looks up each account's user ID into the gitignored adjacent `.env`
   (`<TENANT>__<TARGET>__USER_ID`); personal-site provisioning and folder grants remain
   separate.
3. [Configure `tenants[].services.onedrive.setup`](../../docs/onedrive-setup.md#plan-apply-and-rerun)
   in the same root config with a separate, explicitly approved provisioning credential
   and `workerClientId`. Run `npm run onedrive:setup` for a read-only plan, then
   `npm run onedrive:setup -- --apply` to create folders and grant **write on each
   dedicated folder** for all configured accounts; neither `npm run setup:ids` nor
   `npm run setup:reply-seeds` does that.
   The folder command requires that `setup` block; the worker never grants itself
   access. It discovers the real drive and folder IDs, writes the verified bindings
   to the same `.env` (`…__DRIVE_ID` and `…__FOLDER_ID`), and safely resumes partial
   runs. No manual per-account IDs or grants are required.
4. [Size the service's concurrency/cycle budget and report TTL](../../docs/onedrive-setup.md#size-the-worker-for-hundreds-of-accounts)
   in its `execution` block.
5. Deploy the updated worker with `execution.mode: "live"` and
   `deployment.enableLiveProbes: true` (hosted workers then receive
   `ENABLE_LIVE_M365=true`); verify real operations, cleanup and accepted reports.

Service block example (`tenants[].services.onedrive`; the address is a placeholder):

```json
{
  "enabled": true,
  "scenarios": {
    "user-drive-roundtrip": true,
    "app-folder-lifecycle": true,
    "document-versions": true
  },
  "targets": {
    "userGroup1": {
      "userGroupName": "User Group One",
      "users": [{
        "userPrincipalName": "dedicated-onedrive@example.invalid",
        "folderName": "AHM-Synthetic-Tests",
        "restoreVersion": false
      }]
    }
  }
}
```

`npm run setup:ids` writes `userId`, and the setup command writes `driveId` and `folderId`
after verifying the folder grant, all to `.env`; leave them out of the config. Deploy and
every TypeScript command fill them in using the account's automatically derived key;
do not supply a target `id`
([generated IDs](../../docs/deployment.md#generated-ids-in-env)).
It supports up to 1,000 selected accounts; runtime concurrency and cycle budgets
remain bounded and must be sized deliberately. Setup credentials are not worker
credentials. The runtime probe does not discover or mutate the drive root.

Missing selected-folder IDs/grants produce actual configuration/permission failure
evidence, never simulated Healthy results or broad discovery. App-folder execution
can resolve `/users/{configured-user}/drive/special/approot` without a drive ID,
but that does not authorize the selected-folder journeys.

## Journeys and exact endpoints

All endpoints use `https://graph.microsoft.com/v1.0`.

| Scenario → test type | Four sequential business actions | Exact operation family |
| --- | --- | --- |
| `user-drive-roundtrip` → `onedrive-roundtrip` | `create-folder-file`, `reopen-file`, `verify-file-hash`, `delete-owned-artifacts` | Verify `GET /drives/{drive}/items/{approvedFolder}`; create a unique subfolder with `POST .../children`; `PUT .../items/{ownedFolder}:/{name}:/content`; enumerate `GET .../{ownedFolder}/children`; download `GET .../{file}/content`; delete owned folder and verify 404. |
| `app-folder-lifecycle` → `onedrive-appfolder` | `write-app-data`, `read-app-data`, `update-app-data`, `delete-app-scratch` | Resolve `GET /users/{user}/drive/special/approot`; create a new correlated child folder; write/read/update/reread/hash `state.json`; delete this cycle's entire owned folder and verify absence. Never deletes approot or relies on state from another cycle. |
| `document-versions` → `onedrive-versions` | `update-document`, `list-versions`, `read-prior-version`, `restore-version` | Write/read revision 1 and revision 2 under the selected folder; `GET .../items/{file}/versions`; download `GET .../versions/{priorVersion}/content` and verify prior bytes. Optional restore writes those verified bytes via `PUT .../content` and rereads them. |

Optional downloaded-byte restoration is **not** native `restoreVersion` semantics.
When `restoreVersion` is false, that action is skipped without a failed request.
Prior-version polling shares the bounded execution budget (initially 120 seconds);
current bytes cannot stand in for actual historical-version evidence.

Each attempt owns a random-correlation folder. Roundtrip/app-folder deletion is a
measured business action; the versions journey deletes its folder in internal
cleanup. Compensating cleanup and token acquisition are not modeled steps.
Cleanup uses an independent bounded signal and verifies exact owned paths/IDs
before deletion. Wrong hashes, malformed ownership, denied operations, missing
history, timeouts and failed cleanup cannot produce successful journeys.
Existing app-folder data, including old test state, remains untouched.

## Scheduling and stable model IDs

The checked-in `execution.executionLanes` use these complete lane assignments:

```json
"executionLanes": [
  { "name": "user-drive", "intervalSeconds": 300, "timeoutSeconds": 120,
    "journeys": ["user-drive-roundtrip"] },
  { "name": "app-folder", "intervalSeconds": 300, "timeoutSeconds": 120,
    "journeys": ["app-folder-lifecycle"] },
  { "name": "versions", "intervalSeconds": 300, "timeoutSeconds": 120,
    "journeys": ["document-versions"] }
]
```

Lanes start immediately and run concurrently. `execution.maxConcurrentProbes`
(default 3, range 1–20) is **per lane**, not a shared Graph-request limit.
`cycleTimeoutSeconds` defaults to 170 per lane; live validation rejects budgets too
small for the selected cohort. Timeouts count as unsuccessful attempts, not Unknown.
Each lane skips missed slots without overlapping itself. See
[capacity and TTL sizing](../../docs/onedrive-setup.md#size-the-worker-for-hundreds-of-accounts).

Keep the deployed root IDs
`onedrive-planned-user-drive-roundtrip`,
`onedrive-planned-app-folder-lifecycle`,
`onedrive-planned-document-versions`, each with existing `step-1`…`step-4` mapping
in the action order above. Their historical names are ingestion compatibility,
not extra planned entities.

## Permission and transport boundaries

[Selected permissions](https://learn.microsoft.com/graph/permissions-selected-overview)
require consent **and** a resource grant. The dedicated folder's grant inherits
to cycle-owned artifacts. Actual version endpoint authorization still requires
live verification; denial is not approval to expand scope.

`Files.ReadWrite.AppFolder` application access is **not tenant-enforced to just
the root-configured users**. The runtime account/drive allowlist is an application
safeguard, not a two-user Entra permission boundary. Optional drive bindings are
checked against approot's returned drive.

Graph-authenticated download requests follow only approved HTTPS
`.sharepoint.com`/`.sharepointonline.com` preauthenticated content redirects,
without forwarding the Graph token. Content size and collection pagination are
bounded. Those hostnames are OneDrive's content transport, not a retained
SharePoint workload.

There is no broad credential/permission fallback or recipient identity substitution.
Optional stable Service Health uses the distinct `OneDriveForBusiness` /
`Microsoft OneDrive` overview and matching issues, never SharePoint status.
Approve `ServiceHealth.Read.All` separately. The tenant's `providerClientId`, inherited
once `serviceHealth` is on, selects the approved provider application through
worker-UAMI federation; setup configures its trust on the existing provider app.
The independent provider lane defaults to 300 seconds and reports only to
suppressed `onedrive-service-health`, without changing synthetic success.
Both root `serviceHealth.enabled` and service
`execution.serviceHealth` must be true for collection. Observed statuses map to
100/50/0 availability; issue counts are diagnostic without thresholds. Unavailable
sources do not refresh health reports. Simulation emits skipped diagnostics, not
observed provider reports. OneDrive beta activity functions are not supported or approved.

From `synthetic-tests/`:

```sh
npm run onedrive -- --once
```

Add `--tenant <alias>` when the config has several tenants. Local live runs need
`ENABLE_LIVE_M365=true` and explicit Graph/report credentials
([identity/permissions](../../docs/deployment.md#identity-and-permissions)); no CLI
credential fallback is used by the worker. The config accepts only the
three supported scenario keys and no removed sharing/search lane assignments.
Simulation is explicitly labeled and previews reports only. For real acceptance,
inspect each account's actions and actual aggregated ingestion;
configuration/deployment success alone is insufficient.
