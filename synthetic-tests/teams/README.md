# Teams bot API journeys

**Default: `teamsAuthentication: "bot"`, `botAuthentication: "managed-identity"`.**
The worker publishes and replies as an installed bot using its explicitly selected
same-tenant user-assigned managed identity. No user sign-in, MFA, delegated token cache
or refresh-token maintenance is required. This is **bot API coverage**, not employee
sign-in, browser/UI testing, a read receipt or human-to-human delivery.
Calling covers individual call placement, a configured wait and verified hang-up,
**not whether each recipient rang or received the call**, and not audio/video,
speaker/microphone, participant experience or meeting quality.
Simulation remains credential-free. Source tests use fake HTTP; each deployment must
verify real posting, authorship, readback, cleanup and report ingestion. See the
[recorded live baseline](../../docs/deployment.md#deployment-status-and-order) separately
from these reusable setup instructions.

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
- `call-test-user` / `teams-call`: `place-call`, `wait-before-hangup`, `end-call`.

## Individual test-user calls

Root `services.teams.scenarios["call-test-user"]` selects recurring calls at the
existing service cadence (120 seconds by default), alongside messaging. There is
no manual approval state or incoming HTTP trigger. Disable this scenario for a
messaging-only rollout. The checked-in root selects **one channel messaging target
and three independent call targets**, with safe simulation; live I/O still requires
`mode: "live"` and `ENABLE_LIVE_M365=true`.

1. Add each dedicated test account under **root**
   `services.teams.callTargets[]` as `{ "id": "teams-call-user-001",
   "tenantId": "<approved-tenant-UUID>", "callUserId": "<user-object-UUID>" }`.
   These are individual user object IDs, not UPNs, meetings or group IDs. Channel
   metadata stays only in `services.teams.targets[]`; do not copy it per user.
2. An administrator approves **application `Calls.Initiate.All` on the bot identity**.
   This is tenant-wide permission, not an RSC/user-scoped grant: the runtime root
   allowlist limits outgoing targets, but does not narrow the underlying grant.
   Do not grant runtime provisioning/admin permissions.
3. No delegated sign-in/cache/MFA, meeting creation, OnlineMeetings permissions or
   `Calls.JoinGroupCalls.Chat` permission is needed for these individual calls.
   The channel-messaging team's app/RSC installation is a separate prerequisite
   for messaging, not a runtime gate on individual call creation. No personal-app
   installation or `CsApplicationAccessPolicy` scoping claim is made here.
   No `Calls.AccessMedia.All`, media SDK, audio playback/capture or AV assertions
   are used. This service-hosted flow requests the official `audio` modality
   for signaling, not an audio-quality test.
4. Set service `teamsCallingCallbackUrl: "https://<teams-worker-fqdn>/api/calls"`
   and `teamsCallingPort: 8080` (default). Selected live calls open HTTPS ingress
   **only on Teams**, `allowInsecure: false`, one replica. `/healthz` is static
   readiness; `/about` is a brief internal-lab data-handling description suitable
   for this lab's app metadata, not production legal terms.
5. Enable Azure Bot calling with that callback only after the authenticated server
   is deployed. Deploy the updated health model before the worker and prove actual
   MI call creation, configured wait, DELETE and GET
   `terminated`/404. Source tests do not establish those live permissions.

Calls use `BOT_CLIENT_ID`/`BOT_TENANT_ID` with the independently selected
`botAuthentication` for a **Graph-audience** token. They never use observer or
delegated user tokens—even if optional delegated messaging is selected.
The fixed calling scope is **`00000003-0000-0000-c000-000000000000/.default`**,
Microsoft Graph's canonical application-resource ID. This is the same Graph resource,
not another identity or a retry fallback. The observer still uses
`https://graph.microsoft.com/.default`; Connector still uses
`https://api.botframework.com/.default`. Managed-identity infrastructure can cache a
resource's role-less token for about 24 hours after a new grant; redeploying does not
necessarily refresh it. Verify actual token roles and Graph acceptance after grants.
The canonical-resource audience was accepted by Graph in the hosted lab (GET of a
nonexistent call returned 404, not 401); that alone does not prove outbound calling.
POST `/communications/calls` is attempted once **per configured account per cycle**:

```json
{
  "@odata.type": "#microsoft.graph.call",
  "callbackUri": "https://<teams-worker-fqdn>/api/calls",
  "targets": [{ "identity": { "user": { "id": "<root-callUserId>" } } }],
  "tenantId": "<root-tenantId>",
  "requestedModalities": ["audio"],
  "mediaConfig": { "@odata.type": "#microsoft.graph.serviceHostedMediaConfig" }
}
```

The approved coverage is **placement and hang-up**, not ringing confirmation.
`place-call` requires successful creation with an owned call ID; 201/accepted does
not prove recipient receipt. `wait-before-hangup` polls that exact call while waiting
the configured duration. `establishing`, `ringing`, `established` and other nonterminal
states do not prove recipient notification, answer identity or media quality.
Early `terminating`/`terminated`, a missing call, HTTP/schema failures or a numeric
Graph failure result fail the wait honestly; cancellation also fails the attempt.
No user is automatically answered. Microsoft's P2P example does not guarantee an
outgoing `ringing` event, so the worker does not use it as a required success signal.
Authenticated callbacks are acknowledged only; there is no callback business-state
cache, control plane or persisted call state.

`teams-call-state-observed` logs allowlisted GET state transitions and numeric
`resultCode`/`resultSubcode` when Graph supplies `resultInfo`, with the test alias,
correlation and elapsed time. Repeated identical samples are suppressed, with at
most 12 events per attempt. Result messages, call IDs, response bodies, target
identities and tokens are never logged. `teams-calling-callback-rejected` reports
only HTTP status and stage (`headers`, `verification`, `body`, `timeout`, `handler`),
plus allowlisted `authErrorCode`, `authClaim` and `authReason` for verification
failures. Messages, tokens, payloads and claim values are never included.
Rejections and accepted-callback diagnostics are each capped at ten per minute.
Accepted events report only `authentication: "verified"` and `tenantMatched: true`.
Terminal-state failure without an HTTP status is a signaling outcome, not proof
of Graph HTTP failure. Offline/unreachable clients, rejection and voicemail are
possible causes; inspect numeric results and human client observations rather
than inferring one from elapsed time alone.

`teamsCallingWaitSeconds` (service execution setting, default **10**, range 1–30)
sets the brief dwell after placement; the live timeout must allow this wait plus
execution time. The environment/runtime field is `TEAMS_CALLING_WAIT_SECONDS`;
service files remain authoritative. The old `teamsCallingRingSeconds` field is
rejected, not silently interpreted. A user may answer during this period; the
worker neither requires nor claims an answer. `end-call` DELETEs only the
returned call ID and polls GET for `terminated`/404, not just DELETE acceptance.
Three users produce three attempts aggregated into **one `teams-call` journey** and
three shared business-step entities, never per-user signals. Console diagnostics use
the configured test alias/correlation ID, not account IDs, tokens or notification bodies.

Run one bounded cycle of the **same active root and service files**:
`node dist/teams/src/worker.js --once --project-config /etc/probe/monitoring.config.json --config /etc/probe/service.json`.
This is the ordinary worker entrypoint; do not launch a second copy beside a running
calling worker because both would bind the callback port and could duplicate calls.
Recurring mode uses the same command without `--once`. Root targets are never replaced
by an alternate trial profile.

**Call departure is never disabled by `teamsCleanupEnabled: false`.** Once creation
returns a known ID, `end-call` is attempted and measured even when waiting failed or
the execution signal was cancelled. Successful teardown never repairs a failed wait.
End-call failure remains a failed business action even if fallback cleanup succeeds.
Independent teardown has a shared ten-second bound: a four-second business attempt
(3.5-second state-poll deadline), then fallback cleanup using the remaining budget.
`teams-call-disconnected` distinguishes `phase: "business"` and `"cleanup"` after
GET termination/404 proof. Unknown POST outcomes cannot safely be
reconciled: diagnostics expose `teams-call-unknown-creation-outcome`; an orphaned
leg may need approved operator intervention. State is not persisted between cycles.

POST `/api/calls` requires Microsoft-signed JWTs using the canonical
`https://api.aps.skype.com/v1/.well-known/OpenIdConfiguration` and its validated
`https://api.aps.skype.com/v1/keys` JWKS—not Entra discovery. Only RS256,
`iss` exactly `https://graph.microsoft.com` or `https://api.botframework.com`,
`aud` exactly the bot client-ID string, required valid `exp`, and valid `nbf` when
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
Notifications never affect journey success, select outgoing users or initiate calls.
Invalid tokens fail closed.

**Limits and live acceptance:** Graph signaling is not proof of a visible device/UI
notification, employee sign-in or real-user experience. Human observation of incoming
calls is separate evidence, never inferred from a Healthy placement-and-hang-up report.
Real managed-identity API execution/report ingestion remains a separate cloud
acceptance check, not a claim made by source tests. No answer/media is required.
Continuously verifying employee client state/UI is not implemented.

References: [official individual call creation](https://learn.microsoft.com/graph/api/application-post-calls?view=graph-rest-1.0),
[get call](https://learn.microsoft.com/graph/api/call-get?view=graph-rest-1.0),
[delete call](https://learn.microsoft.com/graph/api/call-delete?view=graph-rest-1.0),
[canonical notification authentication sample](https://github.com/microsoftgraph/microsoft-graph-comms-samples/blob/master/Samples/Common/Sample.Common/Authentication/AuthenticationProvider.cs),
[Microsoft inbound claim mapping](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.JsonWebTokens/ClaimTypeMapping.cs),
[Microsoft lifetime validation](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/ValidatorUtilities.cs).

## Message measurement contracts

The reply journey creates its own correlated parent and reply. Bot readback requires
the exact marker, expected application author and nondeleted state; Connector
activity IDs are not assumed to be Graph IDs. Opt-in delegated readback also requires
the exact created Graph ID and authenticated user object ID. Every POST is attempted once: uncertain creation
is never retried or reconciled into permission to delete some other message.

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
`ServiceActivity-Teams.Read.All`; it is diagnostic-only, not journey evidence.
Provider failures do not change synthetic success, business steps or rollup.
ARM health reports independently use `healthReportAuthentication`, hosted UAMI.
See [provider contracts](../utils/README.md#optional-provider-collectors).
