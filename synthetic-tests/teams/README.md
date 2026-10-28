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
| `scheduled-meeting` → `teams-call` / `teams-call` | `place-call`, `wait-for-answer`, `verify-meeting-metadata`, `verify-participants`, `end-call` | Two distinct UAMIs join the same dedicated meeting. Both calls must establish, match the expected meeting metadata, show both bot identities in both rosters, and terminate. This tests **meeting connectivity**, not received audio or media quality. |

The meeting journey proves join, meeting metadata, both rosters and departure only.
It uploads, plays and records no audio, and meeting connectivity does not prove
received audio, bidirectional audio or call quality, or test microphones, speakers,
employee identity or clients.

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
   Name the UAMI in `worker.identity` and the bot in `access.bot`.
2. Register a separate same-tenant Entra application for Graph readback. In the
   Teams manifest, `webApplicationInfo.id` is **that application's client ID**;
   `bots[].botId` is the bot UAMI's client ID. Request only installed-team
   application RSC `ChannelMessage.Read.Group`; approve it by installing the app
   in the dedicated team. Do not substitute tenant-wide channel read.
3. Add a federated credential to the readback application: issuer
   `https://login.microsoftonline.com/<tenant>/v2.0`, subject equal to the worker
   UAMI's **principal/object ID**, audience `api://AzureADTokenExchange`.
   Set `execution.teamsReadbackClientId` to the readback application's client ID.
4. Keep `teamsAuthentication: "bot"`, `botAuthentication: "managed-identity"` and
   `graphAuthentication: "managed-identity"` in `execution`. Hosting supplies explicit
   `BOT_CLIENT_ID`, `BOT_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`.
   The bot/observer/target tenants must match. No certificate/user/CLI fallback
   is attempted.
