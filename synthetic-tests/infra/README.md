# Deploy the service workers

This shared deployment hosts the real Exchange, Teams, and SharePoint worker entries in **separate Azure Container Apps**, using one private image, one environment, and separate user-assigned identities. It does not deploy a sample web server or expose HTTP ingress.

Use the independently deployed [health models](../../health-model/README.md) first. This template creates the registry, environment, worker identities, an ingest-only custom role, scoped role assignments, and optionally the apps. It grants **no Microsoft 365 permissions**, creates no mailboxes/sites/teams/bots, and installs no certificates.

## Configuration and safety

Keep a private copy of [the root config](../../monitoring.config.json) with the approved subscription/resource group/model prefix and targets. Select the intended service-specific files through each root `configFile`. The parameter preparer reads those exact files rather than duplicating their settings in Bicep:

```sh
npm --prefix synthetic-tests run deployment:prepare -- \
  /absolute/path/monitoring.private.json \
  /absolute/path/foundation.parameters.json
```

Run this and subsequent Azure commands from the repository root. `foundation.parameters.json` contains approved target metadata, not credentials. Keep private parameter files out of Git.

The first preparation sets `deployWorkers: false`, so no probes run. Image deployment with live profiles requires the separate **`--enable-live`** argument; the environment gate is never inferred merely from `mode: live`.

The checked-in service files remain safe local simulations. A hosted live trial uses live profiles and makes real authentication/API attempts. Unavailable mailbox/permissions produce observed failures, not simulated health. Valid-but-incomplete target or credential setup produces a `configuration-failure`/unexecutable journey and Unhealthy success report; actions that never ran remain Unknown. This is evidence that the probe cannot complete its task, **not proof of a Microsoft outage**.

## Provision and publish

Review every preview before applying. Use the approved subscription explicitly and keep the model destination consistent:

```sh
SUBSCRIPTION_ID='<approved-subscription>'
RESOURCE_GROUP='<approved-resource-group>'
PARAMETERS='/absolute/path/foundation.parameters.json'

az deployment group what-if --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" --template-file synthetic-tests/infra/main.bicep \
  --parameters @"$PARAMETERS"

az deployment group create --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" --name synthetic-worker-foundation \
  --template-file synthetic-tests/infra/main.bicep --parameters @"$PARAMETERS"
```

Read the `registryName` and `registryServer` outputs. The Basic registry disables admin credentials and anonymous pull. Each worker UAMI receives AcrPull only on this registry, and the health-report ingestion action only on its own service model.

Build the image from the self-contained Node project:

```sh
docker build --platform linux/amd64 --pull -t m365-synthetic:<unique-version> synthetic-tests
```

Before publishing, run all three image entries with `--once` using mounted root/service files. A network-disabled local simulation is a packaging smoke test only; it must not publish simulated cloud health. The runtime image is non-root and contains production dependencies and compiled code, not private configs or certificates.

Authenticate and push to the approved registry:

```sh
az acr login --subscription "$SUBSCRIPTION_ID" --name '<registryName>'
docker tag m365-synthetic:<unique-version> '<registryServer>/m365-synthetic:<unique-version>'
docker push '<registryServer>/m365-synthetic:<unique-version>'
```

Prefer the returned immutable image digest when preparing the app deployment:

```sh
npm --prefix synthetic-tests run deployment:prepare -- \
  /absolute/path/monitoring.private.json \
  /absolute/path/workers.parameters.json \
  '<registryServer>/m365-synthetic@sha256:<digest>' --enable-live
```

Preview and apply the same shared template using `workers.parameters.json`. Existing infrastructure is reconciled; the three apps are added. For each subsequent change, regenerate parameters from the private root config, preview, and apply again.

## Runtime behavior and verification

- Each service uses its own configured cadence, one minimum/maximum replica, single-revision mode, and 0.25 CPU/0.5 GiB. No ingress is exposed. Always-running replicas and the registry incur charges; this sizing is not a reliability/performance commitment.
- Each app mounts its root config and selected service file read-only. A nonsecret config hash in the revision template triggers a new revision when those files change. Secret-only rotations still require an explicit restart if no template input changes.
- Managed identity selection is explicit. The same UAMI obtains separate Graph and ARM tokens; Teams bot credentials remain a separately approved prerequisite.
- Direct health reports and structured console diagnostics are the only output paths. Parameter preparation needs no telemetry connection-string secret.
- The environment has platform log forwarding disabled. Live console streaming remains available; durable diagnostic retention, external observers and alert delivery remain separate work.
- Shutdown has a 60-second grace period for bounded cleanup and reporting. Single-revision rollout can briefly overlap replicas; do not claim exactly-once probes. Workers retain no persistent history or outbox.

