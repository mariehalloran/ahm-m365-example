# OneDrive API-backed synthetic journeys

One independent Azure Container App runs three concurrent, stateless execution
lanes, initially every **300 seconds**. Every selected account is attempted; one
account's failure does not substitute for another's evidence. Journeys publish
aggregated binary success and elapsed business-action/journey duration directly to
their service health model. Optional root-configured OTEL stays off by default.

These are real Graph file operations in `live` mode, not browser, sync-client,
employee sign-in, recipient receipt, or cross-account access tests. Simulation is
explicitly labeled and only previews reports.

## Primary setup

1. Provision the approved test users' OneDrives. An administrator discovers each
   account's real object/drive IDs and creates a dedicated `AHM-Synthetic-Tests`
   folder. Record its item ID; the probe never discovers or mutates the drive root.
2. Use the service's explicitly selected UAMI. Approve **only**
   `Files.SelectedOperations.Selected` plus a **write** resource grant on each
   dedicated folder, and `Files.ReadWrite.AppFolder` for the separate app-folder
   lane. The worker does not grant its own permissions or require directory-read
   permissions.
3. Add the accounts and scenarios to the active private **root** configuration.
   Select a reviewed copy of [config.live.example.json](./config.live.example.json)
   using `configFile`; do not duplicate accounts or scenario switches there.
4. Deploy the health model first, then the [shared worker infrastructure](../infra/README.md).
   Hosted execution independently requires `ENABLE_LIVE_M365=true`. Verify actual
   Graph outcomes **and ingested health reports**, not deployment success alone.

From `synthetic-tests/`:

```sh
npm run onedrive -- --once
npm run onedrive -- --project-config /approved/path/monitoring.private.json --once
```

