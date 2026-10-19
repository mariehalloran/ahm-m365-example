# Teams journey and endpoint plan

**Status: planning only.** There is no Teams handler or bot deployment. The [config](./config.json) remains disabled.

## Journey to implement first

**Goal:** publish a uniquely identified test message to an approved Teams channel, observe the same message through a separate read request, measure the elapsed time, then remove the test message.

**Recommended unattended path:** a tenant-approved Teams bot/agent posts a message; a team-scoped Graph read confirms channel visibility; the bot deletes its own activity.

This is a **bot-to-channel publication/readback journey**. It is not human-to-human messaging, a recipient read receipt, a Teams UI test, or a call/meeting test. A separate observer application can strengthen access-path independence, but even that is not proof a person saw the message.

Use a dedicated standard channel in a dedicated test team with no business conversation. Start with one manual run. Do not enable a one-minute schedule until the tenant owner approves test volume, retention, and permitted service use; Microsoft warns against using Teams messaging as a log sink. Telemetry goes to Application Insights, not into Teams messages.

## API sequence

Two different API bases and token audiences are involved:

- **Bot Connector:** `{serviceUrl}`, taken from validated bot installation/conversation metadata and approved for this tenant/cloud. Do not hard-code an arbitrary global/regional hostname or accept an untrusted URL from config input.
- **Microsoft Graph:** `https://graph.microsoft.com/v1.0`.

| Step | Method and endpoint | Request / required check |
| --- | --- | --- |
| 1. Publish a new channel thread | `POST {serviceUrl}/v3/conversations` | Use the approved tenant/channel and a correlated initial `activity`. Capture the returned conversation `id` and `activityId`. Sending an initial activity creates the test message as part of this operation. |
| 2. Confirm channel visibility | `GET https://graph.microsoft.com/v1.0/teams/{teamId}/channels/{channelId}/messages?$top=50` | Poll within the test timeout. Find the exact run correlation marker and expected bot author; capture the Graph message ID. Do not assume a Bot activity ID equals a Graph message ID. |
| 3. Optionally fetch the exact observed item | `GET https://graph.microsoft.com/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}` | Verify the exact message/payload using the ID discovered in step 2. The list observation already establishes API visibility; this request is optional corroboration. |
| 4. Delete this run's bot message | `DELETE {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}` | Delete only the known activity created by this bot in this run. Do not delete the channel, whole thread history, or other participants' messages. |
| 5. Confirm cleanup if required | Repeat the bounded Graph read | Accept absent/soft-deleted content according to documented behavior and retention. Measure/validate eventual deletion separately from publication. |

If the selected journey later posts into a preapproved existing conversation rather than creating a new thread, sending uses:

```http
POST {serviceUrl}/v3/conversations/{conversationId}/activities
```

That is a different configured journey; do not silently switch between a new-channel-thread test and a reply/existing-conversation test.

The channel list endpoint supports `$top` up to 50, but not an arbitrary correlation `$filter`. Bound any pagination and inspect only the approved dedicated channel. If the run cannot be located within the search/timeout budget, report an explicit unconfirmed/error outcome rather than success.

## Identity, resources, and hosting prerequisites

Ask the Teams/identity administrators for:

1. A dedicated test team and standard channel, their tenant/team/channel IDs, an owner, retention requirements, and approved cadence.
2. A registered tenant-approved bot/agent application with the Teams channel enabled, installed in that team.
3. A supported application credential/workload-identity design for the bot transport. Use a current supported Teams SDK where appropriate; publishing REST routes here is not a recommendation to adopt a retired SDK.
4. **Application RSC `ChannelMessage.Read.Group`** for the observer, declared in the Teams app manifest and consented through installation in the dedicated team. This scopes reading to the team, not just one channel, so keep the whole team dedicated to testing.
5. The validated conversation metadata/service URL needed for proactive posting, plus an approved way to bootstrap/re-establish it after app installation or changes.

