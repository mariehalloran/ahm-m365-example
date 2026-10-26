# OneDrive API-backed synthetic journeys

One independent Container App runs exactly three real journeys for **every
selected account**, on independent 300-second lanes. Workers keep no cross-cycle
state/outbox; completed attempts report aggregated binary success and measured
journey/action duration directly, with console diagnostics. Root OTEL is optional
and disabled by default.

These tests exercise Graph, not employee sign-in, browser rendering or sync.
Sharing/search/browser prototypes and SharePoint are not selectable.
Source tests do not establish successful live access or ingestion; see
[deployment evidence](../../docs/deployment.md#deployment-status-and-order).

## Primary setup

1. Provision each approved user's OneDrive. An administrator creates the dedicated
   `AHM-Synthetic-Tests` folder and supplies its **real drive ID and folder item ID**.
   The probe does not discover or mutate the drive root.
2. Select the service UAMI explicitly through `AZURE_CLIENT_ID`. Approve
   `Files.SelectedOperations.Selected` with a **write grant on each dedicated
   folder**, and separately `Files.ReadWrite.AppFolder` for app-folder execution.
   The worker never grants itself access or requests broader permissions.
3. Configure selection and account/target metadata only in the private root
   profile. Point `configFile` at the separate live service file.
4. Deploy the health model before the worker, set `mode: "live"` and separately
   `ENABLE_LIVE_M365=true`; verify real operations, cleanup and accepted reports.

Root selection example; placeholders are not live resource IDs:

```json
{
  "enabled": true,
  "configFile": "synthetic-tests/onedrive/config.live.example.json",
  "scenarios": {
    "user-drive-roundtrip": true,
    "app-folder-lifecycle": true,
    "document-versions": true
  },
  "targets": [{
    "id": "onedrive-probe-001",
    "userId": "11111111-1111-4111-8111-111111111111",
    "userPrincipalName": "dedicated-onedrive@example.invalid",
    "driveId": "<approved-drive-id>",
    "folderId": "<dedicated-folder-item-id>",
    "folderName": "AHM-Synthetic-Tests",
    "restoreVersion": false
  }]
}
```

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

Each attempt owns a random-correlation folder. Deliberate deletion is a measured
business action; compensating cleanup/token acquisition remain internal.
Cleanup uses an independent bounded signal and verifies exact owned paths/IDs
before deletion. Wrong hashes, malformed ownership, denied operations, missing
history, timeouts and failed cleanup cannot produce successful journeys.
Existing app-folder data, including old test state, remains untouched.

## Scheduling and stable model IDs

Both service files use these complete lane assignments:

```json
"executionLanes": [
  { "name": "files", "intervalSeconds": 300, "timeoutSeconds": 120,
    "journeys": ["user-drive-roundtrip"] },
  { "name": "appfolder", "intervalSeconds": 300, "timeoutSeconds": 120,
    "journeys": ["app-folder-lifecycle"] },
  { "name": "versions", "intervalSeconds": 300, "timeoutSeconds": 120,
    "journeys": ["document-versions"] }
]
```

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
Approve `ServiceHealth.Read.All` separately. A configured `providerClientId` selects
the approved provider application through worker-UAMI federation; it needs its
own trust for this service identity. The independent provider lane defaults to
300 seconds and reports only to suppressed `onedrive-service-health`, without
changing synthetic success. Simulation keeps `serviceHealth: false`; the live
example enables it. OneDrive beta activity functions are not supported or approved.

From `synthetic-tests/`:

```sh
npm run onedrive -- --once
npm run onedrive -- --project-config /approved/path/monitoring.private.json --once
```

Private profiles require all three supported scenario keys and no removed
sharing/search lane assignments. Simulation is explicitly labeled and previews
reports only. For real acceptance, inspect each account's actions and actual
aggregated ingestion; configuration/deployment success alone is insufficient.
