# SharePoint journey and endpoint plan

**Journey:** save a small document to an approved library folder, reopen it, verify the same content, and remove the test file.

**Status:** the [current handler](./src/probe.ts) implements this API-backed journey. It has not been validated against an approved live tenant. The checked-in [config](./config.json) uses simulation, so it performs none of these network calls.

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
- Certificate-backed local authentication or a separately approved hosted identity design.

No `Sites.ReadWrite.All`, directory-wide discovery, real-user document access, or library-wide deletion is requested. The explicit site grant is an administrator setup action, not part of the periodic journey.

A future folder/file-selected permission may narrow access further, but it cannot be substituted without changing the site's drive-enumeration check. Permissions must match the operations actually performed.

## Measurements

**Existing:** total attempt duration through cleanup, authentication duration, success/failure, diagnostic category, and cleanup status. Each run produces a result log and OTel total-duration/outcome measurements.

**Planned refinement:** separately measure upload and verified-readback phases, in addition to total duration. Mark these as new measurement fields/instruments when implemented; do not present total duration as isolated download time today.

An accepted upload alone is not success: downloaded bytes must match the unique payload. Failed cleanup makes the overall test fail. Download or identity failures are reported explicitly; no local health threshold or state is evaluated.

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
- Validate durations and per-run telemetry in Log Analytics.
- Agree on retention and recycle-bin handling; normal deletion is not permanent purge.
- Enable the independent cadence only after downstream missing-result notifications and ownership are established.

## Run the existing safe example

```sh
npm run probe -- --config probes/sharepoint/config.json --once
```

See [operations](../../docs/operations.md) for live opt-in, credential protection, telemetry, and monitoring requirements.

## Microsoft references

- [Locate an approved site by path](https://learn.microsoft.com/en-us/graph/api/site-getbypath?view=graph-rest-1.0)
- [List drives](https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0)
- [Upload small-file content](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0)
- [Download content and follow its preauthenticated redirect](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)
- [Delete a file](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0)
- [Selected permissions and explicit resource grants](https://learn.microsoft.com/en-us/graph/permissions-selected-overview)
