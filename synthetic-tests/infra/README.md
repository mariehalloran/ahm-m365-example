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

- Each service uses its own configured cadence, one minimum/maximum replica, and single-revision mode. Always-running replicas and the registry incur charges.
- Each app mounts its root config and selected service file read-only. A nonsecret config hash in the revision template triggers a new revision when those files change. Secret-only rotations still require an explicit restart if no template input changes.
- Managed identity selection is explicit. The same UAMI obtains separate Graph and ARM tokens; Teams bot credentials remain a separately approved prerequisite.
- Direct report publication is independent of OTEL. With root OTEL disabled, no connection string/workspace is required. If enabling Azure OTEL, supply the secure connection-string parameter separately.
- The environment does not configure Log Analytics log forwarding. Live console streaming remains available; durable platform logging, external observers and alert delivery remain separate work.
- Shutdown has a 60-second grace period for bounded cleanup, reporting and SDK shutdown. Single-revision rollout can briefly overlap replicas; do not claim exactly-once probes.

Check app provisioning, active revisions and replicas, then inspect console logs and fresh external signals on the journey/action entities. Verify propagation into each service root and the all-up root model; successful ARM deployment alone is not acceptance.

Expected early-trial failures include denied Exchange operations and unconfigured Teams/SharePoint resources. Startup failures are retried on the service cadence, reported explicitly and do not fabricate executed step metrics. Invalid root/service schemas, unusable report credentials, or an inaccessible health-report destination can still prevent publication and require independent monitoring.

No HTTP endpoint is exposed, so there is no app URL to probe. Use Azure resource/revision health, real report timestamps, and the model graph. Production use still requires the [operations acceptance gate](../../docs/operations.md#enterprise-reliability-acceptance-gate), tenant grants, successful journeys, retention/cost review, and independent notification tests.

## Verified failure-path trial

An isolated `m365-experience-demo` trial verified all three apps running in live mode with OTEL disabled. Exchange managed-identity authentication succeeded, and the real Graph draft request returned HTTP 404 for the placeholder mailbox; send/delivery were skipped after that failed prerequisite. Teams and SharePoint reported their actual missing-configuration failures. Their journey success values were zero, all three journeys were Unhealthy, and that state propagated through the service references into the root model.

No simulated cloud reports or Microsoft 365 permission grants were used. This verifies the real failure-reporting path, not successful Microsoft 365 availability or notification delivery. Teams bot certificate mounting/environment settings remain an additional hosting prerequisite before posting can work.

For a later configuration change, regenerate parameters and redeploy; workers read config only at startup. An incremental deployment does not delete or stop an app omitted by a newly disabled service selection: stop/deactivate that existing worker explicitly before removing its deployment/reference. The foundation-only stage likewise does not stop previously deployed workers.
