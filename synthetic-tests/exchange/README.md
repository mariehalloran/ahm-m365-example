# Exchange: send email and confirm arrival

The employee goal is **send an email and have it arrive**, not merely receive an HTTP success response.

The [journey](./src/journey.ts) orchestrates separately exported [actions](./src/steps.ts): `authenticate`, `createDraft`, `sendMessage`, `confirmDelivery`, and `cleanup`. It creates a draft in one dedicated mailbox, sends it to itself, waits for the exact message in its Inbox, and cleans up only that test's copies. A distinct sender/recipient pair and Outlook UI testing are not implemented.

Journey `send-receive-mail` has business-step entities `create-draft`, `send`, and `confirm-delivery`. A second journey, `edit-reopen-draft`, uses `create-draft`, `update-draft`, and `read-draft` beneath its separate `exchange-draft` entity. Step IDs are prefixed with the journey entity ID. Each journey/step receives direct success/duration reports in **External Reports**, its only signal group. Token acquisition and cleanup are internal, with no published steps or standalone health signals. Failed prerequisites skip downstream operations; cleanup still runs after an attempted mutation with its own ten-second budget. Its failures remain journey diagnostics without rewriting prior business-action successes or delivery timing.

The [draft journey](./src/draft-journey.ts) reuses draft creation, then [edits and reopens](./src/draft-steps.ts) the same owned draft to verify its marker, edited content and draft state. It never sends mail. Both journeys are enabled independently at the root and share this worker, target mailboxes and cadence.

Each attempt contributes success as **1 or 0** to cycle aggregation. Console observations separately measure **send request time**, **confirmed delivery time**, and **total attempt time**. Request acceptance is not delivery. Failed send requests still retain their elapsed time.

- [Config and independent cadence](./config.json)
- [Administrator resource/permission request](../../MAILBOX-SYNTHETIC-ACCESS.md)
- [HTTP tests](./tests/probe.test.ts)

Start safely from the `synthetic-tests/` project directory:

```sh
npm run exchange -- --once
# Compiled equivalent after npm run build:
node dist/exchange/src/worker.js --once
```

The checked-in config simulates results without sending email or initializing credentials. Simulation is deterministic and labeled modeled, including failures, timeout steps, and stale timestamps. The [live settings example](./config.live.example.json) selects live mode, but requires approved root mailbox targets/model destination, root service/scenario selection, scoped permissions, and explicit `ENABLE_LIVE_M365=true`.

## API operations

All paths are relative to `https://graph.microsoft.com/v1.0`; identifiers and query parameters are URL-encoded.

| Action | Method and endpoint | Verification |
| --- | --- | --- |
| Create draft | `POST /users/{mailbox}/messages` | Fixed synthetic body, UUID subject/header, same dedicated recipient; no retry after ambiguous creation |
| Edit owned draft | `PATCH /users/{mailbox}/messages/{draftId}` | Update only this run's known draft with correlated synthetic content |
| Reopen draft | `GET /users/{mailbox}/messages/{draftId}` | Verify the expected owned draft and edited content; acceptance of PATCH alone is not success |
| Send | `POST /users/{mailbox}/messages/{draftId}/send` | Acceptance only, not delivery; ambiguous send is not retried |
| Confirm delivery | `GET /users/{mailbox}/mailFolders/inbox/messages?$filter=subject eq '{uniqueSubject}'&$select=id&$top=100` | Exact run marker appears in Inbox within timeout |
| Locate owned copies | `GET /users/{mailbox}/messages?$filter=subject eq '{uniqueSubject}'&$select=id&$top=100` | Exact marker only; incomplete cleanup pagination fails |
| Cleanup | `DELETE /users/{mailbox}/messages/{messageId}` | Only known/correlated draft, sent, or received IDs; never purge the mailbox |

`sendDurationMs` excludes authentication/draft/polling/cleanup. `deliveryDurationMs` includes send initiation and polling, not exact transport latency; it is absent when unconfirmed. `durationMs` includes cleanup. Late delivery can leave a retained artifact requiring ownership-checked review. Normal deletion can leave Deleted Items/compliance copies.

## Identity

Hosted Graph uses `graphAuthentication: "managed-identity"` (the default) and requires a valid explicit `AZURE_CLIENT_ID`. Only `ManagedIdentityCredential({ clientId })` is constructed, for `https://graph.microsoft.com/.default`; there is no CLI, default credential, system-identity guess, client-secret, certificate, or Key Vault fallback.

For approved local live development only, explicitly choose `graphAuthentication: "certificate"` and provide `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_CERTIFICATE_PATH`. Scope `Application Mail.ReadWrite` and `Application Mail.Send` through Exchange RBAC for Applications to dedicated mailboxes only; **do not grant tenant-wide Entra Graph mail application permissions**. The approved hosted identity must be in the mailbox tenant.

This proves neither employee login/MFA, Outlook rendering, external delivery, nor tenant-wide availability. The [root config](../../monitoring.config.json) selects both journeys and their mailbox targets. The shared worker aggregates this cycle's journey/actions and publishes direct health reports to separate journey/business-step entities in the Exchange model. No history is persisted; reports replace cycle aggregates rather than providing a full metrics store or percentiles. See [reporting/configuration](../utils/README.md#per-cycle-health-reports).

## Microsoft references

- [Create a draft](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0)
- [Send a draft](https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0)
- [List messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
- [Delete a message](https://learn.microsoft.com/en-us/graph/api/message-delete?view=graph-rest-1.0)

## Optional provider context and diagnostics

[exchangeProviders](./src/providers.ts) is injected into the same worker and collects once per cycle, not per mailbox or journey. Simulation defaults off; the live example enables stable Service Health independently of journey initialization:

- `serviceHealth: true` reads `/v1.0/admin/serviceAnnouncement/healthOverviews` and `/issues`, filtering exact `Exchange Online`. Separate `ServiceHealth.Read.All` admin consent is required. Overview status reports directly to `exchange-service-health` as `microsoft-reported-service-status`: 100 healthy, 50 degraded, 0 interruption, with `impactSuppressed`. Failed/missing/unknown overview status reports Unknown without a value and with failure context. The existing trial receives Graph 403 pending consent. Issue metadata/history never supplies journey health.
- `serviceActivity.enabled: true` requires `ENABLE_BETA_SERVICE_ACTIVITY=true` plus separately approved `ServiceActivity-Exchange.Read.All`. Its only/default function is `getConnectivityMetricsForExchange`, returning Microsoft-estimated connectivity percentages. The beta API is experimental/unsupported for production and **diagnostic-only, never bubbles into Experience/journey health**.

Defaults are 15-minute aggregation and 30-minute lookback. Allowed aggregation is 5/10/15/30; lookback must be a multiple, at most one day. The UTC-floored beta historical window contains console diagnostic snapshots, never synthetic/step samples or request counters. Simulation skips sources without Graph credentials/network, and provider failures cannot change a successful mail journey's 1/0.

See the [strict config and console diagnostic contract](../utils/README.md#optional-provider-collectors) and [mocked collector tests](../utils/tests/providers.test.ts). No provider permission or successful live tenant access is established by those tests.

- [List health overviews](https://learn.microsoft.com/graph/api/serviceannouncement-list-healthoverviews?view=graph-rest-1.0)
- [List issues](https://learn.microsoft.com/graph/api/serviceannouncement-list-issues?view=graph-rest-1.0)
- [Exchange connectivity beta report](https://learn.microsoft.com/graph/api/serviceactivity-getconnectivitymetricsforexchange?view=graph-rest-beta)
