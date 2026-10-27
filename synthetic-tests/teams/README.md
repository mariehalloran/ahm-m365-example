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

## Two-bot meeting setup

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
6. The default establishment budget is 20 seconds. The probe timeout must allow
   that budget plus five seconds for requests; cleanup is independently bounded.
   No playback approval or audio upload is required. Message-retention settings
   cannot disable call termination.

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

The meeting journey does not upload, play or record audio. It does not expose a
test-tone endpoint or publish playback health signals. Successful call creation
or callback acknowledgement cannot replace verified establishment, metadata,
both rosters and both departures. This does not test microphones, speakers,
employee identity or clients.
Each returned owned call ID is emitted immediately in `teams-call-created`
diagnostics and again only after verified departure in `teams-call-disconnected`.
Joining calls can receive a provisional chain before Graph assigns the established
conference chain. Quality collection uses the established chain; teardown cannot
replace it or turn diagnostic chain changes into failed departure.
Ambiguous creation remains an explicit cleanup failure; the runtime never retries
creation, guesses a call ID or enumerates tenant calls to find it.

## Call measurements

The existing `teams-call` External Reports group contains connection and
disconnection success percentages and mean durations (four immediate
measurements; connection duration includes join submission). No audio entity
or playback success/duration health signals are created.
Quality members are selected only by explicit
`healthModel.callQualityThresholds` keys, empty by default, after a pilot has
actually returned those metrics. Supported parser keys are `packetLossPercent`,
`maxPacketLossPercent`, `jitterMs`, `maxJitterMs`, `roundTripTimeMs`,
`maxRoundTripTimeMs`, `audioDegradation`, `concealedSamplesPercent` and
`maxConcealedSamplesPercent`; this is **not** a claim they exist for these bots.

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

## Meeting and audio quality options

