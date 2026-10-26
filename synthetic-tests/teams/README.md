# Teams bot API journeys

Only two journeys are implemented. Participants are explicitly selected
managed-identity **bots**, never employee accounts. No delegated sign-in, MFA,
password, user token cache or human answer is required.
Source tests prove code behavior, not live authorization, media delivery or
ingestion; see [deployment evidence](../../docs/deployment.md#deployment-status-and-order).

## Journeys and evidence

| Root scenario → test type / entity | Required sequential business steps | Boundary |
| --- | --- | --- |
| `channel-conversation` → `teams-channel-message` / `teams-global` | `post-message`, `confirm-publication`, `post-reply`, `confirm-reply` | One selected bot posts the root and correlated thread reply. A separately authorized Graph observer verifies both persisted authors and markers. This is **not Bot B receipt**, employee messaging or UI experience. |
| `scheduled-meeting` → `teams-call` / `teams-call` | `place-call`, `wait-for-answer`, `verify-meeting-metadata`, `verify-participants`, `play-audio`, `end-call` | Two distinct UAMIs join the same dedicated meeting. Both calls must establish, match the expected meeting metadata, show both bot identities in both rosters, complete service-hosted playback via authenticated callbacks, and terminate. This is **not received-audio proof** or bidirectional media-quality verification. |

Internal token acquisition and compensating cleanup are not modeled steps.
Call departure remains a business step even after an earlier failure.
There is no separate reply journey, P2P media implementation, file-sharing
workflow, Adaptive Card interaction or always-failing capability assertion.

The checked-in Teams lane starts immediately and recurs every 120 seconds.
Its selected journeys execute concurrently; each retains independent results:

```json
"executionLanes": [
  { "name": "teams", "intervalSeconds": 120, "timeoutSeconds": 45,
    "journeys": ["channel-conversation", "scheduled-meeting"] }
]
```

Root scenario switches select execution; lane assignments remain complete even
when a scenario is disabled. Providers use an independent default 300-second lane.

## Primary setup: unattended bot

1. Identify the existing Teams worker UAMI. Register an approved same-tenant
   Azure Bot with `UserAssignedMSI` and that UAMI; enable its Teams channel and
   install the matching Teams app in the dedicated standard channel's team.
2. Register a separate same-tenant Entra application for Graph readback. In the
   Teams manifest, `webApplicationInfo.id` is **that application's client ID**;
   `bots[].botId` is the bot UAMI's client ID. Request only installed-team
   application RSC `ChannelMessage.Read.Group`; approve it by installing the app
   in the dedicated team. Do not substitute tenant-wide channel read.
3. Add a federated credential to the readback application: issuer
   `https://login.microsoftonline.com/<tenant>/v2.0`, subject equal to the worker
   UAMI's **principal/object ID**, audience `api://AzureADTokenExchange`.
   Set service `teamsReadbackClientId` to the readback application's client ID.
4. Keep `teamsAuthentication: "bot"`, `botAuthentication: "managed-identity"` and
   `graphAuthentication: "managed-identity"`. Hosting supplies explicit
   `BOT_CLIENT_ID`, `BOT_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`.
   The bot/observer/target tenants must match. No certificate/user/CLI fallback
   is attempted.
5. Configure root `services.teams.targets[]` with `id`, `tenantId`, `teamId`,
   `channelId`, `serviceUrl`. Public-cloud service URLs are restricted to
   `https://smba.trafficmanager.net/{teams|amer|emea|apac}/`.

Bot Connector uses `https://api.botframework.com/.default`. Graph readback
uses `https://graph.microsoft.com/.default` through the federated application;
calling remains on the bot UAMIs. Azure reports use the reporting UAMI and ARM
audience. Provider access can separately select `providerClientId`.

## Two-bot meeting audio setup

1. Supply an existing dedicated meeting with compatible lobby/organizer policy.
   The runtime does not create meetings or authenticate the organizer.
2. Use two distinct same-tenant Azure Bot UAMIs. Separately approve Graph
   application `Calls.JoinGroupCall.All` on **both**. This is not a per-meeting
   permission; the root meeting allowlist is a runtime safeguard.
3. Root `services.teams.callTargets[]` contains
   `{ id, tenantId, meetingThreadId, organizerUserId, peerBotClientId }`.
   `meetingThreadId` has the form `19:meeting_...@thread.v2`.
   The organizer ID is ownership metadata, not a synthetic participant.
4. Supply `serviceAccess.teams.botPeerClientId` and
   `serviceAccess.teams.botPeerManagedIdentityResourceId` for the approved peer.
   The template attaches this existing UAMI; it creates no peer or Graph grant.
   `TEAMS_CALLING_PEER_CLIENT_ID` must match every selected root peer.
5. Register both bots' calling channels against the same public HTTPS
   `/api/calls` callback on the existing Teams app. Configure service
   `teamsCallingCallbackUrl` and port 8080. Only selected live scheduled meetings
   enable public ingress; `/healthz` is static readiness, not journey progress.
6. Set `teamsCallingPlaybackEnabled: true` only with explicit playback approval.
   Defaults are a 20-second establishment budget and 10-second playback budget.
   The probe timeout must allow both plus five seconds; cleanup is independently
   bounded. Message-retention settings cannot disable call termination.

Join bodies include the configured tenant both at top level and at
`meetingInfo.organizer.user.tenantId`. Every owned call is checked against the
thread, organizer and tenant; both rosters must show distinct bot participants
outside the lobby. Mere call creation, ringing or partial rosters are not success.

## Exact endpoints and completion rules

| Interface | Operations |
| --- | --- |
| Bot Connector | `POST {serviceUrl}v3/conversations` creates the root; `POST .../conversations/{conversation}/activities/{rootActivity}` creates its reply; `DELETE .../activities/{ownedActivity}` removes owned reply/root. |
| Graph v1.0 messaging | `GET /teams/{team}/channels/{channel}/messages`, then `GET .../messages/{confirmedGraphRootId}/replies`; each match requires exact application author, correlation marker and nondeleted state. |
| Graph v1.0 calls | `POST /communications/calls` joins once per bot; `GET .../{ownedCallId}` verifies state/metadata; `GET .../{ownedCallId}/participants` verifies both rosters; `POST .../{ownedCallId}/playPrompt` submits a unique correlated operation; `DELETE .../{ownedCallId}` and subsequent state/404 verify departure. |
| Calling callback | `POST /api/calls` accepts only authenticated signed notifications with approved tenant/audience/issuer and bounded schema. Playback completion must match the owning bot's audience, owned call, returned operation ID and unique client context. |
| Test media | `GET /media/test-tone.wav` serves the original fixed test tone; a successful fetch alone is not playback completion. |

Message collection scans are bounded to five pages of 50 and the exact approved
Graph origin/path/query. Root and reply IDs returned by Bot Connector are used
only for their own cleanup, never substituted with Graph IDs.
An ambiguous mutation is not retried or treated as successfully cleaned merely
because the root was deleted. Known reply and root cleanup are attempted
independently on a fresh bounded signal.

`teamsCleanupEnabled` defaults true. Explicit false retains bot posts/replies
for inspection; skipped generic cleanup is not a failed business request.
Failures to remove owned artifacts fail the overall journey without erasing
earlier measured success.

Service-hosted `playPrompt` must complete on **both** legs through verified
callbacks. Neither callback completion nor roster presence proves that the peer
received/heard audio, or tests microphones, speakers, employee identity or clients.
Each returned owned call ID is emitted immediately in `teams-call-created`
diagnostics and again only after verified departure in `teams-call-disconnected`.
Ambiguous creation remains an explicit cleanup failure; the runtime never retries
creation, guesses a call ID or enumerates tenant calls to find it.

## Call measurements

The existing `teams-call` External Reports group contains:

- Connection, playback and disconnection success percentages and mean durations
  (six immediate measurements; connection duration includes join submission).
- Nine optional post-call metrics: packet loss/max packet loss, jitter/max
  jitter, round-trip/max round-trip time, audio degradation, concealed samples/
  max concealed samples.

`teamsCallQuality` defaults to disabled. Enabling it requires explicit approval
of **tenant-wide** `CallRecords.Read.All` on the primary bot. There is no
resource/identity-scoped equivalent in this implementation; known-call-ID
filtering does not narrow the tenant-enforced permission.
Collection performs bounded exact-ID reads of
`GET /communications/callRecords/{actualCallChainId}` and its sessions/segments,
never tenant enumeration or a subscription. Defaults are 30 seconds total and
five-second polling; delayed records can be missed because no cross-cycle queue
is retained. Missing/unavailable fields are not zero or Healthy. Root quality
thresholds are empty by default. Optional OTEL uses the same evidence.

## Run and migrate

From `synthetic-tests/`:

```sh
npm run teams -- --once
npm run teams -- --project-config /approved/path/monitoring.private.json --once
```

Checked-in mode is simulation. Real execution additionally requires
`ENABLE_LIVE_M365=true`, the approved live service file and report destination.
Validate full root **and** reply evidence, both call legs, cleanup and actual
ingestion—not just token acquisition or a ready revision.

Private profiles must use only `channel-conversation` and `scheduled-meeting`.
Remove obsolete scenario/lane assignments and user/file fields from channel
targets; peer metadata belongs only in `callTargets`/service access.
The stable test types and entities above are unchanged.
See [hosting](../infra/README.md) and
[operations acceptance](../../docs/operations.md#enterprise-reliability-acceptance-gate).
