# Teams synthetic journeys

This service validates Teams messaging and calling experiences using paired bots and Microsoft Graph.

## Journeys

| Scenario | Summary |
| --- | --- |
| `channel-conversation` | Each pair's primary bot posts a root message and reply; Graph verifies both |
| `scheduled-meeting` | Both bots join an existing meeting, verify metadata/rosters, leave and confirm disconnection |

## Required setup

1. Follow [Teams permissions and setup](../../docs/teams-permissions.md) and configure ungrouped targets in root `monitoring.config.json`.
2. Select every managed-identity bot pair (two independent pairs in the checked-in config), install each primary bot's app, configure federated readback and the signed calling callback. No bot secrets or employee sign-in are used.
3. Resolve generated IDs:
   ```sh
   npm run setup:ids
   ```

## Run locally

```sh
npm run teams -- --once
npm run teams -- --tenant <alias> --once
```

## Runtime behavior

- Every selected pair exercises every selected target on the checked-in 120-second cadence; Teams has no user groups.
- Each complete call or conversation journey has a 60-second execution deadline shared by its steps.
- The latency degradation threshold remains 15 seconds, separately from the execution deadline.
- Worker cancellations and cleanup-only failures report Unknown, without hiding genuine service failures or successful business steps.
- Cancelled call phases have no numeric sample; internal cancellation teardown does not invent a business departure measurement.
- Results include step timing and call/conversation operation status.

## Diagnostics

Use these when troubleshooting:

- container logs for callback and call-state transitions
- journey result payload for failed step name and Graph/call error details

## Related docs

- Worker runtime: [shared utilities](../utils/README.md)
- Root deployment and operations: [repository overview](../../README.md)
