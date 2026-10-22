# Teams bot-backed publication journey

**Status: implemented and validated with fake HTTP; successful live publication is not yet accepted.** The [config](./config.json) runs in simulation. The separate cloud failure-path trial makes real authentication/setup attempts and reports actual failures, not simulated health. Tenant approval, installed bot resources, credentials, and successful live acceptance are still required.

## Optional provider context and diagnostics

[teamsProviders](./src/providers.ts) runs once per cycle in this same worker, not per channel or journey. Simulation keeps providers off; the live example enables stable Service Health. Missing bot credentials do not prevent its independent Graph collection attempt:

- `serviceHealth: true` reads stable `/v1.0/admin/serviceAnnouncement/healthOverviews` and `/issues` for exact `Microsoft Teams`; separate `ServiceHealth.Read.All` admin consent is required. Overview status reports directly to `teams-service-health` as `microsoft-reported-service-status`: 100 healthy, 50 degraded, 0 interruption, with `impactSuppressed`. Failed/missing/unknown overview status reports Unknown without a value and with failure context. The existing trial receives Graph 403 pending consent. Issues/history do not populate health signals.
- `serviceActivity.enabled: true` requires **`ENABLE_BETA_SERVICE_ACTIVITY=true`** and separately approved `ServiceActivity-Teams.Read.All`. The only/default beta function is `getMessageVolumeMetricsForTeamsChat`. This tenant report is **not** the bot channel-publication journey or a message receipt. Beta is experimental/unsupported for production, diagnostic-only and never bubbles into Experience/journey health.

