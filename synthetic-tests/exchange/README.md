# Exchange synthetic journeys

This service validates mailbox and calendar flows through Microsoft Graph using configured test users.

## Journeys

| Scenario | Summary |
| --- | --- |
| `send-receive-mail` | Send from sender mailbox and confirm receipt in receiver mailbox |
| `edit-reopen-draft` | Create draft, reopen, edit, and validate saved changes |
| `attachment-mail` | Send mail with attachment and verify attachment metadata |
| `reply-mail` | Reply to seeded conversation and verify response handling |
| `recurring-calendar` | Create recurring event and verify generated instances |

## Required setup

1. Configure Exchange targets in root `monitoring.config.json`.
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

- Cycles align to minute boundaries.
- Journey deadlines are split into two windows:
  - first check at 15 seconds
  - hard deadline at 30 seconds

## Diagnostics

Journey output includes:

- step status and latency
- Graph request failures with operation labels
- message, draft, or event IDs used during cleanup

## Related docs

- Worker runtime: `../utils/README.md`
- Root setup and deployment: `../../README.md`