Bot sending is authorized through the registered bot's installed-team access; it is not the same as Graph `ChannelMessage.Send`. Bot Connector and Graph require their respective tokens; do not reuse a Graph bearer token at the Connector endpoint.

If the same Container App hosts the bot's installation/callback handler, an additional planned inbound route is:

```http
POST https://{teams-container-app-host}/api/messages
```

The bot registration points to that handler. It must validate Bot Service authentication and tenant/resource scope. The worker's scheduled test and embedded OTel remain in that same app; no separate telemetry worker is needed. This inbound bot integration is new infrastructure/code, not something the current outbound-only worker already provides.

Conversation metadata can be approved configuration/setup input. Each test's returned message/activity IDs remain only in memory for cleanup; no worker health history or Blob checkpoint is required.

## Why not use ordinary app-only Graph send/delete?

An employee-style delegated Graph journey would use:

```http
POST /teams/{teamId}/channels/{channelId}/messages
GET  /teams/{teamId}/channels/{channelId}/messages/{messageId}
POST /teams/{teamId}/channels/{channelId}/messages/{messageId}/softDelete
```

However:

- The normal channel-send endpoint documents delegated `ChannelMessage.Send` and application `Teamwork.Migrate.All` for migration, not a general unattended live-send permission.
- The RSC catalog separately lists application `ChannelMessage.Send.Group`, with a warning that not all cataloged features are generally available. That listing alone does not validate the full send/read/delete sequence for this worker and tenant.
- The Graph channel `softDelete` action documents delegated `ChannelMessage.ReadWrite`, with application permission not supported.

Therefore, do not grant migration permissions, bypass MFA, or claim the existing app-only certificate is sufficient. If true employee-to-employee messaging is required, approve a supported delegated/interactive test-identity design first. The bot journey must not be relabeled as a test of employee login or receipt.

## Measurements and failure behavior

Planned per-run observations:

- Send start, Connector acceptance, and first correlated Graph observation.
- Confirmed publication duration from send start to Graph observation.
- Total attempt duration through cleanup.
- Cleanup outcome and bounded failure category.

Connector acceptance alone is not success. Require correlated Graph observation; retain measured publication latency even if later cleanup fails, but mark the overall test as failed. Authentication/authorization/observer failures are monitoring execution problems, not a claim that users cannot message.

Export a per-run result and low-cardinality OTel outcome/duration metrics from the same process. The Teams-specific measurement fields/instruments still need implementation; the current result contract only has Exchange-specific confirmed delivery timing.

An ambiguous create response can leave an activity without a returned cleanup ID. Do not retry a possibly completed send automatically. An owner-approved reconciliation path or explicit cleanup-failed result is required before enabling recurring tests.

## Implementation and acceptance order

1. Approve this bot-backed coverage and the dedicated resources.
2. Prove one authorized create/readback/delete sequence in the target tenant, including Bot/Graph ID behavior and retention.
3. Add the disabled-by-default Teams handler, strict config fields, fake-HTTP tests, and OTel measurements.
4. Test permission denial, timeout, ambiguous send, cleanup failure, and observer/telemetry outages.
5. Enable a schedule only after missing-results notifications and operating ownership are configured.

## Microsoft references

- [Proactive Teams messaging and installed-team requirement](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
- [Bot Connector REST create/send/delete operations](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-api-reference)
- [List channel messages: RSC read permission, supported queries, pagination](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0)
- [Get one channel message](https://learn.microsoft.com/en-us/graph/api/chatmessage-get?view=graph-rest-1.0)
- [Normal Graph channel-send permissions and service-use notes](https://learn.microsoft.com/en-us/graph/api/channel-post-messages?view=graph-rest-1.0)
- [Graph soft-delete permissions](https://learn.microsoft.com/en-us/graph/api/chatmessage-softdelete?view=graph-rest-1.0)
- [Teams resource-specific consent catalog](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