Check app provisioning, active revisions and replicas, then inspect console diagnostics and fresh external signals on all six selected journey entities and their 18 business-step children. Verify **External Reports** as their only signal group, separate impact-suppressed provider reports, and propagation into each service root and the all-up root model. The full family has four models, 34 entities and 30 relationships; successful ARM deployment alone is not acceptance.

Expected early-trial failures include denied Exchange operations and unconfigured Teams/SharePoint resources. Startup failures are retried on the service cadence, reported explicitly and do not fabricate executed action samples. Invalid root/service schemas, unusable report credentials, or an inaccessible health-report destination can still prevent publication and require independent monitoring.

No HTTP endpoint is exposed, so there is no app URL to probe. Use Azure resource/revision health, real report timestamps, and the model graph. Production use still requires the [operations acceptance gate](../../docs/operations.md#enterprise-reliability-acceptance-gate), tenant grants, successful journeys, retention/cost review, and independent notification tests.

## Verified failure-path trial

The isolated `m365-experience-demo` trial ran two journeys per product in the same three apps. Exchange managed-identity authentication succeeded but actual draft creation failed for the placeholder mailbox; Teams and SharePoint reported their actual missing-configuration failures. All six journeys were Unhealthy and the root rollup remained Unhealthy. This is evidence for the earlier real failure-reporting path, not successful Microsoft 365 availability.

Stable Service Health collection attempts both overview and issue APIs once per cycle from every service even when its journeys cannot initialize. The earlier live trial verified **HTTP 403 / `permission-failure`** for all three worker identities. A tenant administrator must separately grant `ServiceHealth.Read.All` admin consent before real overview status can populate. The report-only implementation publishes `microsoft-reported-service-status` directly to `${service}-service-health` with `impactSuppressed`: 100 healthy, 50 degraded, 0 interruption. Failed/missing/unknown overviews publish Unknown without a numeric value and with failure context; neither a Microsoft outage nor a healthy provider snapshot is invented. Issue/history and optional beta remain console diagnostics only; experimental beta collection remains off.

No simulated cloud reports or Microsoft 365 permission grants were used. This verifies the real failure-reporting path, not successful Microsoft 365 availability or notification delivery. Teams bot certificate mounting/environment settings remain an additional hosting prerequisite before posting can work.

For a later configuration change, regenerate parameters and redeploy; workers read config only at startup. An incremental deployment does not delete or stop an app omitted by a newly disabled service selection: stop/deactivate that existing worker explicitly before removing its deployment/reference. The foundation-only stage likewise does not stop previously deployed workers.

## Verified report-only deployment

The current demo models have been redeployed report-only: **four models, 34 entities, 30 relationships, six journeys and 18 business-step entities**, with **External Reports** as the only signal group on reporting entities.

All three Container Apps have ready/running revisions ending in `--0000005`, using this immutable image digest:

```text
sha256:a9ede669f8fdbe70e0742328d898d96c3d6b37e888a270b4a4a267b8e7c001ac
```

No Application Insights environment settings or ingestion secrets remain in those apps; only root/service configuration secrets remain. The obsolete Exchange-only mock Bicep has also been stripped of telemetry and compiled.

Fresh SharePoint external provider reporting is verified: `microsoft-reported-service-status` is Unknown without a fabricated value, with explicit Graph 403 diagnostics. `ServiceHealth.Read.All` admin consent remains required. **All-service end-to-end verification is still in progress**; ready/running revisions and this provider observation are not that final gate, successful tenant journeys, production acceptance, or end-to-end notification proof.

## Report-only migration cleanup

Incremental model/app deployments do not delete obsolete telemetry resources. Explicitly remove old query signals/groups, query authentication and scoped reader grants, and app connection-string secrets/settings. Delete both the current demo and original PoC Log Analytics/Application Insights pairs and associated smart-detector rules after confirming ownership and retention/export obligations. Preserve the original PoC model entities/root, stripping only telemetry bindings; see the [model migration guide](../../health-model/README.md#apply-and-migrate).

For the current migration, both the demo and original PoC telemetry pairs and associated smart-detector rules have been deleted. Four workspace-query settings and four scoped reader-role assignments were removed. The original PoC model is retained, with its queries removed. Workspaces used normal deletion with a **14-day recovery window**, **not permanent purge**.

For subsequent environments or changes, rebuild/publish the report-only image, regenerate parameters with the same preparation CLI and optional image/`--enable-live` arguments shown above, and redeploy. Verify actual cloud deletion, the new revision/image/configuration, direct reports, provider Unknown/failure context, and service/root propagation. The current all-service end-to-end check remains in progress. TTL expiry only removes external signals; independent stopped/stalled-worker, broken-reporting and notification tests remain acceptance gates. Reports replace current-cycle aggregates, not a full metrics store, percentile history or arbitrary log-query interface.
