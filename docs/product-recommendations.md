# Service patterns and next steps

## Keep measurement simple

The worker performs a bounded operation, cleans up its artifacts, and exports its result and timings. It does not store state, calculate success percentages, stabilize health, or send evaluated states to Azure Monitor Health Models.

Each service has one config/process, with its own cadence and embedded OTel SDK. Azure Container Apps is the intended host; separate Container Apps reuse the same program. There is no separate telemetry worker or Kubernetes requirement.

The [telemetry guide](../telemetry/README.md) owns measurement semantics and KQL for downstream analysis. Provider status and monitor failures remain distinguishable from actual service results. Authentication failure is not proof that mail delivery failed.

## Teams: deliberately staged

[Teams](../probes/teams/README.md) is disabled and not implemented. A config/model entity does not establish a working Teams test.

| Candidate | Requirements / limitations |
| --- | --- |
| Read approved team/channel metadata | Lightweight API reachability only, not messaging/calls |
| Send/read/delete a correlated message | Confirm supported endpoint authentication and exact permissions; do not use migration APIs as a live messaging shortcut |
| Meeting/call/media | Supported calling APIs, licensed identity, endpoint/network placement, privacy, and cleanup |

Do not block initial Exchange work on a full media synthetic or bypass controls with password/browser automation.

## Exchange and SharePoint

Exchange creates a correlated draft, sends to the dedicated mailbox, confirms Inbox delivery, and cleans up known copies. Record delivery duration separately from total duration; neither proves Outlook rendering or external delivery.

SharePoint verifies the approved site/drive, uploads a uniquely named synthetic file, downloads/verifies its content, and deletes only its own artifact. This does not test coauthoring, document rendering, desktop sync, or every user population.

Use scoped permissions and dedicated resources. One mailbox/site tests an integration, not tenant-wide availability. Labels do not change the execution location; regional claims require actually placed runners.

## Downstream policy, not worker state

- Choose success-rate denominators explicitly and show unexecutable attempts separately.
- Use weighted mean duration for the simple metric path; don't mislabel it as p95.
- Track each service's last-reported metric and allow for its cadence and ingestion delay; no mailbox inventory is required.
- Keep simulation out of live availability calculations.
- Configure query-based model signals only after validating actual ingested tables and query results.
- Use model dependencies for rollup and keep Microsoft-reported provider context separate.

The [model and telemetry resources](../health-model/README.md) are deployed with query authorization and live-only signal evaluation. No live workers are connected. Service aggregates do not identify individual missing mailboxes, and no “last healthy” state is preserved in a worker.

## Recommended sequence

1. Keep the deployed model topology as the foundation.
2. Run one stateless simulated service locally and verify its result/metric shape.
3. Connect an approved workspace-based Application Insights resource and validate Log Analytics queries.
4. Containerize each service independently in Azure Container Apps with embedded telemetry.
5. Obtain approved live Exchange/SharePoint resources and scoped credentials.
6. Wire downstream query-based model signals and missing-data detection.
7. Add Teams only after selecting a supported journey and authorization model.

Production acceptance still needs actual live evidence, safe cleanup, ingestion/failure tests, retention/cost approval, credential rotation, and monitoring of stopped workers.
