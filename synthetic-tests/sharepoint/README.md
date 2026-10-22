# SharePoint journey and endpoint plan

**Journey:** save a small document to an approved library folder, reopen it, verify the same content, and remove the test file.

**Status:** the [journey](./src/journey.ts) orchestrates separately reusable [actions](./src/steps.ts): `authenticate`, `verifyDrive`, `uploadFile`, `readFile`, `cleanup`. It has not been validated against an approved live tenant. The checked-in [config](./config.json) uses simulation, so it performs none of these network calls.

Journey `save-reopen-file` has `verify-drive`, `upload-file`, and `read-file` child entities beneath `sharepoint-global`. The second journey, `rename-reopen-file`, adds `rename-file` before `read-file` beneath separate entity `sharepoint-rename`. Step IDs are journey-scoped; each journey/step always receives direct success/duration reports in **External Reports**, independently of optional Azure OTEL query signals. Token acquisition and cleanup remain internal, without entities or published step data. Failed prerequisites block later operations; skipped actions have no success/duration sample. Attempted uploads still receive independent bounded cleanup, including after cancellation.

The [rename journey](./src/rename-journey.ts) uses [rename/readback operations](./src/rename-steps.ts) to update only its newly created file, verify the returned item ID/name, then reopen and check its renamed metadata and original content. Both root scenarios default enabled and share this worker, site-scoped write permission and cadence.

[HTTP tests](./tests/probe.test.ts) cover both the journey and direct action calls.

## Optional Microsoft-reported context

[sharepointProviders](./src/providers.ts) optionally reads stable `/v1.0/admin/serviceAnnouncement/healthOverviews` and `/issues`, once per cycle in the same process—not per site/target or journey. Simulation keeps `serviceHealth: false`; the live example enables it independently of journey initialization. It requires separate `ServiceHealth.Read.All` admin consent and exact subscribed service name `SharePoint Online`. Overview status reports directly to `sharepoint-service-health` as `microsoft-reported-service-status`: 100 healthy, 50 degraded, 0 interruption, with `impactSuppressed`. Failed/missing/unknown overview status reports Unknown without a value and with failure context. The existing trial receives Graph 403 pending consent. Issue/history records do not supply journey health, and source failures never change successful file-operation 1/0.

**There is no verified SharePoint-specific serviceActivity beta function.** `serviceActivity.enabled: true` or any nonempty function list is rejected before credentials/mutations; an OfficeApps report is not silently relabeled as SharePoint. Simulation skips configured stable sources without credentials/network or fabricated Microsoft health. Nothing grants access automatically.

