# Finding Microsoft 365 experience gaps with Azure Monitor Health Models

Microsoft 365 service health tells us what Microsoft reports about its services. It does not prove that a particular mailbox can receive mail, a bot can publish to an approved channel, or a file can be saved and read back from a particular site.

This example combines **API-backed synthetic user journeys** with **Azure Monitor Health Models** to make those gaps visible. Synthetic tests exercise a small, approved workflow repeatedly; the model organizes the resulting evidence by service experience and failing action. Microsoft-reported health remains separate supporting context.

## Why synthetic tests?

Different monitoring sources answer different questions:

| Evidence | What it tells us | Gap it leaves |
| --- | --- | --- |
| Microsoft 365 Service Health | Microsoft-reported status, incidents, and advisories for subscribed services | Does not confirm that our chosen mailbox, channel, or site workflow works |
| An accepted API request | The service accepted that operation | Acceptance alone does not prove Inbox delivery, channel publication, or correct file readback |
| A completed synthetic journey | Whether the configured workflow succeeded, how long it took, and where it failed | Covers only those targets, API paths, identities, and execution locations |
| Missing observations | The monitoring evidence is incomplete or stale | Does not establish whether Microsoft 365 itself is healthy or unhealthy |

For example, a mail send can succeed while delivery confirmation times out. SharePoint can accept an upload while verified readback fails. A tenant's Service Health overview can remain operational while a particular test identity loses access. These are different findings, not one interchangeable availability check.

A failed synthetic test is **evidence to investigate**, not automatic proof of a Microsoft outage. Permission/configuration mistakes, worker connectivity, cleanup, and the monitoring system itself can also fail.

## What the tests exercise

| Experience | Repeated journey | Useful failure detail |
| --- | --- | --- |
| [Exchange](./synthetic-tests/exchange/README.md) | Create a draft, send to the test mailbox itself, confirm Inbox delivery, clean up | Authentication, draft creation, submission, delivery confirmation, cleanup |
| [Teams](./synthetic-tests/teams/README.md) | Post a bot-owned channel message, confirm its marker and author through Graph, remove it | Authentication, posting, publication confirmation, cleanup |
| [SharePoint](./synthetic-tests/sharepoint/README.md) | Verify the approved drive, upload synthetic content, download and compare it, remove it | Authentication, library verification, upload, readback, cleanup |

Each executed action has its own success and duration measurements. A failed prerequisite skips downstream actions instead of inventing failed requests that never ran. Request timing and confirmed completion are measured separately.

These are **not** Outlook/Teams/browser sign-in tests, employee read receipts, Teams call/media tests, or SharePoint sharing/coauthoring tests. A successful journey is not tenant-wide availability or a guarantee of every employee's experience.

## Why put the evidence in a health model?

Raw metrics and logs record attempts. Azure Monitor Health Models adds a dependency-oriented view of the experiences those measurements support:

- Each **Experience** has one Log Analytics **User Journey** entity.
- The User Journey contains overall and named-step KQL signals, such as **Create email - success percentage** and **Create email - mean duration**.
- The model evaluates those signals over time and rolls journey health into the related experience, making it easier to locate the failed action instead of reporting only "Microsoft 365 is unhealthy."
- A separate **Service Health** entity shows stable Microsoft-reported context with **Suppressed** impact. It does not override a successful journey or turn a provider incident into a synthetic failure.
- No samples means **Unknown**, not fabricated healthy status. All reported attempts failing means **0% success**, which is different from no evidence.

```text
Independent service workers: journey functions + embedded OpenTelemetry
                                |
                 Workspace-based Application Insights
                                |
                       Log Analytics / KQL
                                |
                   Azure Monitor Health Models
               Experience -> User Journey -> step signals
```

The workers remain stateless: they emit one 1/0 success observation per attempt, step measurements, timings, and diagnostics. They do not publish Healthy/Unhealthy states or store aggregation history. Evaluation belongs in Log Analytics and the model. The [model guide](./health-model/README.md) explains the deployed topology, query windows, thresholds, and context isolation.

Optional beta `serviceActivity` reports are experimental **log-only diagnostics**, disabled by default and never used for journey or Experience health. Beta APIs are unsupported for production use.

## Repository layout

| Component | Responsibility |
| --- | --- |
| [synthetic-tests/](./synthetic-tests/README.md) | Self-contained Node project: service-owned journeys/configs/tests/queries, shared utilities, npm package/lockfile, TypeScript and test configuration |
| [health-model/](./health-model/README.md) | Independently managed model, telemetry infrastructure, and query-signal wiring |
| [docs/deployment.md](./docs/deployment.md) | Hosting boundary, packaging, identity, and rollout |
| [docs/operations.md](./docs/operations.md) | Scheduling, permissions, telemetry loss, notifications, and production acceptance |
| [MAILBOX-SYNTHETIC-ACCESS.md](./MAILBOX-SYNTHETIC-ACCESS.md) | Detailed Exchange administrator permission handoff and allowed/denied access checks |

Shared code lives in `synthetic-tests/utils/`. Dependencies and generated build output also belong to the synthetic-tests project, not the repository root. Azure Container Apps is the intended host, with one independent service process and embedded OpenTelemetry per app.

## Start safely

From the repository root, with Node.js 22 or 24:

```sh
cd synthetic-tests
npm ci
npm run exchange -- --once
npm run teams -- --once
npm run sharepoint -- --once
```

The checked-in configurations use **simulation and console output**: no real emails, channel messages, files, Graph authentication, or Azure ingestion. To run from the repository root without changing directories, use `npm --prefix synthetic-tests run exchange -- --once`.

For real tests, follow the [administrator authentication and enablement walkthrough](./synthetic-tests/README.md#administrator-setup-enable-authentication-and-live-tests): approve dedicated resources, authorize the correct same-tenant identity with scoped permissions, supply runtime/telemetry settings, and prove a single live cycle before enabling recurrence.

## Readiness and limits

The journeys, step telemetry, provider callbacks, queries, and model wiring are implemented and locally tested. The sample model and telemetry resources are deployed, but **live workers, tenant grants, and end-to-end acceptance are not completed**. See the [readiness checklist](./synthetic-tests/README.md#wiring-and-readiness).

Health-model evaluation is not an alert-delivery system by itself. Production use still requires independent stopped/stalled-worker and missing-telemetry detection, appropriate retention/cost controls, approved notification routes, and end-to-end notification testing. Do not rely exclusively on Exchange or Teams to report an outage affecting those services.
