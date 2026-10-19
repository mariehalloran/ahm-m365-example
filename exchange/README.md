# Exchange: send email and confirm arrival

The employee goal is **send an email and have it arrive**, not merely receive an HTTP success response.

The [journey](./src/journey.ts) orchestrates separately exported [actions](./src/steps.ts): `authenticate`, `createDraft`, `sendMessage`, `confirmDelivery`, and `cleanup`. It creates a draft in one dedicated mailbox, sends it to itself, waits for the exact message in its Inbox, and cleans up only that test's copies. A distinct sender/recipient pair and Outlook UI testing are not implemented.

The fixed journey ID is `send-receive-mail`, with ordered step IDs `authenticate`, `create-draft`, `send`, `confirm-delivery`, `cleanup`. Each executed step records 1/0 and seconds through the shared measured-step helper. A failed prerequisite skips downstream operations; cleanup still runs after an attempted mutation with its own ten-second budget. Cleanup failure makes the overall result zero without rewriting prior successful steps or delivery timing.

OTel reports success as **1 or 0** and separately measures **send request time**, **confirmed delivery time**, and **total attempt time**. Request acceptance is not delivery. Failed send requests still report their elapsed time.

- [Config and independent cadence](./config.json)
- [Administrator resource/permission request](../MAILBOX-SYNTHETIC-ACCESS.md)
- [HTTP tests](./tests/probe.test.ts)
- [Analytics queries](./queries/analytics/), [model queries](./queries/health-model/)

Start safely from the repository root:

```sh
npm run exchange -- --once
# Compiled equivalent after npm run build:
node dist/exchange/src/worker.js --once
```

The checked-in config simulates results without sending email or initializing credentials. Simulation is deterministic and labeled modeled, including failures, timeout steps, and stale timestamps. Live operation requires dedicated approved resources and `ENABLE_LIVE_M365=true`; the [live example](./config.live.example.json) stays disabled until approval.

## API operations

All paths are relative to `https://graph.microsoft.com/v1.0`; identifiers and query parameters are URL-encoded.

| Action | Method and endpoint | Verification |
| --- | --- | --- |
| Create draft | `POST /users/{mailbox}/messages` | Fixed synthetic body, UUID subject/header, same dedicated recipient; no retry after ambiguous creation |
| Send | `POST /users/{mailbox}/messages/{draftId}/send` | Acceptance only, not delivery; ambiguous send is not retried |
| Confirm delivery | `GET /users/{mailbox}/mailFolders/inbox/messages?$filter=subject eq '{uniqueSubject}'&$select=id&$top=100` | Exact run marker appears in Inbox within timeout |
| Locate owned copies | `GET /users/{mailbox}/messages?$filter=subject eq '{uniqueSubject}'&$select=id&$top=100` | Exact marker only; incomplete cleanup pagination fails |
| Cleanup | `DELETE /users/{mailbox}/messages/{messageId}` | Only known/correlated draft, sent, or received IDs; never purge the mailbox |

`sendDurationMs` excludes authentication/draft/polling/cleanup. `deliveryDurationMs` includes send initiation and polling, not exact transport latency; it is absent when unconfirmed. `durationMs` includes cleanup. Late delivery can leave a retained artifact requiring ownership-checked review. Normal deletion can leave Deleted Items/compliance copies.

## Identity

Hosted Graph uses `graphAuthentication: "managed-identity"` (the default) and requires a valid explicit `AZURE_CLIENT_ID`. Only `ManagedIdentityCredential({ clientId })` is constructed, for `https://graph.microsoft.com/.default`; there is no CLI, default credential, system-identity guess, client-secret, certificate, or Key Vault fallback.

For approved local live development only, explicitly choose `graphAuthentication: "certificate"` and provide `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_CERTIFICATE_PATH`. Scope `Application Mail.ReadWrite` and `Application Mail.Send` through Exchange RBAC for Applications to dedicated mailboxes only; **do not grant tenant-wide Entra Graph mail application permissions**. The approved hosted identity must be in the mailbox tenant.

This proves neither employee login/MFA, Outlook rendering, external delivery, nor tenant-wide availability. Embedded OTel reports measurements; it does not evaluate or persist health.

## Microsoft references

- [Create a draft](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0)
- [Send a draft](https://learn.microsoft.com/en-us/graph/api/message-send?view=graph-rest-1.0)
- [List messages](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
- [Delete a message](https://learn.microsoft.com/en-us/graph/api/message-delete?view=graph-rest-1.0)
