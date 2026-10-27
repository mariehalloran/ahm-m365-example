# Exchange: completed mail and calendar journeys

One Exchange worker runs seven independent API-backed journeys. Business steps remain sequential within an attempt; targets and journeys run concurrently (three attempts per lane). Nothing measures Outlook UI, employee sign-in/MFA, external delivery, or tenant-wide availability.

All seven journeys below have real implementations. Source tests are not live
acceptance; see [deployment evidence](../../docs/deployment.md#deployment-status-and-order)
for observed tenant execution and ingestion.

## Primary setup

1. Select journeys and approved participants **only in the root project config**. The checked-in root selects all seven; its `.invalid` addresses are simulation placeholders, not live resources.
2. Approve dedicated, licensed mailboxes and scope `Application Mail.Send`, `Application Mail.ReadWrite`, and (for calendar journeys) `Application Calendars.ReadWrite` through Exchange RBAC for Applications to just those participants. Verify both allowed participants and a denied control mailbox. Do not add tenant-wide Entra mail/calendar grants.
3. Set service `mode: "live"`, explicitly selected managed identity, live consent `ENABLE_LIVE_M365=true`, approved model destination, and deploy models before workers. See [access request](../../MAILBOX-SYNTHETIC-ACCESS.md), [identity details](../../docs/cross-tenant-access.md), and [deployment](../../docs/deployment.md).
4. Provision the retained reply fixture using the diagnostic command below; review its output root configuration before worker deployment.
5. Run `npm run exchange -- --once --project-config /absolute/path/monitoring.private.json` from `synthetic-tests/`; verify actual journey execution **and accepted health ingestion**.

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

`mailbox` is A; `recipientMailbox` is B. Attachment, reply and meeting journeys require distinct explicit A/B participants. Distribution-list delivery verifies **every** listed expected recipient; it does not discover members or infer tenant accounts. Recurring events and drafts use A. Each selected journey runs for every configured target; do not duplicate a group/participant set unless duplicate traffic is intended.

All seven supported scenario keys default to enabled; explicitly select each in private profiles. Selected live journeys with missing prerequisites report observed `configuration-failure`/Unhealthy, never simulation or an invented A→A flow. The original mail journey alone retains its single-mailbox self-delivery fallback when B is omitted.

## Provision and test attachment and reply separately

Run in the approved managed-identity host, or explicitly select certificate
authentication for local development. No developer-login fallback is used:

```sh
ENABLE_LIVE_M365=true npm run exchange:mail-test -- \
  --project-config /absolute/path/monitoring.private.json \
  --output-config /absolute/path/monitoring.with-reply-seeds.json \
  --samples 3
```

The command uses the selected root participants and service authentication. It
provisions one real received message in B for each selected reply target, then
persists `replySeed: { "messageId": "...", "correlationId": "..." }` in a new,
private root file. An existing valid binding is reused; an observed 404 is
explicitly reprovisioned. Permission or ownership failures are not bypassed.
The original root file is never overwritten, existing output files are rejected,
and concurrent input changes stop publication. Service config paths in the output
are resolved against the original root. `--config` can explicitly select the
Exchange service file; `--setup-only` provisions without measured attempts.

Setup timings/failures are logged separately with a 120-second per-target bound.
Missing or failed setup is never counted as a successful reply. The command then
runs attachment and reply attempts independently, including per-attempt
authentication and seed validation. It emits actual durations/timeouts, exits
nonzero on failure, and **publishes no health reports** or production configuration
changes. A 15-second ceiling is a failure boundary, not a guarantee of delivery.

For private-profile migration, replace `attachment-reply-mail` with the independent
`attachment-mail` and `reply-mail` switches and update explicit lane assignments.
Keep `exchange-attachment` and its send/verify step IDs. Before upgrading workers,
deploy `exchange-reply` and its `reply-mail`/`confirm-reply-mail` children under Mail.
After old workers stop reporting, delete only the obsolete
`exchange-attachment-reply-mail` and `exchange-attachment-confirm-reply-mail`
entities and their relationships. Incremental deployment does not remove them.

## Journeys and scheduling

In the health model, **Mail** (`exchange-mail`) parents the five mail journeys;
**Calendar** (`exchange-calendar`) parents the two calendar journeys. They roll
up existing child health without extra probes, reports or schedules. Existing
attachment send/verify IDs are retained; the reply journey has its own IDs.

| Root scenario | Journey entity | Sequential business steps | Default cadence |
| --- | --- | --- | --- |
| `send-receive-mail` | `exchange-global` | Create mail, send A→B, verify actual B Inbox delivery | 60 seconds |
| `edit-reopen-draft` | `exchange-draft` | Create, initial read, update, reopen/verify, delete owned draft | 300 seconds |
| `attachment-mail` | `exchange-attachment` | Send attachment A→B, verify downloaded SHA-256 | 300 seconds |
| `reply-mail` | `exchange-reply` | Validate retained received message, reply B→A, verify transport reply headers/sender/body marker | 300 seconds |
| `distribution-list-mail` | `exchange-distribution` | Send to explicit list, verify every expected Inbox | 300 seconds |
| `recurring-calendar` | `exchange-recurring` | Create daily series, verify all three distinct occurrences, update series, verify all three updated occurrences, delete series and observe its removal | 300 seconds |
| `meeting-invitation` | `exchange-meeting` | Create invitation, B receives, verify B calendar by iCalUId, B accepts, A observes accepted attendee, A cancels and verifies B's calendar is cancelled or the event is absent | 300 seconds |

The 60-second mail flow stays simple: no attachment or reply is required. Draft
deletion may be disabled explicitly for trial retention as described below.
Mailbox search, external delivery and browser/client workflows are not implemented
or selectable.

Service-owned optional settings:

```json
"executionLanes": [
  { "name": "mail", "intervalSeconds": 60, "timeoutSeconds": 15, "journeys": ["send-receive-mail"] },
  { "name": "extended", "intervalSeconds": 300, "timeoutSeconds": 15,
    "journeys": ["edit-reopen-draft", "attachment-mail", "reply-mail", "distribution-list-mail", "recurring-calendar", "meeting-invitation"] }
]
```

Explicit lane settings must assign every supported service journey exactly once, even when disabled at the root. Without them, `mail` inherits service `intervalSeconds`/`timeoutSeconds` (checked-in 60/15); `extended` uses 300 seconds and the service timeout. All live Exchange attempts, including explicit lanes, are capped at 15 seconds; shorter configured timeouts remain shorter. Other products' deadlines are unchanged. Both lanes start immediately. Slow extended execution/reporting cannot block mail. A lane never overlaps itself; missed slots emit `service-slots-skipped` with lane, first slot, and count, without catch-up bursts. `--once` settles both selected lanes before exiting.

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
| Retained reply seed | Outside the timed attempt: create/send A→B and observe received mail; persist B's immutable ID and unique fixture header. Each reply attempt validates it with `GET /users/{B}/messages/{seedId}?$select=id,subject,isDraft,conversationId,internetMessageId,from,internetMessageHeaders` |
| Correlated reply | `POST /users/{B}/messages/{seedId}/createReply`; `PATCH` owned reply body without changing its inherited subject/conversation; `POST .../{replyId}/send`; explicitly select `internetMessageHeaders` at readback: A's reply must have `In-Reply-To` equal to the seed transport `internetMessageId`, a distinct reply Message-ID, B sender and this attempt's unique reply body marker. Conversation IDs are compared only within B, not across mailboxes |
| Distribution list | Same create/send APIs, with only explicit DL address in `toRecipients`; poll each explicit expected recipient |
| Create recurring series/invite | `POST /users/{A}/events` with `transactionId`; recurring daily numbered series or explicit B attendee |
| Read occurrences | `GET /users/{A}/events/{ownedSeriesId}/instances?startDateTime=...&endDateTime=...` |
| Update/verify/delete series | `PATCH`, `GET`, `DELETE /users/{A}/events/{ownedSeriesId}`; verify all updated occurrences, then poll the deleted master for an observed 404 |
| Verify attendee calendar | `GET /users/{B}/calendarView?startDateTime=...&endDateTime=...`; match organizer `iCalUId` and UUID subject. Follow at most ten same-origin, exact-mailbox collection pages; normalize only the mailbox's literal/encoded `@`. A current-page match does not require following the continuation |
| Accept/observe/cancel | `POST /users/{B}/events/{ownedAttendeeId}/accept` (`sendResponse: true`); `GET /users/{A}/events/{ownedOrganizerId}` (B status accepted); `POST .../{ownedOrganizerId}/cancel`, then poll `GET /users/{B}/events/{ownedAttendeeId}` for matching `iCalUId` and `isCancelled: true`, or an observed 404 |
| Cleanup mail | Exact subject discovery `GET /users/{participant}/messages?$filter=subject eq '...'`; stable reply subjects also require a recent receive timestamp and this attempt's body marker. `DELETE /users/{participant}/messages/{ownedId}` never claims a retained seed or another attempt's reply |
| Mandatory calendar cleanup | `DELETE /users/{participant}/events/{ownedReturnedId}`; never delete an unrelated search match. Successful organizer cancellation already moves that event to Deleted Items, so do not delete its immutable ID through `/events` again; still delete the attendee event |

Mail/draft retention opt-out `exchangeCleanupEnabled: false` suppresses mail discovery/deletion and draft's delete business step; it emits a retention diagnostic. The retained reply seed is never an attempt-owned cleanup target, regardless of this setting. **Calendar deletion/cancellation remains mandatory** even with mail retention disabled. Failed prerequisites still run bounded owned-ID cleanup with a separate signal/budget. Simple-mail cleanup attempts discovery and every known copy in both participants even if another discovery/deletion fails; the attempt still reports cleanup failure. Attachment, reply, distribution and meeting mail discovery never claims records with a different subject; replies also require the attempt marker. Distribution fanout settles all recipient reads and preserves observed permission/throttling/read failures rather than relabeling them as delivery timeouts.

A rejected cancellation leaves both event IDs eligible for cleanup; successful cancellation releases only the organizer ID, even if attendee readback subsequently fails. Attendee cleanup errors still fail the journey. Recurring-series deletion retains cleanup ownership until a 404 confirms removal. Ambiguous mutation responses are not retried; a create that succeeds server-side without returning an ID, or late delivery after cleanup, can leave an artifact requiring ownership-checked operator reconciliation. Deleted Items/compliance retention may retain copies; cleanup is not a purge.

`sendDurationMs`/`deliveryDurationMs` are retained for the simple mail journey; total duration includes cleanup. Token acquisition and generic cleanup are internal, not business-step entities. Explicit delete-draft/delete-event/cancel-meeting operations are business steps. Each journey and business step has External Reports; optional root OTEL adds query signals without affecting synthetic success.

## Provider context and coverage limits

Stable `serviceHealth: true` collects Exchange health overviews/issues in an independent provider lane (`providerIntervalSeconds`, default 300), requiring separate `ServiceHealth.Read.All`. Approved overview status feeds only suppressed `exchange-service-health`; unavailable/unapproved data is Unknown. `serviceActivity.enabled` separately gates all five approved Exchange beta functions (`ENABLE_BETA_SERVICE_ACTIVITY=true`, `ServiceActivity-Exchange.Read.All`). Explicit customer thresholds can report latest fresh activity directly to Service Health; otherwise activity remains diagnostic. No provider changes synthetic samples, steps or Experience rollup. See [provider setup and deployment opt-in](../../docs/provider-monitoring.md).

Unit tests use HTTP mocks and do not certify live access; the observed live status
above is separate evidence. Validate participant permissions, Exchange propagation,
actual distribution delivery, calendar processing, and accepted model ingestion in
each chosen tenant. Beta activity currently receives 403; unavailable data is not
Healthy. Browser/mobile behavior, arbitrary distribution membership, external mail
and media quality remain outside current coverage.
