# Optional Teams delegated user setup and reauthentication

Teams defaults to an [unattended managed-identity bot](../synthetic-tests/teams/README.md#primary-setup-unattended-bot),
which needs no user MFA, refresh tokens or user-cache storage. This guide applies
**only to explicit `teamsAuthentication: "user-delegated"`**, for approved user-identity
API coverage rather than browser automation. A human performs interactive bootstrap;
tenant policy may require later MFA/reauthentication even though the worker is unattended.
Do not use app credentials as user impersonation, ROPC, password automation, automated
MFA or a workaround for Conditional Access.

## 1. Approve the test account, resources and public client

Create a dedicated licensed test user and dedicated private test team/standard channel.
Assign the user as member/owner. Provision these using a separate approved administrator;
the runtime app must not receive `Team.Create` or other provisioning/admin rights.
Register a **single-tenant public client** with device-code/public-client flows enabled,
no client secret/certificate. Obtain approved delegated consent for:

- `ChannelMessage.Send`: normal channel messages/replies.
- `ChannelMessage.Read.All`: readback.
- `ChannelMessage.ReadWrite`: soft deletion of the signed-in user's messages.
- MSAL's standard `openid`, `profile`, `offline_access` scopes for sign-in/refresh.

Restrict enterprise-app assignment and, where supported, individual consent to each
selected test user rather than granting broad user access. Every configured
test user must be assigned, consented and a team member. `User.Read` is not needed by this worker.
Validate tenant policy **before** enabling recurrence: device-code may be prohibited,
require MFA, or be incompatible with tenant CA. Use another separately approved
interactive bootstrap implementation if policy requires it; this CLI implements only
device code and never bypasses policy.

## 2. Select the root profile

In the active root project config, select the existing Teams scenarios and target:

```json
{
  "id": "teams-probe-001",
  "userPrincipalName": "synthetic-user-1@example.invalid",
  "tenantId": "<M365-and-hosting-tenant-UUID>",
  "teamId": "<dedicated-team-UUID>",
  "channelId": "<standard-channel-ID>"
}
```

Add separate target IDs for additional approved users (for example,
`synthetic-user-2@example.invalid` and `synthetic-user-3@example.invalid`) with the same approved
tenant/team/channel. Every target in one worker must use the same tenant, but may
select a different account. Each selected scenario runs once per target; reports
aggregate independent attempts without adding per-account signals.
The Teams service file
contains `mode: "live"`, `teamsAuthentication: "user-delegated"`, cadence/timeouts and
independent `graphAuthentication`/`healthReportAuthentication` settings, **not targets**.
Keep `teamsCleanupEnabled: true` (the default) for normal cleanup. To inspect live
content temporarily, set **`"teamsCleanupEnabled": false` in that service file** and
restart/redeploy; it applies to both scenarios and delegated/bot modes. Correct-author
readback is still required. Cleanup is skipped rather than reported as executed
success, with a `teams-cleanup-disabled` console diagnostic; no cleanup or
cleanup-reconciliation requests run, even after a business-action failure.
At three accounts/both successful scenarios, retention adds six root posts and three
replies per cycle (270 messages/hour at 120 seconds). Restore `true` and redeploy
promptly after inspection. Restoration cleans only new attempts—**no retroactive
sweep of retained messages**. See the [inspection/retention contract](../synthetic-tests/teams/README.md#temporarily-retain-messages-for-inspection)
for channel-growth, soft-deletion and retention limits. Simulation honors the toggle
without creating real content.
Place only public access metadata in an approved serviceAccess file:

```json
{ "teams": { "teamsPublicClientId": "<approved-public-client-UUID>" } }
```

Preserve existing Exchange/SharePoint access metadata. If Teams providers select
application certificates, retain their separate `m365*` metadata too. No bot fields
are needed in delegated mode.

## 3. Deploy foundation, then grant bootstrap access

From the repository root (use the same active profile in every command):
Use **absolute paths** for the root profile, access file and parameter files below;
`npm --prefix synthetic-tests` executes scripts from the Node project directory.

```sh
npm --prefix synthetic-tests run deployment:prepare -- \
  <root-profile.json> <foundation.parameters.json> --access-config <service-access.json>
az deployment group create --resource-group <rg> --name delegated-foundation \
  --template-file synthetic-tests/infra/main.bicep --parameters @<foundation.parameters.json>
az deployment group show --resource-group <rg> --name delegated-foundation \
  --query properties.outputs
```

Foundation remains deployable **before app/user bootstrap**: only live selected Teams
delegated mode creates `stm365${uniqueString(resourceGroup.id, healthModel.name)}`,
container `teams-auth`. Nonsecret outputs are `teamsCacheAccountUrl`,
`teamsCacheContainerId`, `teamsCacheContainer`, `teamsCacheBlob` (`teams-user.msal.json`,
the legacy compatibility name). New account partitions are named
`teams-user.<sha256(lowercaseTenantId + NUL + lowercaseUPN)>.msal.json`, independent
of root target ordering. The storage/container/env contract has not changed.
No cache is embedded in outputs/parameters. Storage uses service-side encryption plus
infrastructure encryption, HTTPS/TLS1.2, no public blob access, no shared keys.
The same-tenant selected Teams UAMI receives **Storage Blob Data Contributor only at
this dedicated container**. Public network access remains enabled for ACA connectivity;
this is RBAC-private storage, not a private-endpoint deployment.

An authorized administrator grants the operator's explicitly logged-in Azure CLI
identity the same role at `teamsCacheContainerId` (not subscription/account scope):

```sh
az role assignment create --assignee-object-id <operator-object-ID> \
  --assignee-principal-type User --role "Storage Blob Data Contributor" \
  --scope <teamsCacheContainerId>
```

Wait for role propagation. The operator CLI identity controls Blob access only;
**the dedicated test user performs the separate Microsoft 365 device-code sign-in**.
Revoke operator Blob access after bootstrap if policy requires it.

## 4. Run human bootstrap

```sh
az login --tenant <tenant-UUID>
npm --prefix synthetic-tests run teams:bootstrap -- \
  --project-config <root-profile.json> \
  --client-id <public-client-UUID> \
  --user-principal-name synthetic-user-1@example.invalid \
  --cache-account-url https://<storage-account>.blob.core.windows.net \
  --timeout-seconds 600
```

Repeat this command for Users2/3, changing only `--user-principal-name`, and have each
user complete their own sign-in. The selector is mandatory when multiple distinct
root accounts are configured; an unconfigured selector is rejected before Blob
access. The original no-selector command remains valid for a single-account root.

Use a separate private browser session for each account, or explicitly choose
**Use another account** before entering the selected UPN. A cached browser session
can otherwise authorize the wrong user; the CLI rejects it without saving that
user's credentials. Every retry prints a new device code: an earlier browser success
page does not complete the new attempt. Finish the final application confirmation,
then require `account-validated`, `cache-persisted-and-lock-released` and exit code 0
from the CLI before declaring bootstrap successful. Keep device-code output
unbuffered; run directly, or use `jq --unbuffered` when filtering diagnostics.

The CLI explicitly uses `AzureCliCredential` for Blob access; runtime never does.
It prints the verification URL/device code, safe phase events (elapsed seconds and
nonsecret partition blob name), and a safe completion/failure event. Phase events
distinguish waiting for the cache lease, token polling/pending, token response,
account validation and confirmed persistence/lease release; they contain no tokens,
serialized cache, raw identity error bodies or user password.
Failures additionally include a bounded `reason` and safe `errorCode`, plus HTTP
status/numeric Entra error code when available. Reasons distinguish `timeout`,
`cancelled`, `user-denied`, recognized CA/MFA `policy`, `wrong-account`, `storage`,
`lease` and other `authentication`/`configuration` errors. Unrecognized identity
payloads are not printed or guessed to be policy failures.

| Last failing phase / reason | Next approved check |
| --- | --- |
| Token polling / `timeout` | The CLI did not receive a usable token before its deadline. Confirm the exact current code/app/account and review Entra sign-in/policy evidence; browser success alone is not persisted-cache success. |
| Token endpoint rejected / `user-denied` or `policy` | Review the safe OAuth/numeric Entra code with the tenant administrator; do not bypass policy or automate MFA. |
| Token response received / `wrong-account` | Sign in as the explicitly selected configured UPN in the correct tenant. |
| Cache access / `storage` | Verify operator Azure CLI login, container-scoped data role and storage reachability; HTTP 403 is distinct from user consent. |
| Cache acquiring/writing/releasing / `lease` | Wait for the earlier bounded bootstrap/refresh or lease expiry; inspect safe metadata only. Never break an active lease blindly. |

The installed MSAL SDK is tested with HTTP-faked device authorization through
pending → token response → account validation → leased cache persistence → silent
reuse, plus cancellation and policy/denial paths. This does not diagnose a real
tenant timeout by itself. No MSAL cache plugin re-enters the Blob lease/mutex.
Open the URL and personally sign in as the exact selected test user, completing the
approved MFA/CA requirements. Never paste tokens, serialized caches or passwords into
chat, files, environment parameters or images. Timeout accepts 30–900 seconds; Ctrl-C
or SIGTERM cancels. Wrong username/tenant or failed policy/consent leaves any prior
cache unchanged. Initial failure may leave an empty blob, which workers treat as
`reauthentication-required`.

Each account has its own encrypted-at-rest cache blob and lock. Bootstrap reads and
writes **only the selected account's partition**; wrong-user/failed bootstrap cannot
overwrite another user's blob. A stalled refresh or human sign-in does not hold
healthy users' cache locks. The CLI holds a renewable 60-second Blob lease; refresh/bootstrapping writes require
both lease ID and ETag. Competing leases/ETags fail closed without overwriting state.
Worker calls serialize within one process **per account**. Lease renewal failure aborts the write;
after a crash the lease expires within 60 seconds. A transient lease conflict yields
monitoring-auth failure and can recover next cycle. No local cache file is written.
Storage is encrypted at rest, **not client-side encrypted**; container data roles are
sensitive token access and must be tightly controlled. Azure-owned encryption keys
are the default; CMK/private endpoints are not implemented.
Migration preserves the original User1 blob: the new worker checks the legacy cache
only when an account partition is absent/empty and still strictly requires the exact
expected username/tenant/object ID. Other accounts cannot reuse User1's token. A
present partition with revoked/interaction-required credentials never falls back to
legacy state. New bootstrap commands write partitions, not the legacy blob; therefore
old single-account worker images must be upgraded before they can consume a new
bootstrap. An already running old bootstrap may finish unchanged into the legacy
blob, which the new worker can read. Do not interrupt or overlap operator bootstrap
processes; let the current attempt complete/cancel before starting its replacement.
Incremental deployment or switching to bot/simulation does not delete an existing
cache or revoke its old grants. An approved retirement must explicitly revoke the
user/app sessions and remove cache/access according to tenant retention policy.

## 5. Roll out and verify

```sh
npm --prefix synthetic-tests run deployment:prepare -- \
  <root-profile.json> <workers.parameters.json> <built-image> --enable-live \
  --access-config <service-access.json>
az deployment group create --resource-group <rg> --name delegated-workers \
  --template-file synthetic-tests/infra/main.bicep --parameters @<workers.parameters.json>
```

Preserve any separately supplied protected `serviceCertificates` parameter required
by an existing native-certificate service. Do not put those keys into ordinary files.

Bicep supplies nonsecret `TEAMS_PUBLIC_CLIENT_ID`, `TEAMS_CACHE_ACCOUNT_URL`,
`TEAMS_CACHE_CONTAINER=teams-auth`, `TEAMS_CACHE_BLOB=teams-user.msal.json`, plus the
explicit `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`. Metadata/profile changes roll revisions.
`TEAMS_CACHE_BLOB` identifies the compatibility blob; account-partition names are
derived internally from the root-owned tenant/UPN, never independently configured.
Optional providers continue to use application Graph MI/certificate credentials;
ARM health reports remain on the selected UAMI.

Acceptance must first show missing-cache `reauthentication-required` with skipped
business actions and real report ingestion (not a fabricated Teams outage). After
bootstrap, verify both real journeys for all three accounts, each actual posting user ID, correlated readback,
softDelete reply-before-parent and active-content disappearance, plus health-report
ingestion. SoftDelete retains content according to tenant retention; never claim
permanent erasure. Each cycle reloads auth cache, so recovery requires **no restart**.
Workers retain no journey state; tokens/cache never appear in health reports.
One account's missing/revoked auth produces two failed journey attempts with skipped
actions while the other users continue. Each journey aggregate should show
`attempted: 3`; `succeeded` is 3 when all complete, or 2 with one unexecutable account.

Revocation, CA claims challenges, consent removal and MFA/sign-in-frequency changes
can require a human re-bootstrap using the same command. Worker cannot satisfy them
interactively; missing/wrong cache and interaction-required errors are explicit
`reauthentication-required`; storage/lease/401/claims failures are monitoring auth
failures. No bot fallback. Journey timeout bounds token/HTTP work, silent auth is
additionally capped at 15 seconds, HTTP calls at 15 seconds; cleanup has the existing
separate bounded grace. Auth state is the only persistent state. Existing operational
stopped-worker/stale-report/notification safeguards remain required.
