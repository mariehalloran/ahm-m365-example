# Teams synthetic journeys

This service validates Teams messaging and calling experiences using paired bots and Microsoft Graph.

## Journeys

| Scenario | Summary |
| --- | --- |
| `channel-conversation` | Post message in a channel and confirm readback |
| `scheduled-meeting` | Create meeting, join call path, and validate completion |

## Required setup

1. Configure Teams targets in root `monitoring.config.json`.
2. Configure bot pairs and callback settings:
   - bot app IDs and secrets
   - readback app credentials
   - callback URL and callback authentication reference
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

- Each cycle executes configured scenarios for each target/group lane.
- Each complete call or conversation journey has a 60-second execution deadline shared by its steps.
- Worker cancellations and cleanup-only failures report Unknown, without hiding genuine service failures or successful business steps.
- Cancelled call phases have no numeric sample; internal cancellation teardown does not invent a business departure measurement.
- Results include step timing and call/conversation operation status.

## Diagnostics

Use these when troubleshooting:

- container logs for callback and call-state transitions
- journey result payload for failed step name and Graph/call error details

## Related docs

- Worker runtime: `../utils/README.md`
- Root deployment and operations: `../../README.md`
