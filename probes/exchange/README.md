# Exchange: send email and confirm arrival

The employee goal is **send an email and have it arrive**, not merely receive an HTTP success response.

The current [journey code](./src/probe.ts) creates a draft in one dedicated mailbox, sends it to itself, waits for the exact message in its Inbox, and cleans up only that test's copies. A distinct sender/recipient pair and Outlook UI testing are not implemented.

- [Journey steps, exact endpoints, measurements, and limits](../README.md#exchange-send-and-confirm-email-arrival)
- [Config and independent cadence](./config.json)
- [Administrator resource/permission request](../../MAILBOX-SYNTHETIC-ACCESS.md)

Start safely from the repository root:

```sh
npm run probe -- --config probes/exchange/config.json --once
```

The checked-in config simulates results without sending email. Live operation needs approved resources, certificate credentials, and explicit opt-in. Embedded OTel reports measurements; it does not evaluate or persist health.
