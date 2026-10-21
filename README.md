# Monitoring M365 with Azure Monitor Health Models

**A service being available does not necessarily mean a user can complete their task.**

Microsoft 365 can report that Exchange is operational while a particular mailbox cannot send or receive email. An upload request can succeed while reopening the file fails. A Teams message can be accepted without appearing where it is expected.

This example combines **synthetic user journeys** with **Azure Monitor Health Models** to close that visibility gap:

- **Synthetic tests provide evidence:** can a representative task actually be completed?
- **Azure Monitor Health Models provides context:** which action, journey, and service experience does that evidence affect?

## Why synthetic tests?

Provider status and infrastructure metrics are useful, but they do not exercise our approved identities, resources, permissions, and access paths together.

Synthetic tests repeatedly perform a small, controlled workflow against dedicated test resources. They help us:

- **Detect problems proactively**, including when there is little real user traffic.
- **Verify completion, not just API acceptance.** Sending a request is different from confirming delivery, publication, or correct file readback.
- **Identify the failing action.** Authentication, sending, confirmation, and cleanup have different failure modes.
- **Measure the experience over time**, including success and duration, rather than relying on a single manual check.

For example, an email journey creates a draft, sends it, confirms that it appears in the Inbox, and cleans up. If sending succeeds but delivery confirmation times out, the evidence should preserve that distinction instead of labeling every action as failed.

A failed test is **evidence to investigate, not automatic proof of a Microsoft outage**. Identity permissions, configuration, worker connectivity, and the monitoring system itself can also fail.

## Why Azure Monitor Health Models?

Individual measurements tell us what happened in an attempt. A health model connects those observations to the experiences we care about.

Azure Monitor Health Models lets us:

- **Represent dependencies explicitly:** actions support journeys, journeys support service experiences, and service models contribute to a broader view.
- **Roll up health without losing detail:** start at the overall experience and follow the model to the affected journey or action.
- **Combine different evidence sources:** evaluated synthetic health reports can coexist with optional telemetry signals and separate Microsoft-reported context.
- **Keep evidence gaps visible:** no observations are not the same as successful observations, and a skipped action is not a failed request.
- **Compose independent models:** Exchange, Teams, and SharePoint can each have their own model while a root model brings their health together.

The model complements logs, metrics, and dashboards; it does not replace detailed investigation or establish the root cause of a failure. Its value is relating evidence to dependencies and potential experience impact.

## Why use them together?

| Source | Question it answers | What it does not establish |
| --- | --- | --- |
| Microsoft 365 Service Health | What does Microsoft report about the subscribed service? | Whether our particular workflow works |
| Synthetic journey | Can our configured identity complete the approved workflow, and where does it fail? | Availability for every user, target, or access path |
| Azure Monitor Health Models | How does that evidence contribute to action, journey, service, and overall experience health? | Root cause or successful notification delivery |
| Optional logs and metrics | What measurements and diagnostics help explain the result over time? | A meaningful dependency model by themselves |

Together, they provide a way to distinguish **provider-reported health**, **observed task completion**, and **the health of the experiences built on those tasks**.

```text
Root experience model
|
+-- Exchange model
|   `-- Send/receive email journey -> action health
+-- Teams model
|   `-- Publish channel message journey -> action health
`-- SharePoint model
    `-- Save/reopen file journey -> action health
```

Workers aggregate journey/action results and submit health reports directly. **OpenTelemetry and Log Analytics are optional**, not prerequisites for reporting health. When enabled, their signals add historical evidence on the same entities. Microsoft-reported Service Health remains separate supporting context, not a replacement for synthetic results.

## What this example exercises

| Service | Representative journey |
| --- | --- |
| [Exchange](./synthetic-tests/exchange/README.md) | Create an email, send it to the dedicated mailbox itself, confirm Inbox delivery, and clean up |
| [Teams](./synthetic-tests/teams/README.md) | Publish a bot-owned channel message, confirm its marker and author through Graph, and remove it |
| [SharePoint](./synthetic-tests/sharepoint/README.md) | Upload synthetic content to an approved library, reopen and verify it, and remove it |

These are **API-backed journeys**, not Outlook/Teams/browser sign-in tests, employee read receipts, Teams media tests, or SharePoint coauthoring tests. A successful test is not tenant-wide availability or a guarantee of every employee's experience.