See the [strict config, independent source bounds, truncation and console diagnostics](../utils/README.md#optional-provider-collectors) and [collector tests](../utils/tests/providers.test.ts). References: [health overviews](https://learn.microsoft.com/graph/api/serviceannouncement-list-healthoverviews?view=graph-rest-1.0), [issues](https://learn.microsoft.com/graph/api/serviceannouncement-list-issues?view=graph-rest-1.0), [beta serviceActivity catalog](https://learn.microsoft.com/graph/api/resources/serviceactivity?view=graph-rest-beta).

## Resources prepared once

The SharePoint administrator supplies a dedicated site, document library (`driveId`), existing folder (`folderId`), and approved test identity. Store those IDs as configuration; do not create a new site/library on each cycle.

Site/library discovery can happen during setup:

```http
GET https://graph.microsoft.com/v1.0/sites/{hostname}:/{server-relative-site-path}
GET https://graph.microsoft.com/v1.0/sites/{siteId}/drives
```

These discovery operations may need separate administrator authorization. Do not broaden the runtime identity to discover every site. The worker receives the approved IDs.

## API sequence per run

All relative paths use `https://graph.microsoft.com/v1.0`. Each run generates an unguessable filename such as `ahm-synthetic-{correlationId}.txt`, containing only that correlation ID.

| Step | Method and endpoint | Required verification |
| --- | --- | --- |
| 1. Confirm the library belongs to the site | `GET /sites/{siteId}/drives?$select=id` | The configured `driveId` is in the approved site's drives; otherwise stop before uploading |
| 2. Save the file | `PUT /drives/{driveId}/items/{folderId}:/{fileName}:/content` | Returned file ID is nonempty and filename matches this run |
| Rename owned file (rename journey only) | `PATCH /drives/{driveId}/items/{itemId}` | Change only this run's known file to another unique name; verify returned ID/name |
| Verify renamed metadata (rename journey only) | `GET /drives/{driveId}/items/{itemId}` | The owned item ID and new filename must match before content readback |
| 3. Reopen the saved file | `GET /drives/{driveId}/items/{itemId}/content` | Graph returns a short-lived preauthenticated download redirect |
| 4. Read and verify content | `GET {preauthenticatedDownloadUrl}` | Follow the approved HTTPS SharePoint URL without a Graph Authorization header; verify the exact correlation-only JSON payload |
| 5. Clean up by known ID | `DELETE /drives/{driveId}/items/{itemId}` | Delete only the file created by this run |
| 5a. Cleanup fallback after ambiguous upload | `DELETE /drives/{driveId}/items/{folderId}:/{fileName}` | If no ID was returned, target only this exact run's generated path; an already absent file is acceptable |

The worker URL-encodes identifiers, limits download size, and permits only the configured public-cloud SharePoint hostname suffixes for redirects. It never forwards a Graph token to a download URL.

The file has a `.txt` suffix but contains synthetic JSON, not a real Office document. Verifying it proves file persistence/readback, not Word/Excel parsing or rendering.

## Authentication and permissions

Use an application identity with:

- Microsoft Graph **`Sites.Selected` application permission**.
- An explicit **`write` role grant on only the dedicated site**. The role permits the readback and file mutations needed here.
- An approved same-tenant user-assigned managed identity for hosted Graph. `graphAuthentication` defaults to `managed-identity`; the explicit UUID `AZURE_CLIENT_ID` selects only that identity, without CLI/default/certificate fallback.
- For local live development only, opt into `graphAuthentication: "certificate"` with `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_CERTIFICATE_PATH`.

No `Sites.ReadWrite.All`, directory-wide discovery, real-user document access, or library-wide deletion is requested. The explicit site grant is an administrator setup action, not part of the periodic journey.

A future folder/file-selected permission may narrow access further, but it cannot be substituted without changing the site's drive-enumeration check. Permissions must match the operations actually performed.

## Measurements

Each published run includes total attempt duration through cleanup, success/failure and diagnostic category. Authentication duration and cleanup status stay internal. Each attempt contributes one binary success observation (1 or 0) to cycle aggregation.

**Implemented phase measurements:** `uploadDurationMs` measures upload request/response validation; `readDurationMs` measures download/readback verification. Console observations retain each attempted phase's timing even if it fails, separate from total duration.

An accepted upload alone is not success: downloaded bytes must match the unique payload. Failed cleanup makes the overall test fail. Download or identity failures are explicit. The [root config](../../monitoring.config.json) selects both journeys and site/drive/folder targets; the shared worker aggregates each complete cycle and publishes health reports directly to separate journey/business-step entities in the SharePoint model. Reports replace cycle aggregates rather than providing a full metrics store or percentiles. See [report semantics](../utils/README.md#per-cycle-health-reports).

## Second-stage journey: writer and independent reader

If the goal is “someone else can access the saved document,” extend the test:

1. Writer identity A uses the existing upload endpoint.
2. Observer identity B calls `GET /drives/{driveId}/items/{itemId}/content` using its own Graph token and follows its own redirect.
3. B verifies the content; A deletes the item.

An independent application with `Sites.Selected` plus an explicit **read** role on the site tests a second application's access path. It does **not** prove an employee's access, MFA, sharing invitation, or UI experience. Testing a real employee requires that approved user's delegated context or browser flow.

Do not call `createLink` and then verify with the already privileged writer: that would not prove the intended recipient can open a sharing link. A sharing/Office coauthoring journey needs a separate access model and success check.

This two-identity path is **not implemented** in the current config/handler.

## Acceptance and cleanup

- Prove one allowed upload/read/verify/delete against the approved live site.
- Confirm an unauthorized site/drive is rejected before mutation.
- Test corrupted readback, download redirect rejection, timeout, ambiguous upload, and cleanup failure.
- Validate separate aggregated journey/business-step health reports, console phase timings, and suppressed provider status.
- Agree on retention and recycle-bin handling; normal deletion is not permanent purge.
- Enable the independent cadence only after downstream missing-result notifications and ownership are established.

## Run the existing safe example

Run from the `synthetic-tests/` project directory:

```sh
npm run sharepoint -- --once
# Compiled equivalent after npm run build:
node dist/sharepoint/src/worker.js --once
```

The root configuration selects the service file (by default `sharepoint/config.json`), targets and report policy. `--config <file>` overrides only service-specific settings; duplicate root-owned keys are rejected. Other service types are rejected before credentials or operations. See [operations](../../docs/operations.md) for live opt-in, credential protection, independent worker/report monitoring, and notification requirements.

To prepare live access, copy the [live settings example](./config.live.example.json) to a private config location and select it through root `services.sharepoint.configFile`. Put approved site/drive/folder IDs only in root targets, select the approved Graph identity, and set the live environment gate only after authorization checks. The example config neither creates resources nor grants permissions. Simulation remains local previews only, never simulated cloud health.

## Microsoft references

- [Locate an approved site by path](https://learn.microsoft.com/en-us/graph/api/site-getbypath?view=graph-rest-1.0)
- [List drives](https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0)
- [Upload small-file content](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0)
- [Download content and follow its preauthenticated redirect](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)
- [Delete a file](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0)
- [Selected permissions and explicit resource grants](https://learn.microsoft.com/en-us/graph/permissions-selected-overview)
