# Teams bot API journeys

Only two journeys are implemented. Participants are explicitly selected
managed-identity **bots**, never employee accounts. No delegated sign-in, MFA,
password, user token cache or human answer is required.
Local source validation does not establish live authorization, media delivery or
ingestion; see [deployment evidence](../../docs/deployment.md#deployment-status-and-order).

Channel `targets[]` and meeting `callTargets[]` are ungrouped arrays. User groups
apply only to Exchange and OneDrive; Teams publishes its journey, step and
call-phase reports without user-group signals or telemetry labels.
For resource and reporting diagrams, see [architecture](../../docs/architecture.md).

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
Every configured `botPairs` entry runs the enabled journey against **every**
selected channel or meeting target. The checked-in two pairs therefore produce
four channel attempts and two meeting attempts per lane, without extra workers.
Channel attempts use that pair's primary; meeting attempts use both identities.
Attempt IDs are `<pair-id>--<target-id>` and logs include `Dimensions.botPairId`.
Execution is concurrent up to `execution.maxConcurrentProbes` per lane (default 3),
with sequential business steps and independent results:

```json
"executionLanes": [
  { "name": "teams", "intervalSeconds": 120, "timeoutSeconds": 45,
    "journeys": ["channel-conversation", "scheduled-meeting"] }
]
```

Root scenario switches select execution; lane assignments remain complete even
when a scenario is disabled. The lane has a 45-second per-attempt execution deadline;
timeouts count as unsuccessful attempts, not Unknown. Cleanup has its own bounded
signal and the runner allows 12 seconds for settlement. `cycleTimeoutSeconds`
defaults to 170; late slots are skipped without overlapping the same lane.
Providers use an independent default 300-second lane.

## Primary setup: unattended bot

Run npm commands from `synthetic-tests/`. Follow [`docs/setup.md`](../../docs/setup.md) as
an approved administrator: it creates missing named foundation resources/identities and
configures bots, roles, federation and the app package, all by hand. It does not create the
readback application (step 2 below) — administrators create that outside this project.
Keep the root foundation mode `"existing"`; missing bare-name foundation resources can
still be created.

1. Name the approved same-tenant worker UAMI in `worker.identity`. In each
   `botPairs[]` entry, name its `id`, primary `bot` and `identity`, and `peerBot`
   and `peerIdentity`. Provision two distinct UAMIs and `UserAssignedMSI` Azure Bot
   registrations for each pair, following [setup](../../docs/setup.md#6-teams-bots-team-and-channel-app).
   The worker identity may also be the first pair's primary, but pairs cannot share
   a bot registration or participant identity.
2. Supply a separate existing same-tenant Entra application for Graph readback.
   In the generated Teams manifest, `webApplicationInfo.id` is **that application's client ID**;
   `bots[].botId` is the bot UAMI's client ID. Request only installed-team
   application RSC `ChannelMessage.Read.Group`; approve it by installing the app
   in the dedicated team. Do not substitute tenant-wide channel read.
3. [`docs/setup.md`](../../docs/setup.md) adds the readback application's federated
   credential: issuer `https://login.microsoftonline.com/<tenant>/v2.0`, subject equal to
   the worker UAMI's **principal/object ID**, audience `api://AzureADTokenExchange`.
   Set `execution.teamsReadbackClientId` to the readback application's client ID.
4. Keep `teamsAuthentication: "bot"`, `botAuthentication: "managed-identity"` and
   `graphAuthentication: "managed-identity"` in `execution`. Hosting supplies explicit
   `BOT_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`; the root snapshot
   supplies each pair's generated client IDs.
   The bot/observer/target tenants must match. No certificate/user/CLI fallback
   is attempted.
5. Configure `tenants[].services.teams.targets[]` with `id`, `teamId` and
   `channelName`; `tenantId` defaults to the tenant's and `serviceUrl` to
   `https://smba.trafficmanager.net/teams/`. `npm run setup:ids` finds the named
   channel (creating a standard channel if missing) and writes its ID to
   `.env` (`<TENANT>__<TARGET>__CHANNEL_ID`, filled in as `channelId`); leave
   `channelId` out of the config. The runtime ignores `channelName`. Adding configured
   accounts from that tenant's [groups](../../docs/monitoring-groups.md) listing the target
   to the team — membership only, not synthetic participants — is a manual step in
   [`docs/setup.md`](../../docs/setup.md), alongside filling in and zipping the app
   package from its [template](../setup/teams-app/). A Teams administrator then uploads
   that package and installs it in each dedicated team, approving the team-scoped RSC
   permission; it creates no meetings or chats.
   Set `serviceUrl` only for another region; public-cloud service URLs are restricted to
   `https://smba.trafficmanager.net/{teams|amer|emea|apac}/`.

Bot Connector uses `https://api.botframework.com/.default`. Graph readback
uses `https://graph.microsoft.com/.default` through the federated application;
calling remains on the bot UAMIs. Azure reports use `healthReportAuthentication`
(managed identity by default) and the ARM audience. Provider access separately
uses the tenant's `providerClientId`.

## Two-bot meeting setup

1. Supply an existing dedicated meeting with compatible lobby/organizer policy.
   Neither the runtime nor any setup command creates meetings or authenticates the organizer.
2. Use two distinct same-tenant Azure Bot UAMIs. Approve Graph application
   `Calls.JoinGroupCall.All` on **both**, by hand, following
   [`docs/setup.md`](../../docs/setup.md). This is not a per-meeting permission; the root
   meeting allowlist is a runtime safeguard.
3. `tenants[].services.teams.callTargets[]` contains `{ id, meetingThreadId, organizer }`.
   `meetingThreadId` has the form `19:meeting_...@thread.v2`; `organizer` is the
   organizer's user principal name. `npm run setup:ids` looks up that user's ID into `.env`
   (`<TENANT>__<CALLTARGET>__ORGANIZER_USER_ID`, filled in as `organizerUserId`); only
   that command reads `organizer`. The organizer is ownership metadata, not a synthetic
   participant. `tenantId` defaults to the tenant's; the runtime selects
   `peerBotClientId` from the current pair, not from the meeting target.
4. Name each pair's two UAMIs and bot registrations in `botPairs[]` (a bare name in the health model's resource
   group, or a full `/subscriptions/...` resource ID elsewhere:
   [names](../../docs/deployment.md#what-the-config-holds)). `npm run setup:ids` looks up
   both client IDs with `az identity show` into `.env`:
   `<TENANT>__<PAIR_ID>__BOT_CLIENT_ID` and `...__BOT_PEER_CLIENT_ID`.
   The worker attaches all selected participant identities and selects clients per
   attempt. It never grants Graph access. Install each primary bot's own Teams app
   package in every selected team; existing readback federation remains shared.
5. Register every bot's calling channel against the same public HTTPS `/api/calls`
   callback on the existing Teams app:
   `https://<Teams worker appName>.<environment default domain>/api/calls`.
   `npm run setup:ids` finds the named environment, reads its default domain
   and writes the URL to `.env`
   (`<TENANT>__TEAMS__CALLING_CALLBACK_URL`, filled in as
   `execution.teamsCallingCallbackUrl`); the port is 8080. Only selected live scheduled
   meetings enable public ingress; `/healthz` is static readiness, not journey progress.
   Callback verification accepts only the configured primary/peer audience IDs
   and the configured tenant; it does not accept arbitrary bot identities.
6. Both legs share the default 20-second establishment/roster budget, with concurrent
   state and roster checks. The probe timeout must allow that budget plus five
   seconds for requests. Both owned calls get independent bounded departure attempts
   even after cancellation or a failed peer join.
   The journey involves no audio upload, playback or recording. Message-retention
   settings cannot disable call termination.

The Teams service block then names its resources and holds only the IDs of the readback
application, the team and the meeting (other `execution` settings omitted):

```json
"teams": {
  "execution": { "teamsReadbackClientId": "<readback application client ID>" },
  "worker": { "appName": "m365-ctbcoa-teams", "identity": "uami-m365-experience-consto-teams" },
  "botPairs": [
    { "id": "teams-pair-001", "bot": "bot-m365-consto",
      "identity": "uami-m365-experience-consto-teams",
      "peerBot": "ahm-m365-consto-peer", "peerIdentity": "uami-m365-experience-consto-teams-peer" },
    { "id": "teams-pair-002", "bot": "bot-m365-consto-002",
      "identity": "uami-m365-consto-teams-002",
      "peerBot": "bot-m365-consto-peer-002", "peerIdentity": "uami-m365-consto-teams-peer-002" }
  ],
  "targets": [{ "id": "teams-probe-001", "teamId": "<team ID>", "channelName": "General" }],
  "callTargets": [{
    "id": "teams-bot-meeting-001", "meetingThreadId": "19:meeting_...@thread.v2",
    "organizer": "organizer@example.invalid"
  }]
}
```

Pair IDs are unique lowercase slugs of at most 30 characters. Combined
`<pair-id>--<target-id>` IDs must fit 80 characters, and each journey's pair/target
product is limited to 1,000 attempts. Size lane concurrency/budgets before scaling;
the limit is not a guarantee of completing 1,000 attempts every two minutes.

Join bodies include the configured tenant both at top level and at
`meetingInfo.organizer.user.tenantId`. Every owned call is checked against the
thread, organizer and tenant. Before roster verification, observed call-chain IDs
must match when both are available. Both rosters must show distinct bot participants outside the lobby, and
both calls are rechecked as established. Mere creation, ringing or partial rosters
are not success.

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

`teamsCleanupEnabled` defaults true, but the checked-in root config sets it false
to retain bot posts/replies for inspection; call termination remains mandatory.
Skipped generic cleanup is not a failed business request.
Failures to remove owned artifacts fail the overall journey without erasing
earlier measured success.

Successful call creation or callback acknowledgement cannot replace verified
establishment, metadata, both rosters and both departures.
Each returned owned call ID is emitted immediately in `teams-call-created`
diagnostics and again only after verified departure in `teams-call-disconnected`.
Ambiguous creation remains an explicit cleanup failure; the runtime never retries
creation, guesses a call ID or enumerates tenant calls to find it.

## Call measurements

The `teams-call` entity reports connection/disconnection success percentages and
mean durations from executed `wait-for-answer`/`end-call` steps; skipped phases
have no numeric measurement. Connection duration includes join submission. These
are connectivity measurements, not audio or call-quality data.

## Provider context

Stable Service Health uses the independent provider lane (default 300 seconds),
with root `serviceHealth.enabled` and service `execution.serviceHealth` enabled.
Optional beta activity also needs separate approval, `execution.serviceActivity.enabled`
and `ENABLE_BETA_SERVICE_ACTIVITY=true` (the hosted gate is
`deployment.enableBetaServiceActivity`). Provider access uses `ServiceHealth.Read.All`
and, for beta activity, `ServiceActivity-Teams.Read.All`. Stable reports and dynamic
`microsoft-activity-*` signals share the single suppressed `teams-service-health`
entity; they never change synthetic success or the Experience rollup. Counts and
unthresholded activity values are diagnostic. All five selected Teams functions
report each provider cycle; unavailable sources report Unknown without a value.
Tenant audio-stream activity context is not per-bot call quality. See
[provider monitoring](../../docs/provider-monitoring.md).

## Run

From `synthetic-tests/`:

```sh
npm run teams -- --once
```

Add `--tenant <alias>` when the config has several tenants. A service in `simulation`
mode is labeled and makes no live calls. Real execution additionally requires `execution.mode: "live"`,
`deployment.enableLiveProbes: true` for hosted workers (`ENABLE_LIVE_M365=true` for a
local run) and the approved report destination.
Validate full root **and** reply evidence, both call legs, cleanup and actual
ingestion—not just token acquisition or a ready revision.

The config accepts only `channel-conversation` and `scheduled-meeting`; peer metadata
belongs only in `callTargets` and `access`. See [hosting](../infra/README.md) and
[operations acceptance](../../docs/operations.md#enterprise-reliability-acceptance-gate).