| Option | Useful evidence | Status and boundary |
| --- | --- | --- |
| Current meeting journey | Join success/time, meeting metadata, both rosters and departure success/time | Implemented with existing bot permissions; control-plane evidence, not audio quality. |
| Connected-meeting soak | Repeated state/roster checks during a configured dwell period to detect dropped calls or participants | Possible extension, not implemented; no raw-media access required, but still not received-audio proof. |
| [Call-record media streams](https://learn.microsoft.com/en-us/graph/api/resources/callrecords-mediastream?view=graph-rest-1.0) | Packet loss, jitter, round-trip time, concealed samples and network MOS **degradation**, not absolute MOS | Optional collector already implemented, disabled by default; needs approved tenant-wide `CallRecords.Read.All` and actual populated audio streams. |
| [Short recorded response](https://learn.microsoft.com/en-us/graph/api/call-record?view=graph-rest-1.0) | Potential known-signal detection in a brief service-hosted recording | Investigation candidate only, not implemented or verified for this two-bot meeting. Requires `Calls.AccessMedia.All`, explicit recording approval, timely recording download and no persisted audio; recordings are limited to two minutes. |
| [Application-hosted media bots](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots) | Send/receive known signals in both directions and inspect actual frames | Separate C#/.NET Windows Server media hosting and approved media access are required; the current Node/Container Apps worker cannot process raw media. |

Microsoft's [call-record FAQ](https://learn.microsoft.com/en-us/graph/callrecords-api-faq)
states that the first record typically arrives within **30 minutes**, but can
take **150 minutes**; fields can remain absent. The current 30-second bounded
collector is therefore not a reliable delayed-quality pipeline. The finite
opt-in pilot below retains actual IDs within its own invocation, never across
scheduled cycles. A silent
two-bot join must not be assumed to produce usable audio-quality samples.
Known-ID filtering does not narrow the tenant-wide permission.

Keep meeting availability/timing as the immediate signal. Treat delayed
call-record quality as separate evidence, and require a dedicated feasibility
test before choosing recorded-response or raw-media testing. None of these
bot-only options proves employee device/network experience. The beta QoE-coverage
and UDP percentages remain supporting provider context, not a substitute for
measured audio quality.

## One-shot hosted-audio feasibility pilot

This is an **opt-in finite experiment**, not another journey or a durable
scheduled collector. Checked-in simulation and worker settings neither play
audio nor read tenant call records. Live telemetry support for this exact
two-bot meeting remains **unverified until an approved hosted run**.

1. Use the existing approved live root/service profiles and the two explicit
   bot UAMIs from meeting setup. The primary also needs separately approved
   application **`CallRecords.Read.All`**, which reads tenant-wide records;
   root meeting filtering does not scope that grant. The command grants nothing.
   Service-hosted `playPrompt` uses the existing call authorization; this pilot
   does not request raw-media access, recordResponse or audio recording.
2. Provide a caller-approved synthetic WAV at a **public HTTPS URL**:
   uncompressed PCM, mono, 16-bit, 16 kHz, nonempty and at most ten seconds.
   Preflight downloads at most 512 KiB without credentials or redirects, checks
   public DNS addresses and WAV bytes, and finishes before any call mutation.
   There is no built-in public tone endpoint or hosting setup.
3. Run only where both bot managed identities are available **and the configured
   public `teamsCallingCallbackUrl` routes to this command's listener**.
   Stop the normal Teams worker for the approved pilot: the same port cannot
   be bound concurrently. A local shell without approved MI hosting/public
   routing is insufficient. Another worker's successful callback HTTP ACK
   cannot complete this command's private operation correlation. No routing or
   deployment changes are made by this command.
4. From `synthetic-tests/`, run one pilot without publication first:

   ```sh
   ENABLE_LIVE_M365=true npm run teams:audio-quality -- \
     --project-config /approved/path/monitoring.private.json \
     --config /approved/path/teams.live.json \
     --target-id approved-root-meeting-id \
     --audio-url 'https://approved.example.com/synthetic-tone.wav' \
     --acknowledge-tenant-wide-call-records
   ```

`--target-id` is optional only when exactly one root meeting is selected.
The command reuses establishment, metadata and both-roster verification, then
plays **once from the primary bot** while checking both calls remain established.
Completion requires the existing signed, tenant/audience-verified listener and
matching owned primary call, returned operation ID and client context. HTTP
acceptance alone is not completion; no undocumented GET-operation polling or
ambiguous mutation retry is used. Even confirmed playback does **not** prove
the other bot received audio.

Both owned calls are independently ended on success, playback failure or
cancellation. Readback starts only after verified departure/cleanup and closes
the callback listener first. It is not limited by the meeting's 45-second
execution budget and never holds calls open for minutes.

| Option | Default / boundary |
| --- | --- |
| `--max-wait-minutes` | 150; integer 1–180, confined to this invocation |
| `--poll-interval-seconds` | 60; integer 1–300, no larger than the readback budget |
| `--playback-timeout-seconds` | 15; integer 1–30, shorter than remaining meeting execution time; WAV must be shorter |
| `--publish` | Off; deliberately publish only returned metrics selected by root quality threshold keys |
| `--help` | Show flags without configuration, credentials or network access |

Readback uses only actual returned call-chain IDs, deduplicating the conference
chain. Recent 404s and valid initial records without metrics are retried to the
finite deadline; later versions may populate them. First-record latency can be
150 minutes and subsequent versions can arrive later still. Exact call-chain
correlation is not guaranteed by Graph in every scenario; this pilot never
falls back to tenant enumeration. A restart loses this invocation's IDs.

Console diagnostics retain actual values, stream/sample coverage, version,
codec/direction and provider provenance. Signed URL query strings are not logged,
but remain visible in process arguments and to Graph/the audio host; prefer an
approved public URL without secrets. No WAV or call-record payload is persisted.
Exit **0** means populated metrics with complete observed coverage, **2** means
partial or inconclusive/no metrics, **1** means failure (including explicit 403),
and **130** means cancellation. These are pilot outcomes, not normal meeting
health reports.

Only measurements actually returned with values can generate quality reports;
true zero is retained, absent/pending/failed/no-stream metrics generate none.
Unselected/unthresholded real values stay diagnostic. To opt in proven metrics,
set only their existing `healthModel.callQualityThresholds.<metric>` keys with
approved `degradedAbove` / `unhealthyAbove` limits, update the existing model
through a separately approved deployment, then explicitly rerun with
`--publish`. No thresholds are invented. The existing reporter/root destination
is used without creating entities or publishing normal journey/playback health.
Partial coverage remains Unknown rather than Healthy. Publication still needs
the existing separately authorized ARM reporting identity.

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
Remove `teamsCallingPlaybackEnabled` and `teamsCallingPlaybackTimeoutSeconds`
from private service files, and remove their `TEAMS_CALLING_PLAYBACK_*`
environment settings; obsolete settings are rejected. Deploy matching workers
and models, then retire the old audio child and playback reports using the
[model migration](../../health-model/README.md#retiring-teams-audio-testing).
See [hosting](../infra/README.md) and
[operations acceptance](../../docs/operations.md#enterprise-reliability-acceptance-gate).