See [strict config, UTC windows and console diagnostics](../utils/README.md#optional-provider-collectors) and [collector tests](../utils/tests/providers.test.ts). Defaults use 15-minute aggregation/30-minute lookback; only 5/10/15/30 and aligned lookbacks up to 1,440 minutes are accepted. Overlapping historical counts are not new requests and never enter synthetic/step aggregates. Simulation skips all provider I/O; source failures are explicit and cannot change a successful journey's 1/0. No provider permissions are granted automatically; tenant eligibility remains unverified.

First-party references: [health overviews](https://learn.microsoft.com/graph/api/serviceannouncement-list-healthoverviews?view=graph-rest-1.0), [issues](https://learn.microsoft.com/graph/api/serviceannouncement-list-issues?view=graph-rest-1.0), [Teams chat volume beta report](https://learn.microsoft.com/graph/api/serviceactivity-getmessagevolumemetricsforteamschat?view=graph-rest-beta).

## Implemented journeys

The [journeys](./src/journey.ts) compose reusable [operations](./src/steps.ts), keeping token acquisition and cleanup internal. `publish-channel-message` has `post-message` and `confirm-publication` child entities beneath `teams-global`. The second journey, `reply-channel-message`, has `post-message`, `post-reply`, and `confirm-reply` beneath separate entity `teams-reply`. Step IDs are journey-scoped. Every journey/step always receives direct success/duration reports in **External Reports**, independently of optional Azure OTEL query signals. Token/cleanup steps have no entities, published step observations, or standalone health signals. Blocked actions are skipped, not failed requests; cleanup failure remains an overall diagnostic without rewriting prior business-action successes.

The reply journey creates its own uniquely marked parent thread, replies as the bot, independently locates that parent through Graph and confirms the exact reply marker and expected author. It deletes the known owned reply before the parent. Both root scenarios default enabled and share the same worker, installed bot, observer permissions and cadence. See [reply HTTP tests](./tests/reply.test.ts).

From the `synthetic-tests/` project directory, run `npm run teams -- --once` or, after building, `node dist/teams/src/worker.js --once`. The [root config](../../monitoring.config.json) selects these journeys, targets, report policy, and its service config file. `--project-config <file>` selects a private root file; `--config <file>` overrides only the service file, not root targets/gates/report policy. Other service types are rejected before credentials.

The shared worker aggregates each complete cycle's journey/actions and publishes health reports directly to the Teams model's separate journey/business-step entities. Simulation prints local previews only; see [report semantics](../utils/README.md#per-cycle-health-reports) and [measurement semantics](../utils/README.md#measurement-semantics). Reports are not a full metrics store or percentile history.

**Goal:** publish a uniquely identified test message to an approved Teams channel, observe the same message through a separate read request, measure the elapsed time, then remove the test message.

**Unattended path:** a tenant-approved Teams bot/agent posts a message; a team-scoped Graph read confirms channel visibility; the bot deletes its own activity. The outbound REST client does not install a bot, register resources, or start an inbound callback server.

This is a **bot-to-channel publication/readback journey**. It is not human-to-human messaging, a recipient read receipt, a Teams UI test, or a call/meeting test. A separate observer application can strengthen access-path independence, but even that is not proof a person saw the message.

Use a dedicated standard channel in a dedicated test team with no business conversation. Start with one manual run. Do not enable recurring live runs until the tenant owner approves test volume, retention, and permitted service use; Microsoft warns against using Teams messaging as a log sink. Diagnostics stay in the worker's console, not in Teams messages.

## API sequence

Two different API bases and token audiences are involved:

- **Bot Connector:** `{serviceUrl}`, supplied from administrator-approved installation/conversation metadata. The shared validator accepts only `https://smba.trafficmanager.net/teams/`, `/amer/`, `/emea/`, or `/apac/` (with an optional trailing slash). Credentials, explicit ports, queries, fragments, encoded paths, dot segments, other hosts, and sovereign-cloud URLs are rejected before authentication.
- **Microsoft Graph:** `https://graph.microsoft.com/v1.0`.

| Step | Method and endpoint | Request / required check |
| --- | --- | --- |
| 1. Publish a new channel thread | `POST {serviceUrl}/v3/conversations` | Use the approved tenant/channel and a correlated initial `activity`. Capture the returned conversation `id` and `activityId`. Sending an initial activity creates the test message as part of this operation. |
| 2. Confirm channel visibility | `GET https://graph.microsoft.com/v1.0/teams/{teamId}/channels/{channelId}/messages?$top=50` | Poll within the test timeout. Find the exact run correlation marker and expected bot author; capture the Graph message ID. Do not assume a Bot activity ID equals a Graph message ID. |
| Reply to this run's thread | `POST {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}` | Use only the created parent activity and a distinct correlated reply; do not retry an ambiguous mutation |
| Confirm reply visibility | `GET https://graph.microsoft.com/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies?$top=50` | Resolve the owned parent through Graph first, then find the expected reply marker and bot author; acceptance of the Connector POST is not confirmation |
| 3. Delete this run's bot message | `DELETE {serviceUrl}/v3/conversations/{conversationId}/activities/{activityId}` | Delete only the known activity created by this bot in this run. An already-absent activity (`404`) is accepted. Do not delete the channel, whole thread history, or other participants' messages. |

The create body supplies `isGroup: true`, `bot.id: "28:{BOT_CLIENT_ID}"`, `channelData.tenant/team/channel.id`, and an initial plain-text message containing only `AHM synthetic {unique UUID}`. No migration or employee-style send path is used.

Readback requires the exact marker and `from.application.id` equal to `BOT_CLIENT_ID`, ignoring deleted messages. Simple attribute-free HTML paragraph/div/line-break wrappers are normalized without evaluating HTML; other content does not match. A Graph message ID need not equal the Bot activity ID. If the installed bot's Graph author ID differs from its application ID, the probe fails confirmation: verify that mapping during tenant acceptance rather than weakening author matching. A separately configurable observer author mapping is not implemented.

The channel list endpoint supports `$top` up to 50, but not an arbitrary correlation `$filter`. Each poll inspects at most five pages in the exact collection; continuation URLs must remain on the expected Graph channel-message/reply path and contain only `$skiptoken` and optional `$top` (1–50). Unsafe links, cycles, incomplete pagination, malformed responses, and reads exceeding the deadline fail explicitly. No employee thread is reused, and no eventual Graph deletion confirmation is performed.

## Configuration and credentials

A separately approved root configuration supplies target objects like this in `services.teams.targets`. Keep live execution gated until acceptance is arranged; the service file contains only execution settings, not a second target list:

```json
{
  "id": "teams-001",
  "tenantId": "11111111-1111-4111-8111-111111111111",
  "teamId": "22222222-2222-4222-8222-222222222222",
  "channelId": "19:approved-channel@thread.tacv2",
  "serviceUrl": "https://smba.trafficmanager.net/teams/"
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
- A bounded failure category; authentication timing and cleanup status remain internal, not published business steps or private result fields.

Connector acceptance alone is not success. Require correlated Graph observation; retain measured publication latency even if later cleanup fails, but mark the overall test as failed. Authentication/authorization/observer failures are monitoring execution problems, not a claim that users cannot message.

The handler returns the shared result contract for per-run console diagnostics and cycle aggregation. Published results exclude internal token/cleanup observations and do not include target IDs, message bodies/IDs, service URLs, or credentials.

An ambiguous create response can leave an activity without a returned cleanup ID. POST is never automatically retried. Missing/malformed returned IDs produce an explicit cleanup failure, with no broad purge, Graph-ID substitution, or broad Graph search. Private cleanup status remains internal, not a published step or result field. Once IDs are known, DELETE is idempotently retryable and uses an independent ten-second cleanup budget even when the main attempt is cancelled. Cleanup failure cannot turn a preceding failure into success; after confirmed publication it changes the overall outcome to `cleanup-failure` while retaining measured timings.

## Validation and live acceptance

`npm test -- teams/tests/probe.test.ts` exercises the real Graph/Bot/HTTP clients with fake credentials, HTTP, and clock: payloads, token audience isolation, delayed readback, phase and step timing, timeout/cancellation, permission/throttling/unavailability, malformed/ambiguous sends, author/marker checks, unsafe URLs, bounded pagination, and cleanup outcomes. Named actions are also tested directly without the journey orchestrator. No live Microsoft 365 calls or permission grants are part of these tests.

Before switching from simulation to live mode, approve this coverage/resources and prove one authorized create/readback/delete sequence in the target tenant, including Graph author-ID mapping, certificate authentication, observed publication latency, and retention behavior. Then establish cleanup/reconciliation ownership, permitted volume/cadence, independent stopped/stalled-worker and broken-reporting detection, and end-to-end notification tests. There is currently **no successful live journey acceptance evidence**.

## Microsoft references

- [Proactive Teams messaging and installed-team requirement](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
- [Bot Connector REST create/send/delete operations](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-api-reference)
- [List channel messages: RSC read permission, supported queries, pagination](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0)
- [Get one channel message](https://learn.microsoft.com/en-us/graph/api/chatmessage-get?view=graph-rest-1.0)
- [Graph application identities](https://learn.microsoft.com/en-us/graph/api/resources/teamworkapplicationidentity?view=graph-rest-1.0)
- [Normal Graph channel-send permissions and service-use notes](https://learn.microsoft.com/en-us/graph/api/channel-post-messages?view=graph-rest-1.0)
- [Graph soft-delete permissions](https://learn.microsoft.com/en-us/graph/api/chatmessage-softdelete?view=graph-rest-1.0)
- [Teams resource-specific consent catalog](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
