# Deploy the health models, then the workers

## Deployment status and order

The retained scope is six Exchange journeys, two Teams journeys (bot-backed
channel conversation and scheduled meeting), and three OneDrive file journeys.
There are no planned journey branches. SharePoint's health model and root
reference are deleted, and its old worker has no active revision.

The cleanup removes unsupported Teams receipt/P2P/card prototypes and unused
file-sharing/search prototypes rather than publishing hardcoded capability
failures. A source change, a successful deployment, and a successful live journey
are different acceptance gates.

Current rollout checkpoint, 2026-10-26:

- The running Exchange, Teams and OneDrive workers still use the earlier image
  ending `2b092a71f055fb86f58c95e3308d42656d40dcdd952ac3f1b946c0e1329c0f6d`.
  The cleaned source is not yet deployed.
- Unsupported Teams and OneDrive branches were deleted, including their child
  entities and relationships, and their absence was verified through ARM.
- Stable and approved beta provider reports are being consolidated onto each
  product's single, suppressed Service Health entity, not per-API child entities.
  The worker and model changes must be deployed together.
- Five Exchange journeys and OneDrive app-folder operations have recent
  ingested Healthy reports. The old Exchange meeting code still reports a
  cleanup failure; its source fix needs deployment.
- A real peer-bot meeting join returned POST 201 and GET 200 with `established`
  state. DELETE returned 204 and termination was verified. This proves that
  leg's signaling, not two-bot playback or received audio.
- The primary bot's managed-identity Graph token still lacks the newly assigned
  meeting-join role. Its observed expiry is 2026-10-27 17:28:57 UTC. Role
  assignments exist, but runtime authorization is not yet proven; there is no
  alternate-credential or alternate-audience fallback.
- OneDrive selected-folder journeys still need the real dedicated folder IDs
  and resource grants. Administrator reads of both configured test-folder paths
  returned 403. Missing bindings remain configuration failures, not simulated
  success.
- OneDrive's worker identity was explicitly approved to federate to the existing
  read-only Service Health collector. A real hosted overview-list request returned
  HTTP 200 and `OneDriveForBusiness` / `Microsoft OneDrive` /
  `serviceOperational`. The private profile enables stable collection every five
  minutes; OneDrive beta collection remains disabled. This is verified provider
  access, not yet proof of the new grouped report ingestion.

Replace this checkpoint with fresh deployment and ingestion evidence after the
cleaned image is running. Do not reuse old acceptance results as proof of a new
revision.

## Safe local validation

From the repository root, with the existing package dependencies restored:

```sh
npm --prefix synthetic-tests test
npm --prefix synthetic-tests run typecheck
npm --prefix synthetic-tests run build
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s health-model/tests
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s synthetic-tests/infra/tests
```

Checked-in profiles use simulation. Simulation is labeled and does not ingest
cloud health, send messages, join calls or mutate files.

## Root and service configuration

The [root configuration](../monitoring.config.json) owns service/scenario
selection, test accounts/resources, health policy and optional OTEL.
`configFile` selects each service's separate cadence, timeout, authentication
and provider settings. Paths are relative to the root configuration's directory.
Do not duplicate root-owned fields in service profiles.

Use the same reviewed private root configuration for model and worker deployment.
Keep the actual profile outside source control. Live execution independently
requires `ENABLE_LIVE_M365=true`; beta provider collection requires
`ENABLE_BETA_SERVICE_ACTIVITY=true`.

## Identity and permissions

Use an explicitly selected managed identity per service and separate
authorization for Microsoft 365 access and health-report ingestion.

- **Exchange:** application RBAC scoped to the dedicated test mailboxes; see
  [mailbox access](../MAILBOX-SYNTHETIC-ACCESS.md).
- **Teams messaging:** managed-identity Bot Connector authentication and a
  separate federated application with team-scoped Graph readback permission.
  No user sign-in, MFA, refresh-token cache or bot-to-bot delivery claim.
- **Teams meeting:** two explicit bot identities with `Calls.JoinGroupCall.All`,
  one dedicated meeting, signed callback verification, and independent teardown
  of both owned call legs. Service-hosted tone completion does not prove
  received audio or bidirectional media quality.
- **Optional call records:** explicitly approved tenant-wide
  `CallRecords.Read.All` on the primary caller only. Collection requests only
  known call IDs, which is an application safeguard, not permission scoping.
  Delayed or absent quality measurements are not zero/Healthy.
- **OneDrive:** `Files.SelectedOperations.Selected` with write grants on the
  dedicated folders; app-folder operations separately use
  `Files.ReadWrite.AppFolder`. See [OneDrive setup](../synthetic-tests/onedrive/README.md).
- **Health reports:** ingest-only access to the worker's service model. Root
  model Reader access to nested models is a separate permission.

There is no silent CLI, user, certificate or credential fallback. Explicit
certificate options for local application access remain separate from hosted
managed-identity execution.

## Container Apps boundary

Deploy the [health models](../health-model/README.md) first. Preview worker
changes using the [worker deployment guide](../synthetic-tests/infra/README.md),
reuse the existing approved environment and identities, then deploy an immutable
image digest with the matching mounted root/service configuration.

Only scheduled Teams meetings need public HTTPS callback ingress. Background
journey execution is not a long-lived ingress request. Lanes run independently
with bounded execution and cleanup; a timeout is a failed attempt, while
unexecuted dependent steps are not extra failed requests.

OTEL is root-controlled and disabled by default. Azure Monitor export requires
the model's telemetry resources before workers; direct health reports and
console diagnostics do not depend on OTEL. Microsoft-reported provider data
remains separate, suppressed Service Health context; see
[provider configuration](./provider-monitoring.md).

## Acceptance and cleanup

1. Check the active profile, selected identities, immutable image digest and
   ready revision on each worker.
2. Observe at least two real cycles, including required assertions and owned
   artifact/call cleanup.
3. Read the ingested reports from every expected journey/action entity. A
   successful deployment or log line alone is insufficient.
4. Reconcile exact live entity and relationship IDs against the selected catalog.
   Incremental ARM deployments do not delete retired child resources.
5. Delete only identified retired relationships and entities; never remove a
   whole active model to fix a child migration.
6. Verify worker/report freshness and notifications independently before claiming
   production readiness. Current live acceptance does not establish those
   operational safeguards.
