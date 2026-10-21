# Monitoring M365 with Azure Monitor Health Models

**A service being available does not necessarily mean a user can complete their task.**

Microsoft 365 can report that Exchange is operational while a particular mailbox cannot send or receive email. An upload request can succeed while reopening the file fails. A Teams message can be accepted without appearing where it is expected.

This example combines **synthetic user journeys** with **Azure Monitor Health Models** to close that visibility gap:

- **Synthetic tests provide evidence:** can a representative task actually be completed?
- **Azure Monitor Health Models provides context:** which action, journey, and service experience does that evidence affect?

![Exchange health model showing send-and-receive email and save-edit-reopen draft journeys, their business-step entities, and separate Service Health context.](./docs/images/exchange-health-model.png)

*Exchange Experience: two journeys with business-step entities and separate, impact-suppressed Service Health context.*

## Why synthetic tests?

Provider status and infrastructure metrics are useful, but they do not exercise our approved identities, resources, permissions, and access paths together.

Synthetic tests repeatedly perform a small, controlled workflow against dedicated test resources. They help us:

- **Detect problems proactively**, including when there is little real user traffic.
- **Verify completion, not just API acceptance.** Sending a request is different from confirming delivery, publication, or correct file readback.
- **Identify the failing business action.** Draft creation, sending, and delivery confirmation have different failure modes; identity and cleanup errors remain journey diagnostics.
- **Repeat the observation**, including success and duration, rather than relying on a single manual check.

For example, an email journey creates a draft, sends it, confirms that it appears in the Inbox, and cleans up. If sending succeeds but delivery confirmation times out, the evidence should preserve that distinction instead of labeling every action as failed.

A failed test is **evidence to investigate, not automatic proof of a Microsoft outage**. Identity permissions, configuration, worker connectivity, and the monitoring system itself can also fail.

## Why Azure Monitor Health Models?

Individual measurements tell us what happened in an attempt. A health model connects those observations to the experiences we care about.

Azure Monitor Health Models lets us:

- **Represent dependencies explicitly:** actions support journeys, journeys support service experiences, and service models contribute to a broader view.
- **Roll up health without losing detail:** start at the overall experience and follow the model to the affected journey or action.
- **Separate different evidence sources:** evaluated synthetic health reports coexist with impact-suppressed Microsoft-reported context.
- **Keep evidence gaps visible:** no observations are not the same as successful observations, and a skipped action is not a failed request.
- **Compose independent models:** Exchange, Teams, and SharePoint can each have their own model while a root model brings their health together.

The model complements logs, metrics, and dashboards; it does not replace detailed investigation or establish the root cause of a failure. Its value is relating evidence to dependencies and potential experience impact.

## Why use them together?

| Source | Question it answers | What it does not establish |
| --- | --- | --- |
| Microsoft 365 Service Health | What does Microsoft report about the subscribed service? | Whether our particular workflow works |
| Synthetic journey | Can our configured identity complete the approved workflow, and where does it fail? | Availability for every user, target, or access path |
| Azure Monitor Health Models | How does that evidence contribute to action, journey, service, and overall experience health? | Root cause or successful notification delivery |
| Worker console diagnostics | What execution, permission, or publication failure needs investigation? | A persistent metrics store or independent failure detection |

Together, they provide a way to distinguish **provider-reported health**, **observed task completion**, and **the health of the experiences built on those tasks**.

```text
Root experience model
|
+-- Exchange model
|   +-- Send/receive email journey -> business-step entities
|   `-- Edit/reopen draft journey -> business-step entities
+-- Teams model
|   +-- Publish channel message journey -> business-step entities
|   `-- Reply in channel thread journey -> business-step entities
`-- SharePoint model
    +-- Save/reopen file journey -> business-step entities
    `-- Rename/reopen file journey -> business-step entities
```

Workers aggregate each cycle's journey/action results and submit health reports directly. Each journey and business-step entity has only an **External Reports** signal group. With all six journeys selected, the family has **four models, 34 entities, and 30 relationships**, including **18 business-step entities**. Microsoft-reported Service Health publishes to a separate, impact-suppressed entity under each service Experience, not as a replacement for synthetic results. Token acquisition and cleanup execute internally without their own entities or published step data.

Reports replace the previous cycle's aggregates; they are not a full metrics store, percentile history, or arbitrary log-query interface. Workers retain no cross-cycle history or durable outbox. Console diagnostics remain available for investigation.

