# Teams permissions and managed identity setup

Teams journeys use **managed-identity bots**, not Microsoft 365 test-user tokens.
Complete the shared [Azure and administrator setup](./setup.md), then the
[bot, channel and app steps below](#prepare-the-bots-readback-and-callback).
Keep the worker, bot identities, readback application and targets in the
[same approved tenant](./cross-tenant-access.md).

## Select every bot pair and target

In [`monitoring.teams.json`](../monitoring.teams.json), the matching
`tenants[].config.botPairs[]` selects each pair's primary `bot` and
`identity`, and `peerBot` and `peerIdentity`. The checked-in configuration selects
**two independent pairs: four distinct bot managed identities**. Do not reuse
registrations or participant identities between pairs.

The Teams execution Function app attaches every selected primary/peer identity.
Every pair exercises every selected ungrouped channel `targets[]` and meeting
`callTargets[]`; adding a pair does not create another worker.
The primary posts the channel root message and threaded reply. Both identities
join the existing dedicated meeting and verify both rosters and departures.

A licensed test organizer prepares the team/meeting fixtures. Its
`config.callTargets[].organizer` UPN is lookup metadata, **not a probe participant or
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

An Azure resource administrator prepares bot resources; a Teams administrator
approves/publishes the apps, and a team owner or approved installer consents to
RSC. A separately authorized Entra administrator approves application calling roles
and federation. These are setup authorities, not runtime roles.

### Bot registrations and fixtures

Before foundation preflight, create both bots of every selected pair using its
already-created UAMI. Repeat for each primary and peer registration:

```sh
az bot create --name <pair.bot-or-peerBot> --resource-group <resource-group> \
  --app-type UserAssignedMSI --appid <bot-UAMI-clientId> \
  --msi-resource-id <bot-UAMI-resource-ID> --tenant-id <M365-tenant-id> \
  --sku F0 --location global
az bot msteams create --name <pair.bot-or-peerBot> --resource-group <resource-group>
```

Use a dedicated team and standard channel for each `config.targets[]` entry.
A licensed Microsoft Teams test organizer creates an existing dedicated meeting;
record its `meetingThreadId` and organizer UPN in `config.callTargets[]`.
The helper does not create meetings or license accounts. Reporting groups do not
grant Teams membership or install an app.

### Readback application and federation

Create/use the separate Entra readback application and set its application ID in
`config.execution.teamsReadbackClientId`. Add a federated credential trusting the
**Teams execution UAMI's principal/object ID**, not a bot's application ID:

```sh
az rest --method post \
  --url "https://graph.microsoft.com/v1.0/applications/<readback-app-object-id>/federatedIdentityCredentials" \
  --body '{"name":"teams-execution","issuer":"https://login.microsoftonline.com/<actual-tenant-id>/v2.0","subject":"<Teams-execution-UAMI-principalId>","audiences":["api://AzureADTokenExchange"]}'
```

The worker obtains a managed-identity assertion and exchanges it for a readback
app Graph token, with no secret. A trust alone grants no message access: the app
installation's RSC consent below supplies that access. Audit existing trusts
before creating/updating them.

### Generated IDs, callback and installed apps

After foundation deployment and fixture creation, run from `synthetic-tests/`:

```sh
npm run setup:ids
```

This uses the operator's Azure CLI session to resolve bot IDs, find/create named
channels and look up organizer IDs. It reads the actual deployed Teams Function
hostname for `https://<teams-function-host>/api/calls`, writing all bindings to
the adjacent gitignored [`.env`](./deployment.md#generated-ids-in-env).
It also processes other enabled live services; it grants no runtime consent and
does not package/install apps.

For **every primary and peer bot that calls**, enable calling with that callback:

```sh
az bot msteams create --name <pair.bot-or-peerBot> --resource-group <resource-group> \
  --enable-calling --calling-web-hook "https://<teams-function-host>/api/calls"
```

The Function validates signed calling notifications against the selected bot
identities; a URL alone is not calling authorization. Keep
`teamsAuthentication: "bot"` and `botAuthentication: "managed-identity"`, with
matching actual `AZURE_TENANT_ID` and `BOT_TENANT_ID`.

Package a separate Teams app for **each primary bot** from the
[manifest and icons](../synthetic-tests/setup/teams-app/). Fill `version`, a
distinct `appId` (retain the installed app's ID for updates), the primary `botId`,
`calling`, the Function `host` and `readbackClientId`. `webApplicationInfo.id`
must name the **readback application**, not the UAMI.
Zip the manifest and two icons, then:

1. As a Teams administrator, upload/update each package in **Teams admin center >
   Teams apps > Manage apps**.
2. Add/update each primary app in **each selected team > Manage team > Apps**,
   consenting application `ChannelMessage.Read.Group` for that team.

If a bot is recreated, rerun ID resolution, update its package's bot ID, bump the
version and reinstall/update the same app. Remove a stale app only after confirming
it is owned by this setup. Repoint federation if the execution principal changes.

### Calling application consent

For every selected primary and peer UAMI, obtain explicit tenant approval for
Graph application `Calls.JoinGroupCall.All`. A Privileged Role Administrator or
Global Administrator can approve Microsoft Graph application roles. Review
existing assignments before this first-time example:

```sh
GRAPH_SP=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)
ROLE_ID=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 \
  --query "appRoles[?value=='Calls.JoinGroupCall.All'].id | [0]" -o tsv)
az rest --method post \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/<bot-UAMI-principalId>/appRoleAssignments" \
  --body "{\"principalId\":\"<bot-UAMI-principalId>\",\"resourceId\":\"$GRAPH_SP\",\"appRoleId\":\"$ROLE_ID\"}"
```

## Implemented endpoints

The [Teams README](../synthetic-tests/teams/README.md#apis-used) lists exact
Bot Connector and Graph v1.0 runtime endpoints, their credential and purpose.
Connector tokens use `https://api.botframework.com/.default`; Graph uses
`https://graph.microsoft.com/.default`.

The [ID helper](../synthetic-tests/setup/generate-ids.ps1) separately uses
administrator `GET /teams/{teamId}/channels`, `POST` to that collection only if
the named channel is missing, and `GET /users/{organizerUPN}?$select=id`.
Those setup operations are not runtime worker permissions.

The current config selects a **300-second cadence**, a **240-second deadline
per complete journey**, separately bounded cleanup and unchanged **15-second
Degraded / 60-second Unhealthy latency thresholds**. The checked-in lane starts all
six selected pair/target attempts concurrently to fit the cycle. Worker cancellation and cleanup-only outcomes report
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

Use the [provider runbook](./provider-monitoring.md#provider-authentication) for
separate consent/federation and the [Teams optional endpoint inventory](../synthetic-tests/teams/README.md#optional-provider-endpoints).
Provider selection lives in `config.execution` with root `serviceHealth.enabled`.
Follow the runbook for independent provider cadence and beta approval.
Context is published only on the
single suppressed `teams-service-health` entity and cannot alter synthetic
outcomes, business steps or Experience rollup. QoE coverage/UDP percentages are
not measured audio quality. A beta 403 alone does not establish a licensing cause.

Stop service scheduling before revocation. Remove only owned app installations, RSC grants,
calling grants and federation trusts under the tenant owner's procedure; review
retained synthetic messages without deleting business conversations.

Microsoft references:
[Teams resource-specific consent](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent),
[join a scheduled meeting](https://learn.microsoft.com/en-us/graph/api/application-post-calls?view=graph-rest-1.0).
