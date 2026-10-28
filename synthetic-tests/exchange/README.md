# Exchange: five single-user mail and calendar journeys

Every target is **one configured user's mailbox**. All five executable journeys
stay in that mailbox; no second account, distribution group or meeting attendee
is involved. This API-backed coverage does not measure Outlook UI, employee
sign-in/MFA, external mail delivery or tenant-wide availability.

## Primary setup

1. Select the five scenarios and independent mailboxes in root
   `monitoring.config.json`, under `tenants[].services.exchange`:

   ```json
   { "id": "exchange-probe-001", "mailbox": "synthetic-user@example.invalid" }
   ```

   Addresses must be unique case-insensitively. Optional `region`, simulation
   `scenario` and generated `replySeed` bindings remain supported. Do not put
   generated IDs in the config. Removed `recipientMailbox`, `distributionList`,
   distribution and invitation scenario options are rejected, even when disabled.
2. Obtain administrator approval for dedicated mailboxes and mailbox-scoped
   `Application Mail.Send`, `Application Mail.ReadWrite` and, for the recurring
   calendar journey, `Application Calendars.ReadWrite`. Retain the allowed/denied
   control checks and prohibition on additional unscoped Entra mail/calendar grants
   in the [access request](../../MAILBOX-SYNTHETIC-ACCESS.md).
3. Configure the approved worker identity, live opt-in and destination in the same
   root config. `npm run setup` extends only the approved Exchange management scope
   to these mailboxes and validates/provisions self-addressed reply fixtures.
   It does not create distribution groups.
4. On an approved host, run `npm run exchange -- --once`, then verify actual
   operations, cleanup and accepted health ingestion. No live acceptance or service
   capacity is established by source checks.

## Journeys and scheduling

| Scenario | Stable entity | Sequential business steps |
| --- | --- | --- |
| `send-receive-mail` | `exchange-global` | Create mail addressed to self, send, verify own Inbox receipt |
| `edit-reopen-draft` | `exchange-draft` | Create, read, edit, reopen/verify and delete own draft |
| `attachment-mail` | `exchange-attachment` | Send attachment to self; download and verify byte length and SHA-256 |
| `reply-mail` | `exchange-reply` | **SELF-REPLY** to a retained received self-addressed fixture; verify transport correlation in own Inbox |
| `recurring-calendar` | `exchange-recurring` | Create a private daily series with no attendees; read all three occurrences, update/read series and occurrences, delete and observe removal |

Mail (`exchange-mail`) parents the four mail journeys; Calendar
(`exchange-calendar`) parents the private recurring-series journey. “Private”
means **no other participant**, not a change to calendar sharing or mailbox ACLs.

Every selected journey for every configured mailbox runs on **one aligned
wall-clock minute schedule**: 100 mailboxes × five journeys = 500 attempts/minute.
Independent journeys start concurrently; dependent steps stay sequential and all
results settle before reporting. Normal continuous execution waits for the next
minute boundary; explicit `--once` is an immediate single-cycle diagnostic.
Missed minute slots are skipped without overlap or catch-up/repeated batches.

The only Exchange concurrency controls needed are:

```json
{
  "intervalSeconds": 60,
  "timeoutSeconds": 30,
  "maxConcurrentRequests": 32,
  "maxConcurrentRequestsPerMailbox": 2
}
```

They limit **actual Graph HTTP requests**, not active journeys. Polling, retries
and cleanup use the same global/per-mailbox permits; waiting is abortable and
counts against the attempt deadline. One busy mailbox cannot occupy all global
permits while waiting on its own limit. The older `maxConcurrentProbes` setting
continues to govern only other products. Exchange does not use split execution
lanes; custom assignments, if supplied, must put all five journeys in one
60-second lane.

SELF-REPLY has a **30-second execution deadline**; all other Exchange journeys have
**15 seconds**. A timeout is a failed attempt (success 0, Unhealthy), not Unknown.
Latency degradation remains **15 seconds**; a slower successful SELF-REPLY is
Degraded. Cleanup has its independent ten-second signal and twelve-second runner
settlement grace. The minute reserves at most 42 seconds for execution/settlement,
12 for health publication and 5 for telemetry flush; delayed starts reduce the
remaining execution budget instead of extending the minute. Other products and
independently scheduled provider collection retain their existing cadences.

`exchange-minute-capacity` is emitted once per reporting group with expected,
started, completed and timed-out attempts, Graph-request count and permit waiting.
It is runner-capacity evidence, separate from Exchange availability. Requests
that time out waiting for capacity still produce unsuccessful journey results;
they are not dropped to improve a percentage. These limits are not a throughput
guarantee: obtain live evidence for the selected cohort without relaxing deadlines.

## Provision and test attachment and reply separately

A reply seed is a **retained received self-addressed message in that same user's
Inbox**, provisioned outside the timed attempt. `npm run setup` invokes the existing
mail fixture command in a one-time job under the worker's approved identity.
Existing valid fixtures are reused; an observed missing ID is explicitly
reprovisioned. Setup duration and failures are separate diagnostics, with a
120-second per-target setup bound.

The received immutable ID and correlation UUID are saved only in the gitignored
`.env` beside the root config, as
`<TENANT>__<TARGET>__REPLY_SEED_MESSAGE_ID` and
`<TENANT>__<TARGET>__REPLY_SEED_CORRELATION_ID`. Commands/deploy fill them in
automatically. Never copy secrets or generated seed IDs into the config.

