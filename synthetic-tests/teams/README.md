# Teams bot API journeys

**Default: `teamsAuthentication: "bot"`, `botAuthentication: "managed-identity"`.**
The worker publishes and replies as an installed bot using its explicitly selected
same-tenant user-assigned managed identity. No user sign-in, MFA, delegated token cache
or refresh-token maintenance is required. This is **bot API coverage**, not employee
sign-in, browser/UI testing, a read receipt or human-to-human delivery.
**Calling uses two distinct managed-identity bots joining one dedicated meeting,
not direct application-to-application P2P or calls to people.** No human answer,
sign-in or MFA is involved. This architecture and its measurements are source-tested,
not live media acceptance; rollout and ingestion verification remain operator gates.
Calling requires both established legs, both bot identities in both participant
rosters, authenticated completion of an original test tone, and verified departure
of both owned legs. **Playback completed does not prove the peer received/heard it**,
bidirectional audio, microphone/speaker quality, employee
identity, or the full meeting experience.
Simulation remains credential-free. Source tests use fake HTTP; each deployment must
verify real posting, authorship, readback, cleanup and report ingestion. See the
[recorded live baseline](../../docs/deployment.md#deployment-status-and-order) separately
from these reusable setup instructions.

## Target catalog versus current implementation

The target is **five complete journey families**, not five API calls. Only the
narrower messaging and service-hosted playback operations below are implemented.

| Target family | Completed-workflow target | Current implementation / live boundary |
| --- | --- | --- |
| Two-bot channel conversation | Bot A sends → Bot B receives → B replies → A receives the correlated response, plus persisted readback | One installed bot posts and replies; a separate Graph observer verifies persisted content and author. This narrower flow is live verified; **Bot B delivery/receipt is not implemented**. Future bot-to-bot permissions/scopes require validation. |
| Answered two-party audio | Bots connect; exchange known audio bidirectionally; verify continuity, delay and distortion; hang up | Bounded two-bot meeting join → both-leg roster proof → primary service-hosted tone → authenticated correlated completion → both departures. No received-audio analysis or bidirectional quality claim; live media acceptance pending. |
| Scheduled meeting | Join scheduled meeting, verify roster, exchange bidirectional media, leave | Narrow two-bot join/roster/playback/departure is implemented under existing `call-test-user`; full meeting/bidirectional experience remains planned. |
| Recipient file sharing | Share file, retrieve as recipient identity, verify hash | Planned; not implemented; owner/observer readback would not prove recipient access |
| Adaptive Card workflow | Publish card, invoke action, verify workflow/callback completion | Planned; not implemented |

Current publication, reply and call scenarios run every **120 seconds** by default;
service config owns cadence/deadlines, root config owns scenario selection and
targets/accounts. Planned families have no implemented schedules. Optional
**TeamsWeb messaging and meeting browser variants** are planned, not implemented.
Bot APIs do not measure employee identity/client/UI experience. This prerecorded
service-hosted playback runs in the existing Node Container App; raw audio streams
and full bidirectional media testing would require a separate supported-host design.

## Primary setup: unattended bot

1. Deploy the foundation and identify the Teams worker UAMI. Register an approved
   same-tenant Azure Bot with **UserAssignedMSI** and that UAMI; enable Teams.
2. Register a separate same-tenant Entra application for Graph readback. Set the Teams
   manifest's `webApplicationInfo.id` to that application's client ID, **not the
   managed identity's ID**; keep `bots[].botId` as the Azure Bot's managed identity
   client ID. Request only installed-team `ChannelMessage.Read.Group` RSC.
   Add a federated identity credential to the readback application with issuer
   `https://login.microsoftonline.com/<tenant-id>/v2.0`, subject equal to the Teams
   worker UAMI's **principal/object ID**, and audience `api://AzureADTokenExchange`.
   Set service `teamsReadbackClientId` to the readback application's client ID.
   This uses the selected worker identity to obtain application Graph tokens without
   passwords, certificates or user tokens. Do not grant tenant-wide channel read.
   Publish the corrected Teams package and install it in the dedicated test team,
   approving its team-scoped RSC permission.
3. Configure one root target with `tenantId`, `teamId`, `channelId` and approved
   `serviceUrl` (public cloud: `https://smba.trafficmanager.net/teams/`). Bot targets
   represent channels, not three impersonated employee accounts.
4. Keep service-owned `teamsAuthentication: "bot"` and
   `botAuthentication: "managed-identity"`. Hosting supplies `BOT_TENANT_ID` and
   `BOT_CLIENT_ID` from the attached UAMI; no Teams serviceAccess credentials or
   user-cache storage are required. Set live opt-in only after approval and verify
   actual posting, Graph author/readback, cleanup and report ingestion.

`BOT_CLIENT_ID` explicitly selects `ManagedIdentityCredential` for
`https://api.botframework.com/.default`; it never falls back to `AZURE_CLIENT_ID`,
certificates, CLI, secrets or a user. Application Graph (`graphAuthentication`) and
ARM (`healthReportAuthentication`) remain independently selected.
With `teamsReadbackClientId`, only the bot journey's Graph observer uses the
federated application; Bot Connector, calling, health publication and optional
Service Health collection keep their existing identities. The option requires
Teams bot mode, managed-identity Graph authentication and matching Azure/bot tenants.
Failure to obtain the assertion or application token fails the journey; there is no
credential fallback.
The service file owns cadence, time budget and authentication; root selection owns
all target resources. Messaging alone needs no inbound server; selected live calling
adds only the authenticated Teams callback below. Other workers stay private.

### Reusable app identity mapping

Use these fields in a complete, schema-valid Teams app manifest, replacing all
placeholders. Add the required app metadata, version, developer URLs and icons
using the [Teams app package format](https://learn.microsoft.com/microsoftteams/platform/concepts/build-and-test/apps-package).
The bot's managed identity and the readback application's client ID are different:

```json
{
  "bots": [{
    "botId": "<bot-UAMI-client-ID>",
    "scopes": ["team"],
    "supportsCalling": true,
    "supportsVideo": false
  }],
  "webApplicationInfo": {
    "id": "<readback-Entra-application-client-ID>",
    "resource": "api://<readback-Entra-application-client-ID>"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [{
        "name": "ChannelMessage.Read.Group",
        "type": "Application"
      }]
    }
  }
}
```

Keep a one-to-one mapping between the Teams app and its readback Entra application.
The federated credential's `subject` is the worker UAMI's **principal/object ID**,
not either client ID. The service profile's `teamsReadbackClientId` matches
`webApplicationInfo.id`; hosted `BOT_CLIENT_ID` matches `bots[].botId`.
For a messaging-only app, omit calling capability and disable the root calling scenario.

Publish/install through approved operator tooling, not runtime administrator grants.
In Teams, select **Apps -> Built for your org -> your bot -> Add to a team**, choose
the root-configured team/channel and approve the RSC permission. Do not use **Add
member**: the bot is an app and needs no email address. Installation is a one-time
setup step, not an interactive dependency of scheduled workers.

### Installation errors

Add the bot as an **app to the team**, not as a member by email. Calls can succeed
without this installation; channel posting cannot. A Connector
`403 BotNotInConversationRoster` means the bot is not recognized in that
conversation's roster.

An installation error containing
`IsUserAuthorizedToGrantGroupResourceSpecificPermissionsRequest` can result from
putting a managed identity ID in `webApplicationInfo.id`: RSC requires an Entra
application registration. Correct the mapping before retrying installation; adding
more installation permissions does not fix a missing registration. See Microsoft's
[RSC registration requirements](https://learn.microsoft.com/microsoftteams/platform/graph-api/rsc/grant-resource-specific-consent)
and [managed-identity installation report](https://github.com/MicrosoftDocs/msteams-docs/issues/14285).

## Journey and measurement contracts

All three root scenarios are enabled by default:

- `publish-channel-message` / `teams-global`: `post-message`, `confirm-publication`.
- `reply-channel-message` / `teams-reply`: `post-message`, `post-reply`, `confirm-reply`.
- `call-test-user` / `teams-call`: `place-call`, `wait-for-answer`, `play-audio`, `end-call`.

## Two-bot meeting audio setup

The stable scenario `call-test-user` and entity `teams-call` are retained solely for
deployed ID continuity. Every selected root `services.teams.callTargets[]` is now
`{ id, tenantId, meetingThreadId, organizerUserId, peerBotClientId }`.
The sample contains one placeholder dedicated meeting in simulation. The organizer
UUID is **directory meeting-owner metadata only**, never a participant, call
target or token identity. `callUserId` and human-calling compatibility are rejected.

1. An operator provisions a dedicated meeting with exact thread/owner/tenant
   metadata and policies allowing the two approved bots to join without humans.
   There is no runtime meeting creation or directory lookup.
2. Register both approved UAMIs as Azure Bots, enable Teams/calling on both, and
   approve application **`Calls.JoinGroupCall.All` on both bot identities**.
   This permission is not an Entra-enforced per-meeting scope; root validation is
   a runtime allowlist. No runtime role grants, `Calls.Initiate.All`,
   `Calls.AccessMedia.All`, delegated user tokens or `OnlineMeetings.*` are needed
   by this join-only implementation. Channel readback/RSC remains separate.
3. Supply `serviceAccess.teams.botPeerClientId` and
   `botPeerManagedIdentityResourceId` to deployment preparation, referencing the
   **existing** approved peer UAMI. Infrastructure attaches it to the existing
   Teams Container App only when live calling is selected. It does not create the
   peer or grant Graph permissions. All root `peerBotClientId` values must match.
4. Primary `BOT_CLIENT_ID` remains the existing explicit worker UAMI.
   `TEAMS_CALLING_PEER_CLIENT_ID` selects a different
   `ManagedIdentityCredential({ clientId: peerId })`; `AZURE_TENANT_ID`,
   `BOT_TENANT_ID` and target tenant must match. Neither leg falls back to another
   identity, CLI, certificate or user. Calling is independent of optional delegated
   **message** authentication and never uses it.
5. Configure service `teamsCallingCallbackUrl: "https://<teams-worker-fqdn>/api/calls"`,
   port **8080**, and `teamsCallingPlaybackEnabled: true` only after approval.
   Both Azure Bots use that same public callback. Deploy the model before the
   matching image, then verify real joins, roster identities, playback callbacks,
   both departures and report ingestion. One replica and static `/healthz` readiness
   are unchanged. Other workers/disabled calling receive no peer or public server.

Both explicit bot credentials use the fixed documented scope
`https://graph.microsoft.com/.default`, with no audience aliases or runtime fallback.
Connector/observer/reporting identities remain independently selected.
Each bot independently POSTs `/communications/calls` once per selected meeting,
using the [official scheduled-meeting service-hosted join example (5)](https://learn.microsoft.com/graph/api/application-post-calls?view=graph-rest-1.0#example-5-join-scheduled-meeting-with-service-hosted-media):

```json
{
  "@odata.type": "#microsoft.graph.call",
  "callbackUri": "https://<teams-worker-fqdn>/api/calls",
  "chatInfo": { "threadId": "<root-meetingThreadId>", "messageId": "0" },
  "meetingInfo": {
    "@odata.type": "#microsoft.graph.organizerMeetingInfo",
    "organizer": { "user": { "id": "<root-organizerUserId>", "tenantId": "<root-tenantId>" } },
    "allowConversationWithoutHost": true
  },
  "tenantId": "<root-tenantId>",
  "requestedModalities": ["audio"],
  "mediaConfig": { "@odata.type": "#microsoft.graph.serviceHostedMediaConfig" }
}
```

### Explicit playback opt-in (intentional behavior change)

Set service `teamsCallingPlaybackEnabled: true` only after approving bot meeting joins
and test-tone playback to **every selected root meeting**. The checked-in
simulation and live-example profiles default this gate to false. Selected live calls
fail configuration without approval; they never fall back to the old signaling-only
success. Root `call-test-user`, `teams-call`, `place-call` and `end-call` IDs remain.
The obsolete wait step/config are removed, not retained as compatibility behavior.

### Call measurements on the existing entity

The `teams-call` journey retains its identity and business-step children.
Its **External Reports** group additionally declares these aggregated signals:

| Measurement | Signal suffix after `teams-call-` | Unit |
| --- | --- | --- |
| Connected attempts / executed connection attempts | `connection-success-percentage` | Percent |
| Call submission plus establishment elapsed time | `mean-connection-duration` | Milliseconds |
| Completed playback / executed playback attempts | `playback-success-percentage` | Percent |
| Playback request through verified completion or failure | `mean-playback-duration` | Milliseconds |
| Verified departure / executed departure attempts | `disconnection-success-percentage` | Percent |
| Departure request through termination confirmation or failure | `mean-disconnection-duration` | Milliseconds |

Skipped actions are not failed requests or zero-duration samples. Reports include
sample counts, timestamps, returned call-chain identifiers and sanitized numeric
service codes. These measure service-confirmed operations, not received audio.
Existing success/latency policy evaluates these immediate signals.

Optional service-owned `teamsCallQuality` defaults to
`{ "enabled": false, "maxWaitSeconds": 30, "pollIntervalSeconds": 5 }`.
**Quality remains disabled by default.** The current lab has separately approved
tenant-wide `CallRecords.Read.All` on the primary only; an operator may enable the
private live profile after that grant. This is broad tenant read access, **not**
native per-bot/per-meeting scoping. Other deployments need independent approval;
runtime
retrieval is restricted to actual returned `callChainId` values, never discovery
of employee calls. No permission is automatically granted.

After publishing journey results, the worker independently enriches those known
calls using `GET /communications/callRecords/{callChainId}?$expand=sessions($expand=segments)`.
Both returned leg chain IDs are captured; equal conference IDs are deduplicated,
including repeated targets, so one conference is not counted twice. Both IDs, when
present, must agree before playback; no tenant-wide listing or scan is used.
The post-call wait is bounded to 1–60 seconds and does not enter journey duration
or change its binary result. A 404 is pending; permission/read errors are explicit.
Missing call-chain IDs, absent fields and incomplete/paginated records are not
treated as measured zeros. Records arriving after this bounded window need later
collection; there is deliberately no cross-cycle memory queue, durable retry
store or tenant-wide discovery. Eventual delivery is **not** guaranteed by this
initial bounded enrichment.

Quality signals use the `teams-call-quality-` prefix:
`packet-loss`, `max-packet-loss`, `jitter`, `max-jitter`, `round-trip-time`,
`max-round-trip-time`, `audio-degradation`, `concealed-samples` and
`max-concealed-samples`. Reports include per-metric stream sample counts, source
start/end times, collection time, record versions, codecs and stream directions.
Means are unweighted means of observed stream averages; maxima are observed stream
maxima. Audio degradation is network-related MOS **degradation**, not absolute MOS.
Quality-field availability for service-hosted bot calls still needs live proof.

Root `healthModel.callQualityThresholds` defaults to `{}`: quality values are
diagnostic/Unknown and do not manufacture Healthy evidence. Optional metric keys
are `packetLossPercent`, `maxPacketLossPercent`, `jitterMs`, `maxJitterMs`,
`roundTripTimeMs`, `maxRoundTripTimeMs`, `audioDegradation`,
`concealedSamplesPercent`, and `maxConcealedSamplesPercent`, each accepting
`{ "degradedAbove": number, "unhealthyAbove": number }`.
Evaluation requires complete observed samples; partial or missing data stays Unknown.
Quality-only reports never republish or overwrite synthetic success/duration.

Console diagnostics are always emitted. Existing optional root OTEL export adds
call-phase histograms and quality snapshot gauges/logs without per-target metric
dimensions. It remains off by default. Entity reports expire using the existing
TTL and are not a historical time-series store.

### Playback and teardown mechanics

`place-call` requires two distinct independently owned call IDs. `wait-for-answer`
polls GET on **both** until `established`; merely waiting is never success.
`verify-participants` GETs `/communications/calls/{owned-id}/participants` from
**each** leg, requiring both expected `info.identity.application.id` values as
distinct participants with `isInLobby: false`. Empty, wrong, partial/paginated,
oversized (>200), malformed or user-only rosters cannot authorize playback.
Roster membership proves meeting co-presence, **not received audio**.
Early termination, missing/mismatched calls, numeric Graph failures and cancellation
fail honestly. No human answer is expected or requested.

`play-audio` POSTs `/communications/calls/{owned-id}/playPrompt` once with
`clientContext` equal to the attempt correlation UUID and one `mediaPrompt`:
`mediaInfo.uri` is the **same configured callback HTTPS origin** plus
`/media/test-tone.wav`; `resourceId` identifies this fixed tone. There is no external
URL, placeholder-audio fallback, storage account or additional permission.
The exact public GET route returns an original generated one-second 440-Hz WAV:
**mono, 16-bit PCM, 16,000 Hz**, 32,044 bytes, `Content-Type: audio/wav` and exact
`Content-Length`. Other media paths/methods/query strings return 404. No arbitrary
file reads, uploads, recording or user media are involved.

The 200 response supplies the actual `playPromptOperation.id`, status and matching
`clientContext`. Acceptance, `running`, or even a response-only `completed` does
**not** satisfy this journey. Completion must arrive through the authenticated
Graph callback with `resourceUrl` and `resourceData.@odata.id` identifying this
same call **and actual operation**, matching `clientContext`,
`@odata.type: #microsoft.graph.playPromptOperation`, and `status: completed`.
Failed operations/service codes fail; unrelated/malformed notifications do nothing.
The documented uppercase/compact GUID notification form is normalized, without
loosening other IDs or paths. GET call checks continue while waiting; termination
during playback fails. No invented GET-operation endpoint or synthetic self-callback
is used.

An in-memory registration exists only for each pending playback, before POST so a
callback racing the response can be correlated after binding the returned ID.
It is disposed in `finally`, expires within its playback deadline (maximum 120 s),
and caps at 32 registrations with four pre-response observations each. Unknown
operations are never cached; no call history or state survives cycles/restarts.

`teams-call-state-observed` logs allowlisted GET state transitions and numeric
`resultCode`/`resultSubcode` when Graph supplies `resultInfo`, with the test alias,
correlation and elapsed time. Repeated identical samples are suppressed, with at
most 24 events per attempt, labeled primary/peer. Result messages, call IDs, response bodies, target
identities and tokens are never logged. `teams-calling-callback-rejected` reports
only HTTP status and stage (`headers`, `verification`, `body`, `timeout`, `handler`),
plus allowlisted `authErrorCode`, `authClaim` and `authReason` for verification
failures. Messages, tokens, payloads and claim values are never included.
Rejections and accepted-callback diagnostics are each capped at ten per minute.
Accepted events report only `authentication: "verified"` and `tenantMatched: true`.
`teams-call-playback-observed` adds the actual returned operation ID, attempt
correlation, allowlisted status and optional numeric result code.
`teams-call-tone-served` reports only fixed byte count/sample rate (at most ten per
minute); an HTTP fetch alone is not proof Graph accepted the media.
Terminal-state failure without an HTTP status is a signaling outcome, not proof
of Graph HTTP failure. Inspect numeric results and bot/meeting policies rather than
inferring a tenant outage from elapsed time alone.

`teamsCallingAnswerTimeoutSeconds` defaults to **20** (1–30);
`teamsCallingPlaybackTimeoutSeconds` defaults to **10** (2–30), including POST and
callback completion. The default **45-second execution budget**, recurring every
**120 seconds**, must allow both budgets plus five seconds for other requests.
The answer deadline also reserves the playback budget; authentication/Graph delays
cannot extend the overall bound. Each phase has an abort deadline. Service files
remain authoritative; runtime fields are `TEAMS_CALLING_PLAYBACK_ENABLED`,
`TEAMS_CALLING_ANSWER_TIMEOUT_SECONDS`, and
`TEAMS_CALLING_PLAYBACK_TIMEOUT_SECONDS`. Old `teamsCallingWaitSeconds`,
`teamsCallingRingSeconds` and corresponding runtime settings are rejected.
`end-call` DELETEs only the
returned IDs and polls GET for `terminated`/404, not just DELETE acceptance.
Selected meetings produce attempts aggregated into **one `teams-call` journey** and
five shared business-step entities, never per-participant signals. Console diagnostics use
the configured test alias/correlation ID, not account IDs, tokens or notification bodies.

Run one bounded cycle of the **same active root and service files**:
`node dist/teams/src/worker.js --once --project-config /etc/probe/monitoring.config.json --config /etc/probe/service.json`.
This is the ordinary worker entrypoint; do not launch a second copy beside a running
calling worker because both would bind the callback port and could duplicate calls.
Recurring mode uses the same command without `--once`. Root targets are never replaced
by an alternate trial profile.

**Call departure is never disabled by `teamsCleanupEnabled: false`.** Once creation
returns a known ID, `end-call` is attempted and measured even when waiting failed or
the execution signal was cancelled. Successful teardown never repairs failed answer
or playback.
End-call failure remains a failed business action even if fallback cleanup succeeds.
Both legs receive concurrent independent four-second business teardown attempts,
then independent five-second fallback attempts for only the remaining legs.
One failed peer join/teardown never suppresses primary cleanup. Execution timeout
does not cancel teardown. `teams-call-disconnected` labels the leg and
`phase: "end"` or `"cleanup"` after
GET termination/404 proof. Unknown POST outcomes cannot safely be
reconciled: diagnostics expose `teams-call-unknown-creation-outcome`; an orphaned
leg may need approved operator intervention. State is not persisted between cycles.

POST `/api/calls` requires Microsoft-signed JWTs using the canonical
`https://api.aps.skype.com/v1/.well-known/OpenIdConfiguration` and its validated
`https://api.aps.skype.com/v1/keys` JWKS—not Entra discovery. Only RS256,
`iss` exactly `https://graph.microsoft.com` or `https://api.botframework.com`,
`aud` exactly one string from the explicit two-bot audience allowlist
(`BOT_CLIENT_ID`, `TEAMS_CALLING_PEER_CLIENT_ID`), required valid `exp`, and valid `nbf` when
present (never later than `exp`) are accepted. A signed tenant claim is mandatory:
raw `tid` or `http://schemas.microsoft.com/identity/claims/tenantid` must be a UUID
matching `BOT_TENANT_ID`. If both are supplied, **both must match**; missing,
malformed or conflicting aliases fail closed. This mirrors the canonical .NET
sample's inbound `tid`→URI claim mapping; `jose` does not perform that mapping
automatically. Normalization occurs only after signature, issuer, audience and
lifetime validation. There is no unsigned-claim trust or tenant fallback.
Discovery refreshes hourly, keys cache ten minutes with a 30-second refresh
cooldown; metadata requests have two-second deadlines and a 128-KiB cap.
Callbacks have bounded headers/body/time, authenticate before JSON acknowledgement
and never log payloads, identities or tokens. A static
`teams-calling-callback-accepted` diagnostic proves callback receipt separately.
Only strongly correlated operation notifications affect pending playback; they
never select outgoing meetings/participants or initiate calls.
Invalid tokens fail closed.

**Limits and live acceptance:** Graph signaling is not proof of a visible device/UI
notification, employee sign-in or real-user experience. Human observation of incoming
calls and hearing the tone are separate evidence, never inferred from a Healthy
Graph playback report.
Real managed-identity API execution/report ingestion remains a separate cloud
acceptance check, not a claim made by source tests. Live acceptance must verify
Graph retrieval/format acceptance through actual completed playback, authenticated
operation evidence, disconnection and ingested reports. A curl of the tone alone
does not prove playback. Human answer/observation must be arranged separately.
Continuously verifying employee client state/UI is not implemented.

References: [official scheduled-meeting join, example 5](https://learn.microsoft.com/graph/api/application-post-calls?view=graph-rest-1.0#example-5-join-scheduled-meeting-with-service-hosted-media),
[get call](https://learn.microsoft.com/graph/api/call-get?view=graph-rest-1.0),
[delete call](https://learn.microsoft.com/graph/api/call-delete?view=graph-rest-1.0),
[playPrompt and documented completion notification](https://learn.microsoft.com/graph/api/call-playprompt?view=graph-rest-1.0),
[playPromptOperation schema](https://learn.microsoft.com/graph/api/resources/playpromptoperation?view=graph-rest-1.0),
[required WAV format](https://learn.microsoft.com/graph/api/resources/mediainfo?view=graph-rest-1.0),
[canonical notification authentication sample](https://github.com/microsoftgraph/microsoft-graph-comms-samples/blob/master/Samples/Common/Sample.Common/Authentication/AuthenticationProvider.cs),
[Microsoft inbound claim mapping](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.JsonWebTokens/ClaimTypeMapping.cs),
[Microsoft lifetime validation](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/ValidatorUtilities.cs).

## Message measurement contracts

The reply journey creates its own correlated parent and reply. Bot readback requires
the exact marker, expected application author and nondeleted state; Connector
activity IDs are not assumed to be Graph IDs. Opt-in delegated readback also requires
the exact created Graph ID and authenticated user object ID. Every POST is attempted once: uncertain creation
is never retried or reconciled into permission to delete some other message.
Bot collection reads accept matching evidence on the current page before inspecting
unused continuation metadata. If another page is needed, its continuation must pass
the same-origin, exact-collection and bounded-query checks before any request; scans
remain limited to five pages of 50 messages. Continuation URLs are bounded to 8,192
characters; opaque tokens have no smaller arbitrary limit. Live Graph responses
have returned valid 5,508-character tokens.

Internal authentication/cleanup remain unreported as business steps. Skipped actions
are not failed requests. Each complete attempt contributes binary success (1/0),
total duration and separate executed-action timings; send/publication contracts and
entity IDs are unchanged. Cleanup failure makes the journey unhealthy without
rewriting successful business-action results. Only auth state persists across cycles.
Each root target contributes one independent attempt per scenario, not an extra
signal inventory. The default placeholder represents one bot channel.

## Optional delegated Graph contract

Explicitly select `teamsAuthentication: "user-delegated"` and follow the
[public-client, protected cache and human bootstrap guide](../../docs/teams-user-bootstrap.md).
Both journeys run for every configured user with isolated clients/cache partitions.
This optional mode can require human MFA/reauthentication; choose bot mode for
unattended operation without user refresh tokens. Providers never borrow user tokens.

Base: `https://graph.microsoft.com/v1.0`. Use a dedicated standard channel in a
dedicated test team with the approved licensed test user as member/owner.

| Action | Endpoint | Delegated scope |
| --- | --- | --- |
| Publish | `POST /teams/{team}/channels/{channel}/messages` | `ChannelMessage.Send` |
| Reply | `POST /teams/{team}/channels/{channel}/messages/{parent}/replies` | `ChannelMessage.Send` |
| Readback | `GET /teams/{team}/channels/{channel}/messages/{parent}` and `/{parent}/replies/{reply}` | `ChannelMessage.Read.All` |
| Cleanup | `POST /teams/{team}/channels/{channel}/messages/{parent}/replies/{reply}/softDelete`, then `/{parent}/softDelete` | `ChannelMessage.ReadWrite` |

Each body is `{ "body": { "contentType": "text", "content": "<unique synthetic marker>" } }`.
The create response's `from.user.id` must match the authenticated account; subsequent
readback verifies the same author independently. Delegated readback polls only the
exact POST-returned IDs, validating parent and reply independently; it never scans
unrelated channel content or follows collection next links. A not-yet-visible ID
(404) can be polled again within the journey deadline; other HTTP/schema failures
are not hidden by a collection fallback. Bot mode retains bounded collection scans
(five validated pages per scan), accepting Graph's literal `:`/`@` channel-ID encoding
without allowing cross-origin, cross-channel or path-boundary changes.
Cleanup uses only verified owned IDs,
expects HTTP 204, and checks GET for `deletedDateTime` or 404 (up to three reads).
Soft deletion is **not permanent deletion**; retention/eDiscovery still applies.
Unknown POST outcomes can leave orphaned test content requiring operator cleanup.

First-party API contracts: [send](https://learn.microsoft.com/graph/api/channel-post-messages?view=graph-rest-1.0),
[reply](https://learn.microsoft.com/graph/api/chatmessage-post-replies?view=graph-rest-1.0),
[get message/reply](https://learn.microsoft.com/graph/api/chatmessage-get?view=graph-rest-1.0),
[list messages (bot)](https://learn.microsoft.com/graph/api/channel-list-messages?view=graph-rest-1.0),
[list replies](https://learn.microsoft.com/graph/api/chatmessage-list-replies?view=graph-rest-1.0),
[softDelete](https://learn.microsoft.com/graph/api/chatmessage-softdelete?view=graph-rest-1.0).
Runtime receives no team-creation or administrative provisioning permissions.

## Delegated authentication and failure semantics

The worker never signs in interactively, uses a password, or falls back to a bot.
It reloads the target account's encrypted-at-rest Blob MSAL cache and calls `acquireTokenSilent`.
Missing/empty cache, wrong account/tenant, invalid refresh grant, interaction/MFA/
consent requirements yield `reauthentication-required`. Storage/lease/concurrency
failures and Graph claims/401 challenges are monitoring `authentication-failure`;
permission errors remain distinct. None establish a Teams outage.
Bootstrap or re-bootstrap can recover on a later cycle without restarting the worker.
Bootstrap each account separately; `--user-principal-name` is required when the root
selects multiple accounts. Account partitions keep one user's bootstrap/refresh from
overwriting another's cache. Existing valid User1 legacy cache remains compatible.
The cache has no local-disk copy; neither tokens nor cache contents enter logs,
health reports, ordinary configs, image layers or deployment parameters.

## Temporarily retain messages for inspection

Set **`"teamsCleanupEnabled": false` in the active Teams service config file**,
not in root targets or the access/identity file. It defaults to `true`; both checked-in
Teams profiles retain that default. Restart/redeploy the worker to load the change;
hosted service-config changes roll a new revision through the existing config hash.
The same setting covers both scenarios, every selected target, default bot mode and
optional delegated mode.

When false, the worker makes **no cleanup/delete or cleanup-reconciliation requests**,
including after failed or ambiguous business operations. Correct-author correlated
readback remains mandatory; retention never turns a failed action into success.
Internal cleanup is `skipped` with reason `cleanup-disabled`, not executed success,
and `cleanupSucceeded` is absent. The explicit console event `teams-cleanup-disabled`
includes `mutationAttempted` and execution mode; `mutationAttempted: false` means no post was attempted,
not that content was retained. Cleanup remains excluded from business-step entities
and published step observations. Simulation emits the same intention with
`mutationAttempted: false` and never creates real messages.

**Use only for a short approved inspection window in the dedicated test channel.**
With one bot channel and both successful journeys, each cycle retains **two root posts
and one reply**—90 messages/hour at the default 120-second cadence. Opt-in three-user
coverage retains six root posts and three replies per cycle (270/hour). Failed or
uncertain operations may also leave content. Respect channel growth, tenant
retention/eDiscovery and Microsoft's restrictions on using Teams as a log sink.
Success in this mode proves publication/readback, **not deletion**.

Restore **`"teamsCleanupEnabled": true`** and restart/redeploy when inspection is
finished. This restores normal owned reply-before-parent cleanup **for new attempts
only**; there is no retroactive sweep, retained-ID inventory or automatic deletion
of earlier messages. Handle earlier retained content separately through an approved
manual process. Normal Graph cleanup is soft deletion, not permanent erasure.

Use `npm run teams -- --once --project-config <root>` from `synthetic-tests/`, or
`node dist/teams/src/worker.js --once --project-config <root>` after building.
`--config` overrides only the service file, never root targets.

## Bot endpoint and observation contracts

The existing Connector and independently selected application Graph observer are reused:

- Root target additionally requires an approved `serviceUrl`:
  `https://smba.trafficmanager.net/{teams|amer|emea|apac}/`.
- Install the approved bot in the test team. Bot registration/channel/installation
  are approved administrator provisioning, not runtime operations. The worker
  infrastructure does not provision those resources.
- Bot Connector creates `/v3/conversations`, replies through
  `/v3/conversations/{conversation}/activities/{parent}`, and deletes known owned
  activities with `DELETE /v3/conversations/{conversation}/activities/{activity}`.
  Graph readback matches the expected application author; activity IDs are not
  assumed to be Graph message IDs.
- Observer uses `graphAuthentication: "managed-identity" | "certificate"` and
  approved channel read permissions (prefer installed-team
  `ChannelMessage.Read.Group` resource-specific consent); bot/observer/targets must share a tenant.
  Optional bot certificates require explicit `botAuthentication: "certificate"`,
  `BOT_TENANT_ID`, `BOT_CLIENT_ID`, `BOT_CLIENT_CERTIFICATE_PATH`, with no MI fallback.
  Hosted certificate access uses the separate `bot*` / `m365*` serviceAccess metadata
  described in the [access guide](../../docs/cross-tenant-access.md).

Bot coverage is not evidence of a user-delegated journey or employee authentication.

## Independent provider/report identities

`serviceHealth` and optional beta `serviceActivity` collectors always use separately
selected **application** Graph credentials (`graphAuthentication` MI/certificate),
never the delegated user token. Stable Service Health requires `ServiceHealth.Read.All`
and publishes impact-suppressed supporting context under the Teams Experience.
Beta activity additionally requires `ENABLE_BETA_SERVICE_ACTIVITY=true` and approved
`ServiceActivity-Teams.Read.All`; all five approved functions run in an independent
provider lane (default 300 seconds). Counts, QoE telemetry coverage and UDP percentage
remain diagnostic unless explicit customer thresholds publish suppressed Service Health
context; none is automatic call quality or journey evidence.
Provider failures do not change synthetic success, business steps or rollup.
Beta collection currently receives 403; missing/unauthorized observations never
become fabricated Healthy context. Provider lanes remain separate from user journeys.
ARM health reports independently use `healthReportAuthentication`, hosted UAMI.
See [provider setup, direct-report thresholds and exact functions](../../docs/provider-monitoring.md).
