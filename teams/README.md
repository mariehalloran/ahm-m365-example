# Teams bot-backed publication journey

**Status: implemented and validated with fake HTTP, not live Microsoft 365 traffic.** The [config](./config.json) runs in simulation, not live mode. Tenant approval, installed bot resources, credentials, and live acceptance are still required; this implementation is not evidence that access has been granted.

## Optional provider context and diagnostics

[teamsProviders](./src/providers.ts) runs once per cycle in this same worker, not per channel. Defaults remain off:

- `serviceHealth: true` reads stable `/v1.0/admin/serviceAnnouncement/healthOverviews` and `/issues` for exact `Microsoft Teams`; separate `ServiceHealth.Read.All` approval is required. It is **context-only/impact-suppressed**; issues/history do not populate health signals.
- `serviceActivity.enabled: true` requires **`ENABLE_BETA_SERVICE_ACTIVITY=true`** and separately approved `ServiceActivity-Teams.Read.All`. The only/default beta function is `getMessageVolumeMetricsForTeamsChat`. This tenant report is **not** the bot channel-publication journey or a message receipt. Beta is experimental/unsupported for production, diagnostic-only and never bubbles into Experience/journey health.

See [strict config, UTC windows and flat Logger-only attributes](../utils/README.md#optional-provider-collectors), [context analytics](./queries/analytics/service-health-context.kql), [beta diagnostics](./queries/analytics/service-activity-diagnostics.kql), and [collector tests](../utils/tests/providers.test.ts). Defaults use 15-minute aggregation/30-minute lookback; only 5/10/15/30 and aligned lookbacks up to 1,440 minutes are accepted. Overlapping historical counts are not new requests and never enter synthetic/step metrics. Simulation skips all provider I/O; source failures are explicit and cannot change a successful journey's 1/0. No provider permissions are granted automatically; tenant eligibility remains unverified.

First-party references: [health overviews](https://learn.microsoft.com/graph/api/serviceannouncement-list-healthoverviews?view=graph-rest-1.0), [issues](https://learn.microsoft.com/graph/api/serviceannouncement-list-issues?view=graph-rest-1.0), [Teams chat volume beta report](https://learn.microsoft.com/graph/api/serviceactivity-getmessagevolumemetricsforteamschat?view=graph-rest-beta).

## Implemented journey

The [journey](./src/journey.ts) composes the named [actions](./src/steps.ts) `authenticate`, `postMessage`, `confirmPublication`, and `cleanup`. Journey ID `publish-channel-message` uses ordered step IDs `authenticate`, `post-message`, `confirm-publication`, `cleanup`. Every executed action emits step success (1/0) and seconds; blocked actions are skipped, not recorded as failed operations. Cleanup failure preserves prior successes and timings but fails the overall attempt.

Run `npm run teams -- --once` or, after building, `node dist/teams/src/worker.js --once`. The entry defaults to `teams/config.json` and rejects other service types before initializing credentials. Optional `--config <file>` overrides only this service's configuration.

[Analytics queries](./queries/analytics/) and [model queries](./queries/health-model/) remain owned by this service; shared telemetry semantics are in [utils](../utils/README.md#measurements-and-queries).

**Goal:** publish a uniquely identified test message to an approved Teams channel, observe the same message through a separate read request, measure the elapsed time, then remove the test message.

**Unattended path:** a tenant-approved Teams bot/agent posts a message; a team-scoped Graph read confirms channel visibility; the bot deletes its own activity. The outbound REST client does not install a bot, register resources, or start an inbound callback server.

This is a **bot-to-channel publication/readback journey**. It is not human-to-human messaging, a recipient read receipt, a Teams UI test, or a call/meeting test. A separate observer application can strengthen access-path independence, but even that is not proof a person saw the message.

Use a dedicated standard channel in a dedicated test team with no business conversation. Start with one manual run. Do not enable recurring live runs until the tenant owner approves test volume, retention, and permitted service use; Microsoft warns against using Teams messaging as a log sink. Telemetry stays in the worker's console/embedded OTel pipeline (Application Insights when configured), not in Teams messages.

## API sequence

Two different API bases and token audiences are involved:

- **Bot Connector:** `{serviceUrl}`, supplied from administrator-approved installation/conversation metadata. The shared validator accepts only `https://smba.trafficmanager.net/teams/`, `/amer/`, `/emea/`, or `/apac/` (with an optional trailing slash). Credentials, explicit ports, queries, fragments, encoded paths, dot segments, other hosts, and sovereign-cloud URLs are rejected before authentication.
- **Microsoft Graph:** `https://graph.microsoft.com/v1.0`.

| Step | Method and endpoint | Request / required check |
| --- | --- | --- |
| 1. Publish a new channel thread | `POST {serviceUrl}/v3/conversations` | Use the approved tenant/channel and a correlated initial `activity`. Capture the returned conversation `id` and `activityId`. Sending an initial activity creates the test message as part of this operation. |
| 2. Confirm channel visibility | `GET https://graph.microsoft.com/v1.0/teams/{teamId}/channels/{channelId}/messages?$top=50` | Poll within the test timeout. Find the exact run correlation marker and expected bot author; capture the Graph message ID. Do not assume a Bot activity ID equals a Graph message ID. |
| 3. Delete this run's bot message | `DELETE {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}` | Delete only the known activity created by this bot in this run. An already-absent activity (`404`) is accepted. Do not delete the channel, whole thread history, or other participants' messages. |

The create body supplies `isGroup: true`, `bot.id: "28:{BOT_CLIENT_ID}"`, `channelData.tenant/team/channel.id`, and an initial plain-text message containing only `AHM synthetic {unique UUID}`. No migration or employee-style send path is used.

Readback requires the exact marker and `from.application.id` equal to `BOT_CLIENT_ID`, ignoring deleted messages. Simple attribute-free HTML paragraph/div/line-break wrappers are normalized without evaluating HTML; other content does not match. A Graph message ID need not equal the Bot activity ID. If the installed bot's Graph author ID differs from its application ID, the probe fails confirmation: verify that mapping during tenant acceptance rather than weakening author matching. A separately configurable observer author mapping is not implemented.

The channel list endpoint supports `$top` up to 50, but not an arbitrary correlation `$filter`. Each poll inspects at most five pages in this one channel; continuation URLs must remain on the exact Graph collection path and contain only `$skiptoken` and optional `$top` (1–50). Unsafe links, cycles, incomplete pagination, malformed responses, and reads exceeding the deadline fail explicitly. No exact-message GET, reply/existing-conversation journey, or eventual Graph deletion confirmation is performed.

## Configuration and credentials

A separately approved live service configuration supplies these fields in its `targets` array (keep it disabled until live acceptance is arranged):

```json
{
  "type": "teams",
  "enabled": false,
  "intervalSeconds": 120,
  "timeoutSeconds": 45,
  "mode": "live",
  "graphAuthentication": "managed-identity",
  "cohort": "teams-global",
  "telemetry": "console",
  "targets": [
    {
      "id": "teams-001",
      "tenantId": "11111111-1111-4111-8111-111111111111",
      "teamId": "22222222-2222-4222-8222-222222222222",
      "channelId": "19:approved-channel@thread.tacv2",
      "serviceUrl": "https://smba.trafficmanager.net/teams/"
    }
  ]
}
```

These are illustrative values, not provisioned resources. `tenantId` and `teamId` must be UUIDs; `channelId` is the exact administrator-provided channel ID. The service loader maps `type: "teams"` to the result/probe type `teams-channel-message` and applies the service-level cohort and independent interval. Live execution also requires `ENABLE_LIVE_M365=true`. The runner uses:

| Transport | Environment | Token audience |
| --- | --- | --- |
| Bot Connector | `BOT_TENANT_ID`, `BOT_CLIENT_ID`, `BOT_CLIENT_CERTIFICATE_PATH` | `https://api.botframework.com/.default` |
| Microsoft Graph observer (hosted default) | Explicit UAMI `AZURE_CLIENT_ID`, and expected `AZURE_TENANT_ID` for the bot/target tenant guard | `https://graph.microsoft.com/.default` |
| Microsoft Graph observer (opt-in local certificate) | `graphAuthentication: "certificate"` with `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_CERTIFICATE_PATH` | `https://graph.microsoft.com/.default` |

Graph defaults to `ManagedIdentityCredential({ clientId: AZURE_CLIENT_ID })` only; no certificate, CLI or guessed host-identity fallback is attempted. Bot Connector **still uses its separate certificate credential**; Graph managed identity does not automatically solve bot sending. The target `tenantId`, bot tenant, and expected Graph `AZURE_TENANT_ID` must match. The applications may be separately registered; bot access does not confer Graph permission. Both clients authenticate before any mutation. Bot requests reject redirects, never receive the Graph token, and never trust a response-supplied service URL.

## Identity, resources, and hosting prerequisites

Ask the Teams/identity administrators for:

1. A dedicated test team and standard channel, their tenant/team/channel IDs, an owner, retention requirements, and approved cadence.
2. A registered tenant-approved bot/agent application with the Teams channel enabled, installed in that team.
3. An approved same-tenant Graph UAMI and an independent app-only bot certificate, plus secure certificate mounting/rotation; local Graph certificates require explicit opt-in. This implementation uses REST and existing HTTP abstractions, not a retired Bot Framework SDK.
4. **Application RSC `ChannelMessage.Read.Group`** for the observer, declared in the Teams app manifest and consented through installation in the dedicated team. This scopes reading to the team, not just one channel, so keep the whole team dedicated to testing.
5. The validated conversation metadata/service URL needed for proactive posting, plus an approved way to bootstrap/re-establish it after app installation or changes.

Bot sending is authorized through the registered bot's installed-team access; it is not the same as Graph `ChannelMessage.Send`. Bot Connector and Graph require their respective tokens; do not reuse a Graph bearer token at the Connector endpoint.

Installation/bootstrap callbacks and any bot messaging endpoint are administrator-managed prerequisites. The current worker remains outbound-only and does not implement incoming Bot Service authentication or stateful registration. Azure Container Apps is the intended runner host; no deployment is performed by this component.

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

Per-run observations:

- `sendDurationMs`: the create request phase, including failed/ambiguous attempts.
- `publicationDurationMs`: send start through the first correlated Graph observation; absent if unconfirmed.
- `durationMs`: the whole attempt, including authentication and cleanup.
- `diagnosticContext.cleanupSucceeded`, authentication duration, and a bounded failure category.

Connector acceptance alone is not success. Require correlated Graph observation; retain measured publication latency even if later cleanup fails, but mark the overall test as failed. Authentication/authorization/observer failures are monitoring execution problems, not a claim that users cannot message.

The handler returns the shared result contract for the runner's per-run result and embedded OTel export. It does not include target IDs, message bodies/IDs, service URLs, or credentials in result/diagnostic telemetry.

An ambiguous create response can leave an activity without a returned cleanup ID. POST is never automatically retried. Missing/malformed returned IDs produce an explicit cleanup-failed event and `cleanupSucceeded: false`, with no broad purge, Graph-ID substitution, or Graph cleanup query. Once IDs are known, DELETE is idempotently retryable and uses an independent ten-second cleanup budget even when the main attempt is cancelled. Cleanup failure cannot turn a preceding failure into success; after confirmed publication it changes the overall outcome to `cleanup-failure` while retaining measured timings.

## Validation and live acceptance

`npm test -- teams/tests/probe.test.ts` exercises the real Graph/Bot/HTTP clients with fake credentials, HTTP, and clock: payloads, token audience isolation, delayed readback, phase and step timing, timeout/cancellation, permission/throttling/unavailability, malformed/ambiguous sends, author/marker checks, unsafe URLs, bounded pagination, and cleanup outcomes. Named actions are also tested directly without the journey orchestrator. No live Microsoft 365 calls or permission grants are part of these tests.

Before switching from simulation to live mode, approve this coverage/resources and prove one authorized create/readback/delete sequence in the target tenant, including Graph author-ID mapping, certificate authentication, observed publication latency, and retention behavior. Then establish cleanup/reconciliation ownership, permitted volume/cadence, missing-results alerts, and telemetry-outage handling. There is currently **no live acceptance evidence**.

## Microsoft references

- [Proactive Teams messaging and installed-team requirement](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
- [Bot Connector REST create/send/delete operations](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-api-reference)
- [List channel messages: RSC read permission, supported queries, pagination](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0)
- [Get one channel message](https://learn.microsoft.com/en-us/graph/api/chatmessage-get?view=graph-rest-1.0)
- [Graph application identities](https://learn.microsoft.com/en-us/graph/api/resources/teamworkapplicationidentity?view=graph-rest-1.0)
- [Normal Graph channel-send permissions and service-use notes](https://learn.microsoft.com/en-us/graph/api/channel-post-messages?view=graph-rest-1.0)
- [Graph soft-delete permissions](https://learn.microsoft.com/en-us/graph/api/chatmessage-softdelete?view=graph-rest-1.0)
- [Teams resource-specific consent catalog](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
