# Exchange synthetic journeys

This service validates mailbox and calendar flows through Microsoft Graph using configured test users.

## Journeys

| Scenario | Summary |
| --- | --- |
| `send-receive-mail` | Send to self and confirm delivery in the same mailbox's Inbox |
| `edit-reopen-draft` | Create draft, reopen, edit, and validate saved changes |
| `attachment-mail` | Send an attachment to self, download it and verify its content hash |
| `reply-mail` | Send a SELF-REPLY to a retained self-addressed fixture and verify its correlated delivery |
| `recurring-calendar` | Create, verify, update and delete a private recurring series without attendees |

## Required setup

1. Follow [Exchange permissions and setup](../../docs/exchange-permissions.md) and configure dedicated mailbox targets in root `monitoring.config.json`.
2. Run ID resolution:
   ```sh
   npm run setup:ids
   ```
3. If `reply-mail` is enabled, provision reply seeds:
   ```sh
   npm run setup:reply-seeds
   ```

## Run locally

```sh
npm run exchange -- --once
npm run exchange -- --tenant <alias> --once
```

Mailbox verification helper:

```sh
npm run exchange:mail-test -- --tenant <alias>
```

## Scheduling notes

- Cycles align to five-minute boundaries and run every selected journey for every mailbox.
- Each complete journey has a 240-second execution deadline shared by its steps; latency thresholds stay at 15 seconds Degraded and 60 seconds Unhealthy.
- Cleanup has an independent 10-second budget. Worker cancellations and cleanup-only failures report Unknown; genuine service failures and journey deadline expiry remain failures.
- Cleanup settlement allows 12 seconds and publication another 12, inside a 299-second slot envelope. Capacity diagnostics use `exchange-cycle-capacity`; Graph request permits remain 32 global/two per mailbox in the checked-in config.

## Diagnostics

Journey output includes:

- step status and latency
- Graph request failures with operation labels
- message, draft, or event IDs used during cleanup

## Related docs

- Worker runtime: [shared utilities](../utils/README.md)
- Root setup and deployment: [repository overview](../../README.md)
