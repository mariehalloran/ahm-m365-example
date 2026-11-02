# Teams synthetic journeys

This service validates Teams messaging and calling experiences using paired bots and Microsoft Graph.

## Journeys

| Scenario | Summary |
| --- | --- |
| `channel-conversation` | Each pair's primary bot posts a root message and reply; Graph verifies both |
| `scheduled-meeting` | Both bots join an existing meeting, verify metadata/rosters, leave and confirm disconnection |

## Required setup

1. Follow [Teams permissions and setup](../../docs/teams-permissions.md) and configure ungrouped targets in root [monitoring.config.json](../../monitoring.config.json).
2. Select every managed-identity bot pair (two independent pairs in the checked-in config), install each primary bot's app, configure federated readback and the signed calling callback. No bot secrets or employee sign-in are used.
3. Resolve generated IDs:
   ```sh
   npm run setup:ids
   ```

## Run one cycle

Run from [synthetic-tests/](../) on a host with the configured managed identities
for live execution.

```sh
npm run teams -- --once
npm run teams -- --tenant <alias> --once
```

## Runtime behavior

- Every selected pair exercises every selected target on the 300-second cadence; Teams has no user groups.
- Each complete call or conversation journey has a 240-second execution deadline shared by its steps.
- Latency thresholds remain 15 seconds Degraded and 60 seconds Unhealthy, separately from the execution deadline.
- The checked-in lane starts all six pair/target attempts concurrently. Cleanup settlement allows 12 seconds and publication 30 within a 299-second whole-cycle envelope.
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
