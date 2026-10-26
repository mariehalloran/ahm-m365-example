# Exchange: completed mail and calendar journeys

One Exchange worker runs six independent API-backed journey families. Business steps remain sequential within an attempt; targets and journeys run concurrently (three attempts per lane). Nothing measures Outlook UI, employee sign-in/MFA, external delivery, or tenant-wide availability.

**Implementation versus live evidence:** all six core journeys below are implemented.
Mail, draft, attachment/hash/correlated reply and distribution-list fanout have been
verified Healthy live. Recurring calendar and meeting invitation currently receive
403, blocked by scoped-authorization cache propagation; they are implemented, not
live-successful. See [recorded acceptance](../../docs/deployment.md#deployment-status-and-order)
for execution and report-ingestion evidence.

## Primary setup

1. Select journeys and approved participants **only in the root project config**. The checked-in root selects all six; its `.invalid` addresses are simulation placeholders, not live resources.
2. Approve dedicated, licensed mailboxes and scope `Application Mail.Send`, `Application Mail.ReadWrite`, and (for calendar journeys) `Application Calendars.ReadWrite` through Exchange RBAC for Applications to just those participants. Verify both allowed participants and a denied control mailbox. Do not add tenant-wide Entra mail/calendar grants.
3. Set service `mode: "live"`, explicitly selected managed identity, live consent `ENABLE_LIVE_M365=true`, approved model destination, and deploy models before workers. See [access request](../../MAILBOX-SYNTHETIC-ACCESS.md), [identity details](../../docs/cross-tenant-access.md), and [deployment](../../docs/deployment.md).
4. Run `npm run exchange -- --once --project-config /absolute/path/monitoring.private.json` from `synthetic-tests/`; verify actual journey execution **and accepted health ingestion**.

Root Exchange target shape (repeat the object for additional independent target sets):

```json
{
  "id": "exchange-pair-001",
  "mailbox": "sender@example.invalid",
  "recipientMailbox": "recipient@example.invalid",
  "distributionList": {
    "address": "synthetic-list@example.invalid",
    "expectedRecipients": ["sender@example.invalid", "recipient@example.invalid"]
  }
}
```

`mailbox` is A; `recipientMailbox` is B. Attachment/reply and meeting journeys require distinct explicit A/B participants. Distribution-list delivery verifies **every** listed expected recipient; it does not discover members or infer tenant accounts. Recurring events and drafts use A. Each selected journey runs for every configured target; do not duplicate a group/participant set unless duplicate traffic is intended.

Older root profiles omitting the four new scenario keys keep those journeys disabled for compatibility. The checked-in root explicitly selects all six. Selected live journeys with missing prerequisites report observed `configuration-failure`/Unhealthy, never simulation or an invented A→A flow. The original mail journey alone retains its single-mailbox self-delivery fallback when B is omitted.

## Journeys and scheduling

| Root scenario | Journey entity | Sequential business steps | Default cadence |
| --- | --- | --- | --- |
| `send-receive-mail` | `exchange-global` | Create mail, send A→B, verify actual B Inbox delivery | 60 seconds |
| `edit-reopen-draft` | `exchange-draft` | Create, initial read, update, reopen/verify, delete owned draft | 300 seconds |
| `attachment-reply-mail` | `exchange-attachment` | Send attachment A→B, verify downloaded SHA-256, reply B→A, verify transport reply headers/sender/body marker | 300 seconds |
| `distribution-list-mail` | `exchange-distribution` | Send to explicit list, verify every expected Inbox | 300 seconds |
| `recurring-calendar` | `exchange-recurring` | Create daily series, read occurrence, update series, verify series/occurrence, delete series | 300 seconds |
| `meeting-invitation` | `exchange-meeting` | Create invitation, B receives, verify B calendar by iCalUId, B accepts, A observes accepted attendee, A cancels | 300 seconds |

The 60-second mail flow stays simple: no attachment or reply is required. Draft
deletion may be disabled explicitly for trial retention as described below.
An optional seventh **mailbox search/organize** journey, external inbound/outbound
variants and an **OutlookWeb browser** variant are planned, not implemented.
They are not additional enabled root scenarios or part of current live acceptance.

Service-owned optional settings:

```json
"executionLanes": [
  { "name": "mail", "intervalSeconds": 60, "timeoutSeconds": 45, "journeys": ["send-receive-mail"] },
  { "name": "extended", "intervalSeconds": 300, "timeoutSeconds": 120,
    "journeys": ["edit-reopen-draft", "attachment-reply-mail", "distribution-list-mail", "recurring-calendar", "meeting-invitation"] }
]
```

Explicit lane settings must assign every supported service journey exactly once, even when disabled at the root. Without them, `mail` inherits legacy service `intervalSeconds`/`timeoutSeconds` (checked-in 60/45); `extended` uses 300 seconds and the legacy timeout. Both start immediately. Slow extended execution/reporting cannot block mail. A lane never overlaps itself; missed slots emit `service-slots-skipped` with lane, first slot, and count, without catch-up bursts. `--once` settles both selected lanes before exiting.

Execution deadlines cancel work; cleanup gets ten seconds (runner settlement grace twelve seconds). Completed/deadline results aggregate and publish only their observed journeys, never empty reports for another lane. A timeout is success **0**, counted in the denominator and reported Unhealthy; dependent unexecuted steps remain skipped, not failed requests. Internal cycle deadline is 170 seconds; queued attempts cancelled by that deadline still produce failed journey results. External shutdown does not start queued attempts. Reports contain no per-target signal inventories or persisted cycle history.

## Exact Graph operations

All endpoints use `https://graph.microsoft.com/v1.0`; mailbox and artifact IDs/query parameters are encoded.

| Operation | Endpoint |
| --- | --- |
| Create mail/draft/attachment mail | `POST /users/{A}/messages` (UUID subject/header; attachment is a small `fileAttachment`) |
| Initial read and reopen draft | `GET /users/{A}/messages/{ownedDraftId}?$select=id,subject,bodyPreview,isDraft` |
| Edit/delete draft | `PATCH`, `DELETE /users/{A}/messages/{ownedDraftId}` |
| Send draft/mail | `POST /users/{A}/messages/{ownedDraftId}/send` |
| Recipient delivery | `GET /users/{recipient}/mailFolders/inbox/messages?$filter=subject eq '{UUID-subject}'` |
| Attachment metadata/content | `GET /users/{B}/messages/{receivedId}/attachments`, then `GET .../attachments/{attachmentId}`; decoded bytes must match SHA-256 |
| Correlated reply | `POST /users/{B}/messages/{receivedId}/createReply`; `PATCH` owned reply body without changing its inherited subject/conversation; `POST .../{replyId}/send`; explicitly select `internetMessageHeaders` at readback: A's reply must have `In-Reply-To` equal to the original transport `internetMessageId`, a distinct reply Message-ID, B sender and correlated reply body. Conversation IDs are compared only within B, not across mailboxes |
| Distribution list | Same create/send APIs, with only explicit DL address in `toRecipients`; poll each explicit expected recipient |
| Create recurring series/invite | `POST /users/{A}/events` with `transactionId`; recurring daily numbered series or explicit B attendee |
| Read occurrences | `GET /users/{A}/events/{ownedSeriesId}/instances?startDateTime=...&endDateTime=...` |
| Update/verify/delete series | `PATCH`, `GET`, `DELETE /users/{A}/events/{ownedSeriesId}`; verify updated occurrence as well |
| Verify attendee calendar | `GET /users/{B}/calendarView?startDateTime=...&endDateTime=...`; match organizer `iCalUId` and UUID subject |
| Accept/observe/cancel | `POST /users/{B}/events/{ownedAttendeeId}/accept` (`sendResponse: true`); `GET /users/{A}/events/{ownedOrganizerId}` (B status accepted); `POST .../{ownedOrganizerId}/cancel` |
| Cleanup mail | Exact UUID subject discovery `GET /users/{participant}/messages?$filter=subject eq '...'`; `DELETE /users/{participant}/messages/{ownedId}` |
| Mandatory calendar cleanup | `DELETE /users/{participant}/events/{ownedReturnedId}`; never delete an unrelated search match |

Mail/draft retention opt-out `exchangeCleanupEnabled: false` suppresses mail discovery/deletion and draft's delete business step; it emits a retention diagnostic. **Calendar deletion/cancellation remains mandatory** even with mail retention disabled. Failed prerequisites still run bounded owned-ID cleanup. Ambiguous mutation responses are not retried; a create that succeeds server-side without returning an ID, or late delivery after cleanup, can leave an artifact requiring ownership-checked operator reconciliation. Deleted Items/compliance retention may retain copies; cleanup is not a purge.

`sendDurationMs`/`deliveryDurationMs` are retained for the simple mail journey; total duration includes cleanup. Token acquisition and generic cleanup are internal, not business-step entities. Explicit delete-draft/delete-event/cancel-meeting operations are business steps. Each journey and business step has External Reports; optional root OTEL adds query signals without affecting synthetic success.

## Provider context and coverage limits

Stable `serviceHealth: true` collects Exchange health overviews/issues in an independent provider lane (`providerIntervalSeconds`, default 300), requiring separate `ServiceHealth.Read.All`. Approved overview status feeds only suppressed `exchange-service-health`; unavailable/unapproved data is Unknown. `serviceActivity.enabled` separately gates all five approved Exchange beta functions (`ENABLE_BETA_SERVICE_ACTIVITY=true`, `ServiceActivity-Exchange.Read.All`). Explicit customer thresholds can report latest fresh activity directly to Service Health; otherwise activity remains diagnostic. No provider changes synthetic samples, steps or Experience rollup. See [provider setup and deployment opt-in](../../docs/provider-monitoring.md).

Unit tests use HTTP mocks and do not certify live access; the observed live status
above is separate evidence. Validate participant permissions, Exchange propagation,
actual distribution delivery, calendar processing, and accepted model ingestion in
each chosen tenant. Beta activity currently receives 403; unavailable data is not
Healthy. Browser/mobile behavior, arbitrary distribution membership, external mail
and media quality remain outside current coverage.
