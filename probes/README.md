# Synthetic user journeys

Start with **what an employee is trying to do**, then choose the operations that demonstrate it. An HTTP success response or an available Graph endpoint is not by itself proof of a completed journey.

These probes are **API-backed journeys**, not browser or desktop automation. They do not sign into Outlook/Teams as an employee, render a page, establish media, or exercise the employee's office network. Do not label API coverage as a complete end-user experience.

## Journey catalog

| Employee goal | Current probe | Coverage and next step |
| --- | --- | --- |
| Send email and have it arrive | [Exchange mail flow](./exchange/README.md) | Implemented: one mailbox sends to itself and confirms Inbox delivery. A distinct sender/recipient journey is a future extension. |
| Publish a Teams message and observe it in the channel | [Teams endpoint plan](./teams/README.md) | Not implemented. Proposed bot post + team-scoped Graph readback + bot-owned cleanup; not proof a human recipient saw it. |
| Save a document and reopen the same content | [SharePoint file readback](./sharepoint/README.md) | Implemented: upload/download/verify in one dedicated library folder. Sharing with another user and coauthoring are not tested. |

The checked-in configs default to simulation/console output. Simulation performs none of the network operations below; it only produces clearly labeled sample measurements.

## Exchange: send and confirm email arrival

**User question:** “Can an email be submitted and delivered to an Inbox, and how long does that take?”

**Implemented sequence:** authenticate -> create a uniquely tagged draft -> send it to the same test mailbox -> poll that mailbox's Inbox -> confirm the matching message -> clean up only this run's copies.

All paths below are relative to `https://graph.microsoft.com/v1.0`.

| Step | HTTP method and endpoint | What is verified |
| --- | --- | --- |
| Create the test message | `POST /users/{mailbox}/messages` | A draft with fixed synthetic content, the UUID-containing subject, and the approved test mailbox as recipient |
| Submit the draft | `POST /users/{mailbox}/messages/{draftId}/send` | Graph accepts the send; this alone is **not** delivery confirmation |
| Observe delivery | `GET /users/{mailbox}/mailFolders/inbox/messages?$filter=subject eq '{uniqueSubject}'&$select=id&$top=100` | The exact correlated message appears in the Inbox |
| Find this run's remaining copies | `GET /users/{mailbox}/messages?$filter=subject eq '{uniqueSubject}'&$select=id&$top=100` | Known/correlated draft, sent, or received copies that need cleanup |
| Clean up | `DELETE /users/{mailbox}/messages/{messageId}` | Only IDs owned by this test are deleted |

The code URL-encodes identifiers and query parameters. Placeholders above are explanatory, not literal URLs to paste.

**Measurements:** overall success, total duration through cleanup, confirmed-delivery duration from send initiation to first matching Inbox observation, authentication duration, diagnostic category, and cleanup status. Delivery duration includes send-request/polling delay; it is not exact transport latency.

**Permissions:** Exchange `Application Mail.ReadWrite` and `Application Mail.Send`, resource-scoped to the dedicated mailbox through Exchange RBAC for Applications. These are not a request for tenant-wide Entra mail grants. See the [administrator handoff](../MAILBOX-SYNTHETIC-ACCESS.md).

**What is not proven:** delivery between different employees, external mail flow, Outlook sign-in/rendering, attachments, mobile clients, or tenant-wide availability. A second approved sender/recipient pair requires code/config changes and scoped authorization to both resources; the current config does not support it.

**Code:** [Exchange journey](./exchange/src/probe.ts), [config](./exchange/config.json), and [journey tests](./exchange/tests/probe.test.ts).

## Teams: send and observe a message

**User question:** “Can a message be published and observed in an approved channel, and how long does that take?”

**Status: not implemented.** The [concrete Teams endpoint plan](./teams/README.md) recommends bot-backed publication, team-scoped Graph readback, and deletion of only the bot's own activity. The config remains disabled. Reading team/channel metadata would only be API context, not this user journey.

The employee/delegated Graph alternative uses the endpoints below, but is **not the selected unattended implementation**:

| Step | Candidate Graph endpoint | Required design decision |
| --- | --- | --- |
| Send a correlated message | `POST /teams/{teamId}/channels/{channelId}/messages` | Supported normal messaging identity, not a migration/import identity |
| Observe the created message | `GET /teams/{teamId}/channels/{channelId}/messages/{messageId}` | An approved receiving-side access context; reading back the sender's own object does not establish recipient experience |
| Clean up the test message | `POST /teams/{teamId}/channels/{channelId}/messages/{messageId}/softDelete` | Supported author/identity permissions and retention behavior |

For a chat, sending uses `POST /chats/{chatId}/messages` instead. Chat and channel permissions/cleanup are different; choose one explicit journey rather than mixing them.