On an approved managed-identity host or with explicitly selected certificate
authentication, the same command can provision and measure independently:

```sh
npm run exchange:mail-test                         # plan; no cloud writes
ENABLE_LIVE_M365=true npm run exchange:mail-test -- --apply --setup-only
ENABLE_LIVE_M365=true npm run exchange:mail-test -- --apply --samples 3
```

Add `--tenant <alias>` for a multi-tenant config. The diagnostic publishes no health
reports; measured attachment/SELF-REPLY samples retain the worker's 15/30-second
deadlines. Missing setup fails honestly instead of manufacturing success.

### Migrating old paired fixtures

Old paired seed IDs are **not** accepted as single-user fixtures. Folder-scoped
lookup must find the configured ID in the user's own Inbox, and validation requires
self `from`/`to`, no non-self `replyTo`/CC/BCC, a self-fixture subject/body marker and
the `x-ahm-reply-seed-scope: self-v1` header. Failure is explicit
`configuration-failure`, with `self-reply-seed-…-reprovision` diagnostics.

Before upgrading workers, stop old Exchange revisions/jobs, convert every unique
former sender **and recipient** into an independent target, preserve reporting-group
account membership, and run:

```sh
npm run setup -- -ReprovisionReplySeeds
# Or, with the explicitly approved local credential:
ENABLE_LIVE_M365=true npm run exchange:mail-test -- --apply --setup-only --reprovision-seeds
```

The opt-in replaces only missing/incompatible bindings after validation; valid
self fixtures are reused, denied access is never bypassed, and old retained seeds
are **not deleted**. Review old artifacts separately under the tenant's retention
policy. No fixture migration, tenant modification or `.env` update is performed
by local source validation.

## Exact Graph operations and ownership

All endpoints use `https://graph.microsoft.com/v1.0`, encoded mailbox/artifact IDs
and `Prefer: IdType="ImmutableId"`. `{user}` always means the target's sole mailbox.

| Operation | Endpoint/evidence |
| --- | --- |
| Create mail/draft/attachment | `POST /users/{user}/messages`; unique UUID subject, body marker and correlation header; only self in `toRecipients` |
| Read/edit/delete draft | `GET`, `PATCH`, `DELETE /users/{user}/messages/{ownedId}`; verify initial and edited body, subject, ID and draft status |
| Send | `POST /users/{user}/messages/{ownedId}/send` |
| Receive | `GET /users/{user}/mailFolders/inbox/messages`; exact subject or reply conversation/recent creation filter; verify self sender/recipients and attempt body marker |
| Download attachment | `GET …/messages/{receivedId}/attachments`, then `GET …/attachments/{attachmentId}`; decode and compare byte length/SHA-256 |
| Read retained fixture | `GET /users/{user}/mailFolders/inbox/messages/{seedId}` with headers, body, sender and recipient fields selected |
| SELF-REPLY | `POST …/messages/{seedId}/createReply` with atomic attempt comment; validate inherited subject/conversation and **all generated recipients before sending**; `PATCH` owned body, then `POST …/{replyId}/send` |
| Confirm SELF-REPLY | Own Inbox message must have one `In-Reply-To` equal to the seed's transport `internetMessageId`, a distinct reply Message-ID, matching subject/conversation, self sender/recipients and unique attempt marker |
| Private recurrence | `POST /users/{user}/events` with UUID `transactionId`, three daily occurrences and `attendees: []`; `GET …/{seriesId}/instances`, `PATCH`/`GET` series, `DELETE` series and poll for observed 404 |
| Cleanup | Discover only attempt-marked copies under this user's `/messages`, then delete known/discovered owned IDs. Reply discovery uses mailbox-local conversation and the unique attempt marker, never the seed ID. Ambiguous event creation is reconciled only by exact subject, transaction ID, own organizer and no attendees |

[`createReply`](https://learn.microsoft.com/en-us/graph/api/message-createreply?view=graph-rest-1.0)
honors the original `replyTo`; fixture and generated-recipient checks therefore
reject any non-self destination before send. This is intentionally labelled
SELF-REPLY, not evidence of interaction between two people.

Ambiguous writes are not blindly retried. Cleanup tries all known owned IDs even
when reconciliation or another deletion fails, and never claims another attempt's
reply, a foreign message or a retained seed. Draft deletion and recurring-series
deletion are mandatory business steps. `exchangeCleanupEnabled: false` is a mail
artifact retention diagnostic only; it cannot disable those business steps.
Late server-side completion after bounded cleanup can require ownership-checked
operator reconciliation. Deleted Items/compliance retention is not a purge.

## Removed model entities and coverage limits

Incremental deployment does not delete old entities. After old workers stop,
review paginated model inventories and retire only `exchange-distribution` with
its `send-group-mail`/`confirm-group-delivery` children, and `exchange-meeting` with
its `create-meeting`, `confirm-invitation`, `verify-attendee-calendar`,
`accept-meeting`, `confirm-acceptance` and `cancel-meeting` children.
Remove relationships before entities; preserve Mail, Calendar and all five retained
journey IDs. See the [ordered model migration](../../health-model/README.md#single-user-exchange-conversion).

Stable Service Health and the five approved beta activity functions remain
independent provider context, not synthetic success evidence. Their cadences and
permissions are unchanged; see [provider monitoring](../../docs/provider-monitoring.md).
Source validation is not live tenant execution, delivered notifications, capacity
acceptance, Outlook client coverage or calendar-sharing/privacy validation.
