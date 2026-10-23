# Deploy the service workers

Deploy the [health models](../../health-model/README.md#apply-and-migrate) first.
This template hosts Exchange, Teams and SharePoint in **separate Azure Container
Apps**, using one private image, independent service configurations and separate
user-assigned managed identities (UAMIs). Only selected live Teams calling enables
public HTTPS ingress; Exchange, SharePoint and messaging-only Teams stay private.

The foundation creates the registry, environment, identities and narrowly scoped
image-pull/report-ingestion roles. It creates no Microsoft 365 resources, bot
registrations or permission grants. Start with the [access setup guide](../../docs/cross-tenant-access.md)
and [Teams bot setup](../teams/README.md#primary-setup-unattended-bot).
For dated live acceptance, see [deployment status](../../docs/deployment.md#deployment-status-and-order).

## Configuration and safety

Keep a private copy of [the root config](../../monitoring.config.json) with the
approved model destination, service/scenario selection and targets. Each root
`configFile` selects the service-owned cadence, authentication and execution
settings. Commands below run from the repository root.

```sh
npm --prefix synthetic-tests run deployment:prepare -- \
  /absolute/path/monitoring.private.json /absolute/path/foundation.parameters.json
```

The preparer reads the selected files; do not maintain a second copy of their
settings in Bicep. Generated parameters contain target/access metadata, never
private keys or user tokens. Keep private configurations and parameters out of Git.
Foundation preparation leaves `deployWorkers: false`. Deploying live worker
profiles additionally requires `--enable-live`; `mode: live` alone is insufficient.

Checked-in profiles remain safe simulations. An approved live profile attempts
real authentication/operations: incomplete setup produces observed Unhealthy
journeys, not simulated success. Actions that never ran remain Unknown.

## Provision and publish

Use the approved subscription explicitly. Review each preview before applying:

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

Read the `registryName` and `registryServer` outputs. The registry disables admin
credentials and anonymous pull. Each UAMI receives AcrPull on that registry and
ingest-only permission on its own service model, not model administration.

Build from the self-contained Node project:

```sh
docker build --platform linux/amd64 --pull -t m365-synthetic:<unique-version> synthetic-tests
```

Before publishing, smoke-test all three entries with `--once`, mounted simulation
root/service files and networking disabled. This verifies packaging, not live
access. The non-root runtime image contains production dependencies and compiled
code, not private configurations or credentials.

```sh
az acr login --subscription "$SUBSCRIPTION_ID" --name '<registryName>'
docker tag m365-synthetic:<unique-version> '<registryServer>/m365-synthetic:<unique-version>'
docker push '<registryServer>/m365-synthetic:<unique-version>'

npm --prefix synthetic-tests run deployment:prepare -- \
  /absolute/path/monitoring.private.json /absolute/path/workers.parameters.json \
  '<registryServer>/m365-synthetic@sha256:<digest>' --enable-live
```

Preview and apply the same shared template with `workers.parameters.json`.
Regenerate parameters from the active root profile for every rollout; use an
immutable digest and verify the actual ready revision, image and configuration.
Do not silently substitute another deployment profile.

## Separate M365 and Azure credentials

`graphAuthentication` and `healthReportAuthentication` independently default to
`managed-identity`. Hosted reporting uses the selected Azure UAMI and ARM audience,
even when Graph uses another application identity.

Teams defaults to `teamsAuthentication: bot` and
`botAuthentication: managed-identity`. `BOT_CLIENT_ID`/`BOT_TENANT_ID` select the
attached UAMI for Bot Connector and calling. Team-scoped Graph readback uses a
separate Entra registration with `teamsReadbackClientId` and managed-identity
federation. Follow the [exact identity mapping](../teams/README.md#primary-setup-unattended-bot);
do not put the UAMI ID in the manifest's RSC `webApplicationInfo.id`.
No runtime user MFA, public-client cache or certificate is needed for this flow.

### Explicit certificate access

For approved cross-tenant Graph or certificate-backed alternatives, select
`graphAuthentication: certificate`, keep hosted reporting on managed identity,
and supply nonsecret access metadata:

```sh
npm --prefix synthetic-tests run deployment:prepare -- \
  /absolute/path/monitoring.private.json /absolute/path/workers.parameters.json \
  '<registryServer>/m365-synthetic@sha256:<digest>' \
  --enable-live --access-config /absolute/path/service-access.private.json
```

Copy only required entries from [service-access.example.json](./service-access.example.json).
The worker mounts raw UTF-8 PEMs at `/etc/credentials/m365.pem` and, for explicitly
selected bot certificate authentication, `/etc/credentials/bot.pem`. It keeps
`M365_*`, `BOT_*` and Azure reporting's `AZURE_*` separate. There is no credential
fallback. Preparation rejects incomplete/mixed metadata and inconsistent tenants.

Each UAMI needs separately approved secret-read access and network reachability
to its hosting-tenant Key Vault secrets. The template does not create the vault,
certificates or those grants. Prefer versioned secret URIs; verify new credentials
and reports before revoking old public certificates. Do not weaken vault policy.
The [cross-tenant guide](../../docs/cross-tenant-access.md) documents this explicit
certificate option; generic cross-tenant managed-identity federation is not implemented.

### Approved temporary alternative: native Container Apps certificate secret

Only with explicit organizational approval, set `m365CertificateSource: container-app`
and `m365CertificateRevision` to the public certificate's SHA-256 fingerprint
(64 hex characters). Keep its tenant/client IDs and omit `m365CertificateSecretUri`.
Mixed sources are rejected; there is no Key Vault fallback.

Supply the raw PEM through the separate secure-object parameter `serviceCertificates`,
keyed by service. An approved process may create a mode-0600 temporary parameter file
outside Git and pass only its path:

```sh
az deployment group create --subscription '<approved-subscription>' \
  --resource-group '<approved-resource-group>' --template-file synthetic-tests/infra/main.bicep \
  --parameters @/absolute/path/workers.parameters.json \
    serviceCertificates=@/secure/temporary/service-certificates.json
```

Never print/paste the private PEM or put it in ordinary parameters. Delete the
temporary file after success or failure. Supply the secure parameter on every
subsequent deployment in this mode. Native encrypted secrets still require
credential rotation and restricted secret-reading/application-modification access.

### Optional delegated Teams

Explicit `teamsAuthentication: user-delegated` provisions encrypted Blob storage
with public/shared-key access disabled and container-scoped access for the Teams
UAMI. Supply `serviceAccess.teams.teamsPublicClientId` and follow the
[human bootstrap guide](../../docs/teams-user-bootstrap.md). Accounts/targets stay
root-owned; cache partitions are per account. This optional flow can need MFA or
reauthentication. Switching to bot mode does not delete old caches/revoke grants;
retire them only through approved cleanup.

## Runtime behavior and verification

- One authoritative replica per service/target set, single-revision mode and
  independent cadence; rollouts may briefly overlap, so probes are not exactly once.
- Default sizing is 0.25 CPU/0.5 GiB per app, not a performance/reliability guarantee.
  Always-running replicas and the registry incur charges.
- Root/service configs are mounted read-only. Config hashes trigger revisions;
  secret-only rotations may require an explicit restart.
- Selected live calls expose only the Teams HTTPS callback on `/api/calls`.
  `/healthz` is static readiness, not proof of journey progress.
- Direct reports and console diagnostics are always active. Platform log forwarding
  is disabled by default; durable diagnostic retention needs separate configuration.
- Shutdown allows 60 seconds for bounded cleanup/reporting. Workers retain no
  cross-cycle journey history or durable outbox.

Verify every selected journey/action, fresh report timestamps and native service/root
rollup, not just successful ARM provisioning. The complete topology is four models,
38 entities, 34 relationships, seven journeys and 21 business steps. Provider context
is separate and impact-suppressed. Invalid schemas or unusable report credentials
can prevent publication and require independent detection.

Production acceptance additionally requires [worker-stall, publication-failure and
end-to-end notification checks](../../docs/operations.md#enterprise-reliability-acceptance-gate).
TTL expiry removes reports; it does not guarantee an Unhealthy state or alert.

## Optional OTEL export

Root `otel` is disabled by default. Disabled/console-only modes add no Application
Insights settings or platform log forwarding. Azure Monitor export runs in the
same workers, not a separate telemetry service.

For `destination: azure-monitor`, deploy the [model/telemetry resources](../../health-model/README.md#optional-otel-signals)
first. The worker template reads `appi-<healthModel.name>` (or matching
`applicationInsightsName`) and passes its connection string as a secret reference,
not a normal parameter. Verify live ingestion/query evaluation, report independence,
retention and cost; offline tests do not prove cloud export.

When disabling OTEL, incremental deployment does not remove old query bindings,
permissions, app settings or telemetry resources. Follow the [model migration
procedure](../../health-model/README.md#apply-and-migrate), preserve active models
and remove only owned resources after retention/export review.