**Unattended identity needs explicit design, not just managed identity.** The normal Graph channel-send API documents delegated `ChannelMessage.Send` and migration-only application permission. The separate RSC catalog lists `ChannelMessage.Send.Group`, but that alone does not validate a generally available send/read/delete journey; Graph channel `softDelete` still documents no application support. Do not request `Teamwork.Migrate.All` or weaken sign-in controls.

The planned bot path uses Bot Connector create/delete operations and Graph `ChannelMessage.Read.Group` for observation. It needs approved bot registration, installation, and callback/bootstrap handling; none is implemented. Bot channel readback must not be called human-to-human delivery or a recipient read receipt.

Even a completed API-backed message journey would not prove the Teams UI displayed it, notifications arrived, or calls/meetings/media work. Those require separate representative tests and endpoints.

See the [Teams boundary and config](./teams/README.md) before requesting resources or permissions.

## SharePoint: save and reopen a document

**User question:** “Can a small document be saved to the approved library and read back unchanged?”

**Implemented sequence:** authenticate -> verify the drive belongs to the approved site -> upload a uniquely named file -> download it -> verify its exact correlation-only content -> delete it.

| Step | HTTP method and endpoint | What is verified |
| --- | --- | --- |
| Verify the approved library | `GET /sites/{siteId}/drives?$select=id` | The configured drive belongs to the approved site |
| Save the synthetic document | `PUT /drives/{driveId}/items/{folderId}:/{uniqueFileName}:/content` | Upload returns the expected uniquely named file |
| Reopen the document | `GET /drives/{driveId}/items/{itemId}/content` | Graph returns a short-lived download redirect |
| Read the content | `GET {preauthenticatedDownloadUrl}` | The file contains this run's exact correlation payload; the Graph bearer token is **not** forwarded |
| Clean up | `DELETE /drives/{driveId}/items/{itemId}` | The known uploaded file is deleted |
| Clean up after an ambiguous upload | `DELETE /drives/{driveId}/items/{folderId}:/{uniqueFileName}` | Only this run's exact generated path is targeted if no file ID was returned |

The download implementation accepts only approved HTTPS SharePoint hostname suffixes and bounds response size. It is not a general-purpose arbitrary-URL downloader.

**Measurements:** overall success, total duration through cleanup, authentication duration, diagnostic category, and cleanup status. No separate document-sharing/coauthoring latency is measured.

**Permissions:** `Sites.Selected` plus an explicit write grant on the approved dedicated site. The current implementation enumerates that site's drives. A narrower folder-only grant would need changes to this validation step.

**What is not proven:** another user's access, sharing links, browser rendering, OneDrive desktop synchronization, coauthoring, or a personal OneDrive journey. Similar file APIs do not automatically make those scenarios covered.

**Code:** [SharePoint journey](./sharepoint/src/probe.ts), [config](./sharepoint/config.json), and [journey tests](./sharepoint/tests/probe.test.ts).

## Common execution and reporting

- [The runner](../runner/src/runner.ts) executes a bounded set of operations, validates each result, and sends it to embedded OTel. It does not choose a health state or keep history.
- [The Graph client](../shared/src/graph.ts) owns the Graph base URL, authenticated requests, and safe download handling.
- The Azure Identity library obtains application tokens from the mailbox/site tenant's Entra token endpoint, `POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`. Token caching is handled by the SDK; this is not a test of employee sign-in or MFA.
- Application Insights ingestion is a **reporting dependency**, not a Microsoft 365 journey endpoint. The SDK uses the configured regional ingestion destination.
- [Telemetry definitions and KQL](../telemetry/README.md) distinguish total duration, confirmed delivery, cleanup failure, and unexecutable attempts. Success percentages and latency analysis run downstream.

Create permanent mailbox/site/team resources through approved administrator setup, not inside every test. Cleanup removes only per-run artifacts, respects retention, and is not a blanket purge.

## Microsoft endpoint references

- [Create a draft message](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0)
- [Send an existing draft](https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0)
- [List mailbox messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
- [Delete a message](https://learn.microsoft.com/en-us/graph/api/message-delete?view=graph-rest-1.0)
- [Send a Teams message and permission restrictions](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0)
- [Get a Teams message](https://learn.microsoft.com/en-us/graph/api/chatmessage-get?view=graph-rest-1.0)
- [Soft-delete a Teams message](https://learn.microsoft.com/en-us/graph/api/chatmessage-softdelete?view=graph-rest-1.0)
- [List a site's drives](https://learn.microsoft.com/en-us/graph/api/drive-list?view=graph-rest-1.0)
- [Upload a small file](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0)
- [Download a file and follow its preauthenticated redirect](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)
- [Delete a drive item](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0)