## What this example exercises

| Service | Representative journey |
| --- | --- |
| [Exchange](./synthetic-tests/exchange/README.md) | Create an email, send it to the dedicated mailbox itself, confirm Inbox delivery, and clean up |
| Exchange | Save a draft, edit its content, reopen and verify it, and clean up without sending |
| [Teams](./synthetic-tests/teams/README.md) | Publish a bot-owned channel message, confirm its marker and author through Graph, and remove it |
| Teams | Create a test thread, post a bot-owned reply, confirm that reply through Graph, and remove owned activities |
| [SharePoint](./synthetic-tests/sharepoint/README.md) | Upload synthetic content to an approved library, reopen and verify it, and remove it |
| SharePoint | Upload a file, rename it, reopen and verify its name/content, and remove it |

These are **API-backed journeys**, not Outlook/Teams/browser sign-in tests, employee read receipts, Teams media tests, or SharePoint coauthoring tests. A successful test is not tenant-wide availability or a guarantee of every employee's experience.

The checked-in settings enable all supported services and journey scenarios, but use **safe simulation** by default. A controlled live failure-path trial can exercise real authentication/operations before the test resources work: observed failures make journeys Unhealthy, not artificially healthy. Successful journeys, scoped permissions, and end-to-end notifications still require validation. See the [shared worker deployment guide](./synthetic-tests/infra/README.md) for hosting and rollout.

The demo has been redeployed report-only with four models, 34 entities, 30 relationships, six journeys and 18 business steps. All three apps have ready/running `--0000005` revisions using the same immutable image digest. Both the demo and original PoC telemetry resource pairs and associated smart-detector rules have been deleted; the original PoC model remains without queries. Normal workspace deletion has a **14-day recovery window**, not a permanent purge. Fresh SharePoint provider reporting is verified as Unknown with explicit Graph 403 diagnostics; all-service end-to-end verification is still in progress. See [verified deployment details](./synthetic-tests/infra/README.md#verified-report-only-deployment) for the digest and remaining acceptance gates.

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

All supported services/scenarios are selected by default. Target placeholders are not provisioned resources. Keep credentials, certificates, and connection strings out of configuration files and source control.

### 2. Adjust service-specific behavior

The [Exchange](./synthetic-tests/exchange/config.json), [Teams](./synthetic-tests/teams/config.json), and [SharePoint](./synthetic-tests/sharepoint/config.json) files contain **only service-specific settings**: independent cadence, timeout, simulation/live mode, authentication, cohort, and optional provider collection. Selection, targets, and report policy are configured **only at the root**, not duplicated in these files.

For older private service configs, move targets into the root file and remove the old `enabled`, `targets`, and `telemetry` keys; the loader now rejects these redundant fields.

The service config's `scenario` chooses a deterministic simulation outcome; root `scenarios` chooses which user journey to monitor.

Both journeys run in the same product worker on that service's cadence; enabling another journey does not add another Container App. The live service examples enable stable Service Health collection once per cycle, independently of journey setup. That read-only path needs separate `ServiceHealth.Read.All` admin consent. Exact overview status is reported to `${service}-service-health` as `microsoft-reported-service-status`: 100 healthy, 50 degraded, 0 interruption. Failed, missing, or unknown status produces Unknown without a numeric value, with failure context. The existing trial observes Graph 403 until that consent is granted. Safe simulation profiles keep provider collection off; beta reports remain optional diagnostics only.

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

Direct health reports update separate journey and business-step entities using only **External Reports**. Token acquisition and cleanup remain internal and are not published as journey steps. Follow the [administrator setup](./synthetic-tests/README.md#administrator-setup-enable-authentication-and-live-tests) and [deployment guide](./docs/deployment.md); selecting live mode does not grant permissions or deploy resources.

## Further guidance

- [Project configuration](./monitoring.config.json): select services, scenarios, accounts/targets, and report policy.
- [Synthetic test guide](./synthetic-tests/README.md): run safely, configure workers, and understand journey coverage.
- [Health model guide](./health-model/README.md): model composition, signals, aggregation, and deployment.
- [Deployment guide](./docs/deployment.md): hosting, identities, permission boundaries, and rollout.
- [Operations guide](./docs/operations.md): report freshness, monitoring failures, notifications, and production acceptance.

Independent monitoring is essential: a stopped worker or broken reporting path must not be mistaken for a healthy service. Neither a health report nor a model state is, by itself, an alert-delivery system.