The checked-in settings enable all supported services and journey scenarios, but use **safe simulation** by default. A controlled live failure-path trial can exercise real authentication/operations before the test resources work: observed failures make journeys Unhealthy, not artificially healthy. Successful journeys, scoped permissions, and end-to-end notifications still require validation. See the [shared worker deployment guide](./synthetic-tests/infra/README.md) for hosting and rollout.

## How to use this example

### 1. Update the project configuration

Edit [monitoring.config.json](./monitoring.config.json), or keep a private copy outside source control:

| What to update | Where |
| --- | --- |
| Services to monitor | `services.exchange.enabled`, `services.teams.enabled`, `services.sharepoint.enabled` |
| Journeys to run | Each service's `scenarios` switches |
| Dedicated mailbox addresses | `services.exchange.targets[].mailbox` |
| Approved Teams resources | `services.teams.targets[]`: tenant, team, channel, and bot conversation service URL |
| Approved SharePoint resources | `services.sharepoint.targets[]`: site, drive, and folder IDs |
| Health-report destination and policy | `healthModel`: replace the subscription placeholder and confirm resource group, model name, thresholds, and report TTL |
| Optional telemetry | `otel.enabled`; use `otel.destination: "azure-monitor"` only when Azure ingestion is configured |

All supported services/scenarios are selected by default. Target placeholders are not provisioned resources. Keep credentials, certificates, and connection strings out of configuration files and source control.

### 2. Adjust service-specific behavior

The [Exchange](./synthetic-tests/exchange/config.json), [Teams](./synthetic-tests/teams/config.json), and [SharePoint](./synthetic-tests/sharepoint/config.json) files contain **only service-specific settings**: independent cadence, timeout, simulation/live mode, authentication, cohort, and optional provider collection. Selection, targets, and OTEL are configured **only at the root**, not duplicated in these files.

For older private service configs, move targets into the root file and remove the old `enabled`, `targets`, and `telemetry` keys; the loader now rejects these redundant fields.

The service config's `scenario` chooses a deterministic simulation outcome; root `scenarios` chooses which user journey to monitor.

### 3. Run a safe simulation

With Node.js 22 or 24, run from the repository root:

```sh
npm --prefix synthetic-tests ci
npm --prefix synthetic-tests run exchange -- --once
npm --prefix synthetic-tests run teams -- --once
npm --prefix synthetic-tests run sharepoint -- --once
```

These defaults make no Microsoft 365 or Azure calls. Inspect result records and `health-report-preview` output. Each command runs only its selected service; omit `--once` to repeat on that service's cadence. For a private root config, append `--project-config /absolute/path/monitoring.config.json`.

### 4. Prepare and validate live monitoring

Establish the selected [health models](./health-model/README.md), obtain dedicated test resources, and authorize the service identity for both the Microsoft 365 journey and health-report ingestion. Update root targets/destination, select an approved live service file through `configFile`, and explicitly set `ENABLE_LIVE_M365=true`. Prove one live cycle before enabling recurrence or hosting independent workers.

With OTEL disabled, direct health reports still update journey/action entities. To add Azure telemetry, enable root OTEL, configure workspace-based Application Insights, and supply `APPLICATIONINSIGHTS_CONNECTION_STRING` securely. Follow the [administrator setup](./synthetic-tests/README.md#administrator-setup-enable-authentication-and-live-tests) and [deployment guide](./docs/deployment.md); selecting live mode does not grant permissions or deploy resources.

## Further guidance

- [Project configuration](./monitoring.config.json): select services, scenarios, accounts/targets, and optional OTEL.
- [Synthetic test guide](./synthetic-tests/README.md): run safely, configure workers, and understand journey coverage.
- [Health model guide](./health-model/README.md): model composition, signals, aggregation, and deployment.
- [Deployment guide](./docs/deployment.md): hosting, identities, permission boundaries, and rollout.
- [Operations guide](./docs/operations.md): report freshness, monitoring failures, notifications, and production acceptance.

Independent monitoring is essential: a stopped worker or broken reporting path must not be mistaken for a healthy service. Neither a health report nor a model state is, by itself, an alert-delivery system.