5. Configure `tenants[].services.teams.targets[]` with `id`, `teamId` and, optionally,
   `channelName`; `tenantId` defaults to the tenant's and `serviceUrl` to
   `https://smba.trafficmanager.net/teams/`. `npm run setup` finds the standard
   channel with that name in the team (creating it if missing) and writes its ID to
   `.env` (`<TENANT>__<TARGET>__CHANNEL_ID`, filled in as `channelId`); leave
   `channelId` out of the config. The runtime ignores `channelName`. Setup also adds the
   accounts of every [group](../../docs/monitoring-groups.md) that lists the target to
   the team: that is team membership only, and the journeys stay bot-only. It creates
   no meetings and no chats (no journey uses chats), and it does not register or
   install the bots ([setup](../../docs/deployment.md#set-up-microsoft-365-with-one-script)).
   Set `serviceUrl` only for another region; public-cloud service URLs are restricted to
   `https://smba.trafficmanager.net/{teams|amer|emea|apac}/`.

Bot Connector uses `https://api.botframework.com/.default`. Graph readback
uses `https://graph.microsoft.com/.default` through the federated application;
calling remains on the bot UAMIs. Azure reports use the reporting UAMI and ARM
audience. Provider access separately uses the tenant's `providerClientId`.

## Two-bot meeting setup

1. Supply an existing dedicated meeting with compatible lobby/organizer policy.
   Neither the runtime nor `npm run setup` creates meetings or authenticates the organizer.
2. Use two distinct same-tenant Azure Bot UAMIs. Separately approve Graph
   application `Calls.JoinGroupCall.All` on **both**. This is not a per-meeting
   permission; the root meeting allowlist is a runtime safeguard.
3. `tenants[].services.teams.callTargets[]` contains `{ id, meetingThreadId, organizer }`.
   `meetingThreadId` has the form `19:meeting_...@thread.v2`; `organizer` is the
   organizer's user principal name. `npm run setup` looks up that user's ID into `.env`
   (`<TENANT>__<CALLTARGET>__ORGANIZER_USER_ID`, filled in as `organizerUserId`); only
   setup reads `organizer`. The organizer is ownership metadata, not a synthetic
   participant. `tenantId` defaults to the tenant's and `peerBotClientId` to the peer
   bot's client ID.
4. Name the approved peer's UAMI in `access.peerIdentity` and the two bot registrations
   in `access.bot` and `access.peerBot` (a bare name in the health model's resource
   group, or a full `/subscriptions/...` resource ID elsewhere:
   [names](../../docs/deployment.md#what-the-config-holds)). `npm run setup` looks up
   the peer's client ID with `az identity show` into `.env`
   (`<TENANT>__TEAMS__BOT_PEER_CLIENT_ID`, filled in as `access.botPeerClientId`).
   The template attaches this existing UAMI; it creates no peer or Graph grant.
   `TEAMS_CALLING_PEER_CLIENT_ID` must match every selected call target's peer.
5. Register both bots' calling channels against the same public HTTPS `/api/calls`
   callback on the existing Teams app:
   `https://<Teams worker appName>.<environment default domain>/api/calls`.
   `npm run setup` finds the default domain (`az containerapp env show`, so the
   foundation's environment must exist) and writes the URL to `.env`
   (`<TENANT>__TEAMS__CALLING_CALLBACK_URL`, filled in as
   `execution.teamsCallingCallbackUrl`); the port is 8080. Only selected live scheduled
   meetings enable public ingress; `/healthz` is static readiness, not journey progress.
6. The default establishment budget is 20 seconds. The probe timeout must allow
   that budget plus five seconds for requests; cleanup is independently bounded.
   The journey involves no audio upload, playback or recording. Message-retention
   settings cannot disable call termination.

The Teams service block then names its resources and holds only the IDs of the readback
application, the team and the meeting (other `execution` settings omitted):

```json
"teams": {
  "execution": { "teamsReadbackClientId": "<readback application client ID>" },
  "worker": { "appName": "m365-ctbcoa-teams", "identity": "uami-m365-experience-consto-teams" },
  "access": {
    "bot": "bot-m365-consto", "peerBot": "ahm-m365-consto-peer",
    "peerIdentity": "uami-m365-experience-consto-teams-peer"
  },
  "targets": [{ "id": "teams-probe-001", "teamId": "<team ID>", "channelName": "General" }],
  "callTargets": [{
    "id": "teams-bot-meeting-001", "meetingThreadId": "19:meeting_...@thread.v2",
    "organizer": "organizer@example.invalid"
  }]
}
```

Join bodies include the configured tenant both at top level and at
`meetingInfo.organizer.user.tenantId`. Every owned call is checked against the
thread, organizer and tenant; both rosters must show distinct bot participants
outside the lobby. Mere call creation, ringing or partial rosters are not success.

## Exact endpoints and completion rules

| Interface | Operations |
| --- | --- |
| Bot Connector | `POST {serviceUrl}v3/conversations` creates the root; `POST .../conversations/{conversation}/activities/{rootActivity}` creates its reply; `DELETE .../activities/{ownedActivity}` removes owned reply/root. |
| Graph v1.0 messaging | `GET /teams/{team}/channels/{channel}/messages`, then `GET .../messages/{confirmedGraphRootId}/replies`; each match requires exact application author, correlation marker and nondeleted state. |
| Graph v1.0 calls | `POST /communications/calls` joins once per bot; `GET .../{ownedCallId}` verifies state/metadata; `GET .../{ownedCallId}/participants` verifies both rosters; `DELETE .../{ownedCallId}` and subsequent state/404 verify departure. |
| Calling callback | `POST /api/calls` accepts only authenticated signed notifications with approved tenant/audience/issuer and bounded bodies. Callback acknowledgement alone is not meeting completion evidence. |

Message collection scans are bounded to five pages of 50 and the exact approved
Graph origin/path/query. Root and reply IDs returned by Bot Connector are used
only for their own cleanup, never substituted with Graph IDs.
A valid no-match scan is retried from the first page until the delivery deadline,
so a stale initial Graph collection snapshot does not become a read failure.
No match is ever treated as publication or reply evidence.
An ambiguous mutation is not retried or treated as successfully cleaned merely
because the root was deleted. Known reply and root cleanup are attempted
independently on a fresh bounded signal.

`teamsCleanupEnabled` defaults true. Explicit false retains bot posts/replies
for inspection; skipped generic cleanup is not a failed business request.
Failures to remove owned artifacts fail the overall journey without erasing
earlier measured success.

Successful call creation or callback acknowledgement cannot replace verified
establishment, metadata, both rosters and both departures.
Each returned owned call ID is emitted immediately in `teams-call-created`
diagnostics and again only after verified departure in `teams-call-disconnected`.
Ambiguous creation remains an explicit cleanup failure; the runtime never retries
creation, guesses a call ID or enumerates tenant calls to find it.

## Call measurements

The `teams-call` entity carries four immediate call measurements: connection and
disconnection success percentages and mean durations (connection duration includes
join submission). These are
connectivity measurements; the project collects no audio or call-quality data.

## Run

From `synthetic-tests/`:

```sh
npm run teams -- --once
```

Add `--tenant <id>` when the config has several tenants. A service in `simulation`
mode is labeled and makes no live calls. Real execution additionally requires `execution.mode: "live"`,
`deployment.enableLiveProbes: true` for hosted workers (`ENABLE_LIVE_M365=true` for a
local run) and the approved report destination.
Validate full root **and** reply evidence, both call legs, cleanup and actual
ingestion—not just token acquisition or a ready revision.

The config accepts only `channel-conversation` and `scheduled-meeting`; peer metadata
belongs only in `callTargets` and `access`. See [hosting](../infra/README.md) and
[operations acceptance](../../docs/operations.md#enterprise-reliability-acceptance-gate).
