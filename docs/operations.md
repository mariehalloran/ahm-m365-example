# Operations, demonstration, and safety

## Identity and permission gates

The default deployment does not grant Microsoft Graph tenant permissions. Simulated outcomes still pass through the real normalizer, aggregation, and AHM ingestion.

Before enabling live mode:

1. Review Dan's Exchange PoC with its owner; no source path was provided to reuse or verify.
2. Approve a dedicated shared test mailbox. Never use a real user's or executive's mailbox. Confirm licenses, transport policy, retention, and mail-flow rules with the tenant owner.
3. Identify the Function managed identity's **application/client ID** and **service-principal object ID**. They are different identifiers.
4. Use [Exchange RBAC for Applications](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac) to scope `Application Mail.ReadWrite` and `Application Mail.Send` to only the approved test mailbox(es). Register the service-principal pointer and define a resource scope in Exchange under administrator supervision.
5. Validate effective access with `Test-ServicePrincipalAuthorization` for an allowed mailbox and a denied control mailbox. Do not combine scoped RBAC with broad equivalent Entra mail application grants: permissions are additive and the broad grant bypasses the intended scope.
6. An authorized tenant administrator separately grants Graph `ServiceHealth.Read.All` application permission for service-health queries. Do not add Directory.Read.All or Organization.Read.All just to create a control-plane probe.
7. For SharePoint, use [Sites.Selected](https://learn.microsoft.com/en-us/graph/permissions-selected-overview) with an explicit write grant to a dedicated approved site. Confirm the selected drive/folder is intended for synthetic files. More granular selected permissions can be investigated separately; the current handler enumerates the site's drives.
8. Confirm negative authorization tests and cleanup behavior before setting `ENABLE_LIVE_M365=true`.

Azure RBAC and Microsoft Graph/Exchange authorization are separate systems. Being Azure Owner does not authorize mailbox operations. Deployment must not silently request tenant-wide admin consent.

The sample is public-cloud-only (`management.azure.com`, `graph.microsoft.com`, public Azure Blob and SharePoint endpoints). Cross-tenant M365 and sovereign-cloud authentication are not implemented. The Azure managed identity must be usable in the approved Microsoft 365 tenant; otherwise design an approved workload identity flow rather than adding a client secret.

## Optional Dev Proxy

The included [Dev Proxy configuration](../mocks/devproxyrc.json) and [response file](../mocks/devproxy-service-health.json) follow the documented MockResponsePlugin format. Run an installed Dev Proxy with:

```sh
devproxy --config-file mocks/devproxyrc.json
```

Use the tool's approved local certificate setup. Node.js 24 can route fetch requests through `HTTPS_PROXY` with `NODE_USE_ENV_PROXY=1`; configure `NODE_EXTRA_CA_CERTS` with the explicitly trusted local proxy certificate. Set `NO_PROXY` for identity, Azure management and storage hosts so only Graph traverses the proxy. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

This configuration supplies service-health responses only. It deliberately blocks unmocked Graph requests; it is **not** a complete stateful mock of mailbox or file operations. The automated tests provide those HTTP-level journeys. Live-mode credentials are still required for real token acquisition, and identity/ARM operations are never faked. Until identity permissions are approved, use simulation mode and Graph-shaped fixtures, not a fake production bearer token.

Dev Proxy is optional and is not installed or started automatically. Its configuration has not been exercised against an installed Dev Proxy in the initial implementation.

## Data handling and retention

The normalized contract is strict and has no message/document body fields. Telemetry includes probe IDs, opaque correlation IDs, timings, states, categories and limited provider issue metadata. Mailbox addresses, tokens, HTTP authorization headers, message subjects, Graph error bodies and download URLs are never intentionally logged.

The synthetic message body is fixed boilerplate. The SharePoint document contains only the run's generated correlation ID. These artifacts live only in dedicated test resources and are not sent to AHM.

AHM stores state and a limited context, with up to five failed-probe correlation IDs and five provider issue IDs. App Insights retains detailed execution events; confirm the deployed retention and regional storage requirements. Blob history contains only cohort health/counters/expiry, not mailbox data.

Do not enable HTTP body logging, token logging or default identity debug logs. Keep separate development/production models, identities and test resources. Conduct privacy/security review before expanding beyond approved dedicated probes.

## Timeout, retries and cleanup

- The whole cycle is bounded at 170 seconds; the Functions host allows four minutes for final cleanup and failure handling.
- At most three probes execute concurrently. Requests time out at 15 seconds and safe operations retry up to three times.
- Size each runner's probe list so it can finish inside the cycle budget. A large set of slow probes fails the cycle explicitly rather than publishing a misleading completed heartbeat.
- Mail draft creation and send are not retried: an ambiguous response could otherwise duplicate mail. Reads, idempotent deletes and same-path uploads can retry.
- Retry-After is honored within the bounded budget. A delay beyond ten seconds yields an explicit failure rather than violating the provider's requested delay.
- Each probe gets its own timeout; cancellation flows into Graph calls and sleeps.
- Cleanup gets a separate ten-second budget, even when the journey timeout is cancelled.
- Cleanup uses only IDs observed in that run or an exact UUID-containing subject/path. It never enumerates message bodies, deletes by date, or purges a whole mailbox/library.
- A mail delivery arriving **after** final cleanup can leave a test artifact. Review the dedicated mailbox's synthetic messages and retention policy periodically. A delayed-arrival sweeper must verify exact ownership and should be designed/approved before scale-out. Deleted messages/files may remain in Deleted Items/recycle bin under the workload's retention policy.
- Failed cleanup emits `probe-cleanup-failed` and cannot be reported as success. Authentication, permission and ambiguous cleanup failures should be investigated before repeated runs accumulate artifacts.

## Demonstration matrix

Offline scenarios do not change Azure. To demonstrate the real model, replace `npm run demo` with `npm run cycle`, use exported deployment outputs, and account for the two-cycle temporal policy.

| Scenario | Local command/settings | Expected tenant / provider / pipeline |
| --- | --- | --- |
| Healthy | `npm run demo` | Healthy / Healthy / Healthy |
| Slow Exchange | `SYNTHETIC_SCENARIO=slow npm run demo` | Degraded / Healthy / Healthy |
| Tenant-only failure | `SYNTHETIC_SCENARIO=failed npm run demo` | Unhealthy / Healthy / Healthy |
| Confirmed provider incident | `SYNTHETIC_SCENARIO=failed PROVIDER_SCENARIO=degraded npm run demo` | Unhealthy / Degraded / Healthy |
| Provider advisory only | `PROVIDER_SCENARIO=degraded npm run demo` | Healthy / Degraded context / Healthy |
| Provider query unavailable | `PROVIDER_SCENARIO=unavailable npm run demo` | Healthy / Unknown / Healthy |
| Expired test evidence | `SYNTHETIC_SCENARIO=stale npm run demo` | Unknown / Healthy / Healthy |
| Insufficient samples | `MIN_FRESH_SAMPLES=4 npm run demo` | Unknown / Healthy / Healthy |
| Runner stopped | Disable timer and wait beyond report TTL | Synthetic and heartbeat must expire to Unknown |

For regional demos, create two cohort entities and matching `PROBES_JSON` cohorts. Inject per-probe `scenario` values. Do not change the default three-sample minimum without making the demo's weakened evidence explicit. AHM dependency/rollup policy determines how region impact affects the root; provider-only events never automatically propagate.

## Telemetry queries

For workspace-based Application Insights, start with:

```kusto
AppTraces
| extend Event = parse_json(Message)
| where tostring(Event.event) in ("cycle-failed", "probe-cleanup-failed", "provider-query-failed")
| project TimeGenerated, Event
| order by TimeGenerated desc
```

```kusto
AppTraces
| extend Event = parse_json(Message)
| where tostring(Event.event) == "synthetic-result"
| project TimeGenerated, TestId=tostring(Event.testId),
          CorrelationId=tostring(Event.correlationId),
          Success=tobool(Event.success), DurationMs=todouble(Event.durationMs),
          Category=tostring(Event.diagnosticCategory)
```

Use `traces`/`message`/`timestamp` instead when querying the Application Insights resource's classic query schema.

Never infer a healthy pipeline solely from the presence of a started invocation. Only `cycle-completed` and the submitted completed-cycle heartbeat indicate successful reporting/persistence. If ARM is unavailable, the failure heartbeat might also fail: the last report's expiration is the fallback, not an indefinitely retained Healthy state.

## Disablement and teardown

1. Set Function app setting `AzureWebJobs.m365Synthetic.Disabled=true`. Verify no new invocations occur.
2. Wait beyond the report TTL and verify both synthetic and heartbeat states become Unknown. Record preview-service evaluation lag.
3. Revoke the workload's Exchange RBAC assignments, Graph app roles, and selected SharePoint site grant under the tenant owner's procedures.
4. Review and remove only confirmed synthetic artifacts from the dedicated resources. Never purge a real-user mailbox or an entire library.
5. Remove the sample's resources using the deployment resource inventory. Delete the resource group only after verifying it contains **only** disposable sample resources and obtaining deletion approval.

## Required live sign-off

- [ ] Confirm real model state changes and parent propagation.
- [ ] Stop reports and observe Unknown after expiration.
- [ ] Confirm a real dedicated Exchange delivery, slow/timeout behavior, and safe cleanup.
- [ ] Confirm denied mailbox/site authorization.
- [ ] Confirm state survives Function restart and overlapping writers fail safely.
- [ ] Confirm alert delivery to an approved action-group receiver.
- [ ] Approve retention, costs, privacy and rollout scope.
