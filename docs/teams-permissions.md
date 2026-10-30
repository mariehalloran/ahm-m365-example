# Teams permissions and managed identity setup

Teams journeys use **managed-identity bots**, not Microsoft 365 test-user tokens.
Complete the shared [Azure and administrator setup](./setup.md), then the
[bot, channel and app runbook](./setup.md#6-teams-bots-team-and-channel-app).
Keep the worker, bot identities, readback application and targets in the
[same approved tenant](./cross-tenant-access.md).

## Select every bot pair and target

Root [`monitoring.config.json`](../monitoring.config.json) selects
`tenants[].services.teams.botPairs[]`. Each pair names its own primary `bot` and
`identity`, and `peerBot` and `peerIdentity`. The checked-in configuration selects
**two independent pairs: four distinct bot managed identities**. Do not reuse
registrations or participant identities between pairs.

One existing Teams Container App attaches every selected primary/peer identity.
Every pair exercises every selected ungrouped channel `targets[]` and meeting
`callTargets[]`; adding a pair does not create another worker.
The primary posts the channel root message and threaded reply. Both identities
join the existing dedicated meeting and verify both rosters and departures.

A licensed test organizer prepares the team/meeting fixtures. Its
`callTargets[].organizer` UPN is lookup metadata, **not a probe participant or
sign-in credential**. No employee answer, delegated runtime sign-in, MFA bypass,
user refresh token, bot secret or uploaded certificate is required.

## Required synthetic authorization

| Identity or application | Authorization | Boundary |
| --- | --- | --- |
| Each primary bot UAMI | Azure Bot registration of type `UserAssignedMSI`, Teams channel, and matching Teams app installed in every selected team | Bot Connector posting; Graph read permission does not authorize sending |
| Separate `execution.teamsReadbackClientId` application | Application RSC `ChannelMessage.Read.Group`, consented through each primary app's installation | Each consented **team**, not just the configured channel |
| Teams worker UAMI | Federated credential on the readback app | Secretless sign-in as that application; not an additional Graph permission |
| Every primary and peer UAMI used by `scheduled-meeting` | Microsoft Graph application `Calls.JoinGroupCall.All` | Tenant-wide calling approval, not a meeting-scoped consent |

Selecting a meeting thread or bot ID at runtime does **not** turn the calling
permission into tenant-enforced resource scoping. Obtain explicit approval for
that application grant on **all four identities** when both configured pairs call.
Do not grant `CallRecords.Read.All`, broad channel-message read roles,
`OnlineMeetings.ReadWrite.All` or `Calls.AccessMedia.All` merely to run these journeys.
The implementation joins pre-created meetings using service-hosted media; it
does not create meetings, fetch tenant-wide call records or process media.

## Prepare the bots, readback and callback

Follow [Graph grants and federation](./setup.md#5-microsoft-graph-application-roles-and-federated-credentials)
and [Teams setup](./setup.md#6-teams-bots-team-and-channel-app):

1. Register both bots of every pair against their explicitly selected UAMIs and
   enable their Teams channel. Enable calling and set the shared callback for
   every bot participating in meetings.
2. Create/use the separate Entra readback application. Add a federated credential
   trusting the **Teams worker UAMI's principal ID**, with the actual tenant's
   issuer and `api://AzureADTokenExchange` audience. Set its application/client ID
   in `execution.teamsReadbackClientId`.
3. Package and install a separate Teams app for **each primary bot**, using the
   [existing manifest template](../synthetic-tests/setup/teams-app/manifest.json).
   Each package has a distinct app ID, its own primary `botId`, and the readback
   application in `webApplicationInfo.id`. Consent `ChannelMessage.Read.Group`
   for each selected team; do not put the UAMI's ID in place of the readback app ID.
4. Run `npm run setup:ids` after the identities/team exist. It finds or creates
   the named standard channels and resolves both bot client IDs per pair, the
   organizer's user ID and the callback URL. It writes the adjacent gitignored
   [`.env` bindings](./deployment.md#generated-ids-in-env), not the root config.
   This helper uses the administrator's Azure CLI session; it does not grant
   runtime consent or package/install apps.
5. Configure the shared public HTTPS callback
   `https://<teams-worker-host>/api/calls`. The worker validates signed calling
   notifications against the selected bot identities; a URL alone is not calling
   authorization. Keep `teamsAuthentication: "bot"` and
   `botAuthentication: "managed-identity"`, with matching actual
   `AZURE_TENANT_ID` and `BOT_TENANT_ID`.

If a bot identity is recreated, regenerate its client-ID binding and update,
version and reinstall its matching app. Update federation trusts when the worker
principal changes; an installed app can otherwise retain a stale bot binding.

## Implemented endpoints

Graph paths use `https://graph.microsoft.com/v1.0`.
Connector paths use the configured validated service URL, default
`https://smba.trafficmanager.net/teams/` (also allowing `amer`, `emea` or `apac`).
Connector tokens use the `https://api.botframework.com/.default` audience;
Graph uses `https://graph.microsoft.com/.default`.

| Method and path | Credential and use |
| --- | --- |
| Connector `POST v3/conversations` | Primary bot UAMI creates a channel root post |
| Connector `POST v3/conversations/{conversationId}/activities/{rootActivityId}` | Same primary bot posts the threaded reply |
| Connector `DELETE v3/conversations/{conversationId}/activities/{activityId}` | Same bot removes owned posts/replies when cleanup is enabled |
| Graph `GET /teams/{teamId}/channels/{channelId}/messages` | Federated readback app verifies persisted root author and correlation |
| Graph `GET /teams/{teamId}/channels/{channelId}/messages/{messageId}/replies` | Same app verifies the persisted reply |
| Graph `POST /communications/calls` | Each pair's primary and peer join the configured existing meeting |
| Graph `GET /communications/calls/{callId}`; `GET .../{callId}/participants` | Each bot verifies its own call state/metadata and both participant identities |
| Graph `DELETE /communications/calls/{callId}` | Each bot leaves its owned leg; subsequent reads confirm disconnection |

The [ID helper](../synthetic-tests/setup/generate-ids.ps1) separately uses
administrator `GET /teams/{teamId}/channels`, `POST` to that collection only if
the named channel is missing, and `GET /users/{organizerUPN}?$select=id`.
Those setup operations are not runtime worker permissions.

Both journeys use the checked-in **120-second cadence**, a **60-second deadline
per complete journey**, separately bounded cleanup and a **15-second latency
degradation threshold**. Worker cancellation and cleanup-only outcomes report
Unknown without numeric samples; genuine service failures/deadline expiry remain
failures. Cancelled internal teardown is not a measured business departure.
These checks cover bot/API persistence and connectivity, **not employee client
experience, received audio or call quality**.

Verify every pair's channel operations, both call legs, cleanup/intentional message
retention and accepted health reports before recurrence. Use the
[live gates](./deployment.md#live-execution-gates) and
[operational checks](./operations.md#enterprise-reliability-acceptance-gate).
Azure image/configuration/reporting roles remain
[separate from Teams access](./deployment.md#identity-and-permissions).

## Optional provider context

The independently selected provider application uses `ServiceHealth.Read.All`
for stable overviews/issues, separately approved `ServiceMessage.Read.All` for
Message Center, and `ServiceActivity-Teams.Read.All` for the **five optional beta
methods**. These tenant-wide read permissions do not authorize a bot journey;
runtime service filters are not tenant permission boundaries.

Use the [provider runbook](./provider-monitoring.md) for exact endpoints, federation,
independent provider cadence and beta approval. Context is published only on the
single suppressed `teams-service-health` entity and cannot alter synthetic
outcomes, business steps or Experience rollup. QoE coverage/UDP percentages are
not measured audio quality. A beta 403 alone does not establish a licensing cause.

Stop the worker before revocation. Remove only owned app installations, RSC grants,
calling grants and federation trusts under the tenant owner's procedure; review
retained synthetic messages without deleting business conversations.

Microsoft references:
[Teams resource-specific consent](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent),
[join a scheduled meeting](https://learn.microsoft.com/en-us/graph/api/application-post-calls?view=graph-rest-1.0).