Root selection example (placeholders are not live resource IDs):

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
    "driveId": "<administrator-discovered-drive-id>",
    "folderId": "<approved-dedicated-folder-item-id>",
    "folderName": "AHM-Synthetic-Tests",
    "restoreVersion": false
  }]
}
```

`driveId`/`folderId` can be omitted while provisioning is incomplete. App-folder
resolution uses the configured user ID directly, without reading drive-root metadata.
Selected-folder journeys still attempt authentication and report missing IDs as
**Unhealthy configuration evidence**, never simulated success. Missing/provisioning
OneDrives, denied scopes/grants, unavailable versions, mismatched bytes and deadlines
also fail observably. No broader-permission or credential fallback is attempted.
Older root profiles without `services.onedrive` remain disabled, not auto-enabled.
The checked-in root selects both safe `.invalid` sample accounts and all three
families in simulation; SharePoint is explicitly disabled.

## Implemented workflows and exact Graph v1.0 APIs

| Scenario | Completed business workflow | APIs |
| --- | --- | --- |
| `user-drive-roundtrip` | Verify approved folder, create uniquely correlated nested folder/file, enumerate and download the file, compare SHA-256 of exact bytes, delete owned folder and confirm absence | `GET /drives/{drive}/items/{folder}`; `POST .../items/{folder}/children`; `PUT .../items/{owned-folder}:/{name}:/content`; `GET .../items/{owned-folder}/children`; `GET .../items/{file}/content`; `DELETE .../items/{owned-folder}`; `GET` readback must return 404 |
| `app-folder-lifecycle` | Resolve this application's approot for the configured user, create/reopen its dedicated test subfolder, verify any previous state, write/read/update/reread state, delete only this run's scratch file | `GET /users/{user-id}/drive/special/approot`; subsequent item metadata/children/content operations under that returned app folder; `DELETE` and 404 readback only for the correlated scratch file |
| `document-versions` | Write/read revision 1, update/read revision 2, enumerate actual history, download and hash-verify revision 1; optional `restoreVersion` writes those verified prior bytes back and rereads them | Dedicated-folder/file APIs above; `GET /drives/{drive}/items/{file}/versions`; `GET .../versions/{version}/content`; optional restore uses `PUT .../items/{owned-folder}:/{name}:/content`, **not** a claim of native restoreVersion semantics |

Files contain small correlated JSON with a content hash. Each non-appfolder
attempt owns one random-correlation folder under the approved folder and deletes
only verified owned IDs; ambiguous responses resolve only that exact owned path.
Deliberate roundtrip deletion/scratch deletion are reported business actions;
generic compensating cleanup and token acquisition remain internal.

App-folder state intentionally persists in
`approot/<folderName>-<target.id>/state.json`; workers retain no local history.
Each cycle verifies prior state before overwriting it. Only the application's
recognized test payload is overwritten, not arbitrary user data. A first cycle
proves same-cycle readback, not historical persistence; a later successful cycle
also verifies the previously stored state. Never delete approot, its parent,
another target's subfolder, or the persistent state as generic cleanup.

Versioning depends on actual OneDrive retention/settings. Polling is bounded by
the configured timeout and respects cancellation. Empty history or no matching
earlier bytes cannot pass; current content is not relabeled a historical version.
Graph lists newest/current first and doesn't support downloading current content
through the versions endpoint. The optional restore step is skipped/Unknown when
disabled, not counted as a failed or successful request.
When no configured account selects restore, its existing child entity is
impact-suppressed so the intentionally Unknown optional step cannot block normal
version-journey rollup.

## Authentication and the actual permission boundary

Hosted Graph defaults to app-only `ManagedIdentityCredential` with the explicitly
selected `AZURE_CLIENT_ID`. The dedicated identity is
`uami-<healthModel.name>-onedrive`; the independent worker shares the existing
Container Apps environment and registry. Reporting uses its separate ARM audience
and ingest-only role. The standard explicit `graphAuthentication: certificate`
option supports approved local development; there is no delegated user sign-in,
refresh-token bootstrap or silent fallback.

Microsoft's [Selected permissions documentation][selected] describes both Entra
consent and the explicit resource assignment. A selected folder write grant
inherits to its contained probe artifacts; granting a folder can break permission
inheritance and consumes a unique security scope. The worker never requests
`Files.ReadWrite.All`, `Sites.ReadWrite.All`, or tenant-wide file read permission.

**`Files.ReadWrite.AppFolder` application permission is not restricted to the two
configured accounts in Entra.** It authorizes this application's app folder in
other users' drives too, and app-folder access includes files users place there.
The runtime checks account/drive/folder bindings against the root allowlist and
only addresses configured user IDs; this is an application safeguard, **not a
tenant-enforced two-user grant**. For an account without a configured drive ID,
the approot API response resolves the drive only for that approved user. When a
drive ID is supplied, it must match the returned app-folder drive.

The generic versions API permission tables list broad application permissions;
the [Selected scope resource rules][selected] describe narrower item access.
Live acceptance must verify those version operations under the approved folder
grant; denial remains unhealthy and does not justify expanding scope.
See Microsoft's [app-folder guidance][appfolder], [versions][versions] and
[version-content API][version-content].

## Explicitly planned / blocked coverage

| Family | Why it is not implemented/selectable |
| --- | --- |
| Search/retrieve | [Graph driveItem search][search] documents application `Files.Read.All` or higher and explicitly excludes `Sites.Selected`; it does not document compatibility with the approved file-selected/AppFolder permissions. No tenant-wide search scope is approved. Folder enumeration is **not** search/indexing evidence. |
| Recipient sharing | The current app-only owner identity is not an independent recipient credential. No recipient access/revocation evidence is fabricated with the owner's token. |
| Browser upload/reopen | No browser identity/session automation is approved or implemented. API success does not prove the OneDrive UI or sync experience. |

There is **no OneDrive Service Health or beta activity collector** in this worker.
Configuration rejects enabled provider collection rather than aliasing a
SharePoint provider name. Its model retains suppressed supporting context without
invented provider calls.

## Model, scheduling and acceptance

Promoted roots retain their already-deployed IDs:
`onedrive-planned-user-drive-roundtrip`, `onedrive-planned-app-folder-lifecycle`,
`onedrive-planned-document-versions`. The `-planned-` substring is historical;
active metadata makes them normal UserFlow roots with External Reports and
standard rollup. Existing `step-1` through `step-4` child IDs are preserved, with
semantic action names mapped to those IDs. Other families remain Unknown and
suppressed. De-duplication prevents active/planned copies of one entity.

All three default lanes have independently configurable 300-second cadence and
120-second timeout. The reusable runner executes account attempts concurrently,
then aggregates settled outcomes; timeouts are failures/Unhealthy. Skipped
prerequisites and disabled restore steps do not enter the failure denominator.
Reports contain no per-account signal inventory.

Run `npm test -- onedrive/tests`, `npm run typecheck`, and `npm run build`.
Tests exercise real handler shapes with mocked Graph responses, permission/
provisioning failures, incorrect hashes, unavailable history, safe cleanup,
cross-cycle app-folder state, runtime allowlists, report IDs and timeout mapping.
They are not live service acceptance. Follow [operational acceptance][operations]
for independently detecting stalled workers/stale reports, broken report transport,
and end-to-end notifications. A running container alone is insufficient.

### Recorded live trial: 2026-10-26

Both approved accounts completed the app-folder workflow on consecutive
five-minute cycles: persisted state was reopened/validated, updated/reread and
scratch deletion verified. Actual journey/action health reports were ingested;
app-folder success was 100%. This does not establish selected-folder access.
The selected-folder roundtrip and versions scenarios remain enabled but report
Unhealthy configuration evidence until their dedicated folders and resource
write grants exist. Unexecuted business actions remain skipped/Unknown.
The existing administrator CLI token has no file/site scopes, so it cannot
bootstrap those folders/grants. No broad permissions or delegated sign-in were
added to work around that boundary. Search/sharing/browser coverage remains planned.

[selected]: https://learn.microsoft.com/en-us/graph/permissions-selected-overview
[appfolder]: https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder
[versions]: https://learn.microsoft.com/en-us/graph/api/driveitem-list-versions?view=graph-rest-1.0
[version-content]: https://learn.microsoft.com/en-us/graph/api/driveitemversion-get-contents?view=graph-rest-1.0
[search]: https://learn.microsoft.com/en-us/graph/api/driveitem-search?view=graph-rest-1.0
[operations]: ../../docs/operations.md#enterprise-reliability-acceptance-gate
