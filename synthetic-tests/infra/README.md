# Deploy the service workers

`npm run deploy` deploys the [health models](../../health-model/README.md#apply-and-migrate)
first, then this template, which hosts each enabled tenant and service in a
**separate Azure Container App**, using one private image, the same root config and
separate user-assigned managed identities (UAMIs). Only selected live Teams calling
enables public HTTPS ingress; Exchange, OneDrive and messaging-only Teams stay private.
The checked-in config selects all three supported services.
OneDrive reuses the environment/registry and receives its own UAMI
(`uami-<healthModel.name>-onedrive` in the checked-in config, an existing one named in
`worker.identity`), worker and ingest-only service-model assignment.
It adds no bot, user sign-in, storage account or M365 grants. Its optional stable
provider uses the distinct Microsoft OneDrive service entry, not SharePoint.
See the [OneDrive setup and exact permission boundary](../onedrive/README.md).
After the foundation creates its identity, run
[bulk OneDrive setup](../../docs/onedrive-setup.md) before enabling live OneDrive
workers. For hundreds of accounts, size the service concurrency/cycle budget
and root report TTL; neither additional replicas nor the default deadline solve
queued-account capacity.

The foundation creates the registry, environment, identities and narrowly scoped
image-pull/report-ingestion roles. It creates no Microsoft 365 resources, bot
registrations or permission grants. Start with the [access setup guide](../../docs/cross-tenant-access.md)
and [Teams bot setup](../teams/README.md#primary-setup-unattended-bot).
For dated live acceptance, see [deployment status](../../docs/deployment.md#deployment-status-and-order).

## Configuration and safety

Everything comes from the single root [monitoring.config.json](../../monitoring.config.json):
the [`deployment` section](../../docs/deployment.md#the-deployment-section) and each
service's `worker` and `access` blocks under `tenants[]`. There is no parameters file
to prepare; `npm run deploy` hands the whole normalized config to this template as
`projectConfig`, with names expanded to full resource IDs, defaults applied and the
`.env` IDs filled in ([what the config holds](../../docs/deployment.md#what-the-config-holds)).
It holds names and a few IDs, never private keys or user tokens.

| `worker` field | Meaning |
| --- | --- |
| `appName` | Container App name, unique across all workers |
| `identityName` or `identity` | Exactly one: the name of a UAMI the foundation creates, or the name (or full resource ID) of an existing approved one, which a live worker requires |
| `identityClientId` | Optional; must match the existing `identity`'s client ID |
| `cpu`, `memory` | Default 0.25 and `0.5Gi`; memory in Gi must equal twice the CPU |

For selected live Teams meeting calling, the Teams service `access` block must name
`peerIdentity`, the **existing approved** peer UAMI, plus `bot` and `peerBot`, the two
existing bot registrations; deployment checks them before changing anything. The peer's
client ID comes from `.env`, where `npm run setup` looks it up from `peerIdentity`, and
every call target's `peerBotClientId` (which defaults to it) must match. The worker template
attaches that identity alongside the unchanged primary reporting/image-pull UAMI and
supplies `TEAMS_CALLING_PEER_CLIENT_ID`; non-Teams, simulation and calling-disabled
workers receive neither. It creates no peer, Azure Bot or Graph grants. Both bots
require separately approved `Calls.JoinGroupCall.All` and the same `/api/calls`
callback (`execution.teamsCallingCallbackUrl`, which setup writes to `.env`), on existing
port 8080 with one replica. See
[meeting setup](../teams/README.md#two-bot-meeting-setup).

A `live` service attempts real
authentication/operations: incomplete setup produces observed Unhealthy
journeys, not simulated success. Actions that never ran remain Unknown. Live
execution needs `execution.mode: "live"` and `deployment.enableLiveProbes: true`;
see the [live gates](../../docs/deployment.md#live-execution-gates).

## Provision and publish

From `synthetic-tests/`, preview and then deploy:

```sh
npm ci
npm run deploy -- --plan
az login
npm run deploy
```

The command applies this template twice with the same config: first the foundation
(`deployWorkers: false`, no image), then the workers with the pinned image digest. It
runs `what-if` for each before applying; see its
[phases](../../docs/deployment.md#deploy-with-one-command). The registry disables
admin credentials and anonymous pull. Each UAMI receives AcrPull on that registry and
ingest-only permission on its own service model, not model administration.

Microsoft 365 access is prepared separately by `npm run setup`
([what it covers](../../docs/deployment.md#set-up-microsoft-365-with-one-script)). Its
reply-seed step builds the worker image in this registry and runs a temporary Container
Apps job in this environment, so it needs Contributor on the resource group and ACR build
rights.

To reuse an approved environment and registry, set `deployment.foundation` to
`{ "mode": "existing", "environment": "<name or ID>", "registry": "<name or ID>" }`: a bare
name is a resource in the health model's resource group, and a full resource ID reaches
another group or subscription.
This leaves their configuration untouched while workers and the scoped identity and
report assignments update; `{ "mode": "create", ... }` creates them.

`deployment.image` builds this project directory with `az acr build`, using its
`Dockerfile`, and tags `<tag>-<run ID>`; workers run the resulting immutable digest.
`{ "mode": "existing", "reference": "<registry>/<repository>@sha256:<digest>" }`
skips the build and requires that digest in the configured registry. The non-root
runtime image contains only production dependencies and compiled code, not the config
or credentials. Each worker mounts the whole root config read-only at
`/etc/probe/monitoring.config.json`, with names expanded, defaults applied and the `.env`
IDs already filled in by `npm run deploy`, so workers need no `.env`; verify the actual
ready revision, image and config after every rollout.

### Excluding a previously deployed service

An incremental deployment does not delete or stop an app for a service the config
no longer enables. After an approved service removal, explicitly deactivate that owned
app's active revisions with `az containerapp revision deactivate`, then verify
there are no active revisions or running replicas. Do not delete unrelated apps
or use complete deployment mode on the shared resource group. The model deploy
suppresses a service reference with no selected implemented journeys, so retained
excluded-service entities cannot affect root rollup.

## Separate M365 and Azure credentials

`execution.graphAuthentication` and `execution.healthReportAuthentication`
independently default to `managed-identity`. Hosted reporting uses the selected Azure
UAMI and ARM audience, even when Graph uses another application identity.

Teams defaults to `teamsAuthentication: bot` and
`botAuthentication: managed-identity`. `BOT_CLIENT_ID`/`BOT_TENANT_ID` select the
attached UAMI for Bot Connector and calling. Team-scoped Graph readback uses a
separate Entra registration with `teamsReadbackClientId` and managed-identity
federation. Follow the [exact identity mapping](../teams/README.md#primary-setup-unattended-bot);
do not put the UAMI ID in the manifest's RSC `webApplicationInfo.id`.
No runtime user MFA, public-client cache or certificate is needed for this flow.

### Explicit certificate access

For approved cross-tenant Graph or certificate-backed alternatives, select
`execution.graphAuthentication: "certificate"`, keep hosted reporting on managed
identity, and add nonsecret references to that service's `access` block:

```json
"access": {
  "m365TenantId": "<m365-tenant-id>",
  "m365ClientId": "<application-client-id>",
  "m365CertificateSource": "key-vault",
  "m365CertificateSecretUri": "https://<vault>.vault.azure.net/secrets/<name>/<version>"
}
```

The worker mounts the raw UTF-8 PEM at `/etc/credentials/m365.pem`. Bot participants
remain managed-identity-only; no bot certificate path exists. It keeps `M365_*`,
`BOT_*` and Azure reporting's `AZURE_*` separate. There is no credential
fallback. Deployment preparation, including `--plan`, rejects incomplete or mixed
references and inconsistent tenants.

Each UAMI needs separately approved secret-read access and network reachability
to its hosting-tenant Key Vault secrets. The template does not create the vault,
certificates or those grants. Prefer versioned secret URIs; verify new credentials
and reports before revoking old public certificates. Do not weaken vault policy.
The [cross-tenant guide](../../docs/cross-tenant-access.md) documents this explicit
certificate option; generic cross-tenant managed-identity federation is not implemented.

### Approved temporary alternative: native Container Apps certificate secret

Only with explicit organizational approval, set `m365CertificateSource` to
`"container-app"` in that `access` block. Keep its tenant/client IDs, omit
`m365CertificateSecretUri`, name an environment variable in
`m365CertificateEnvironmentVariable` and set `m365CertificateRevision` to the
SHA-256 hex digest of the exact PEM text in that variable. Mixed sources are
rejected; there is no Key Vault fallback.

Export the raw PEM (certificate and private key) into that variable only for the
deployment process, then run `npm run deploy`. It rejects a missing, malformed or
mismatched value, passes the PEM to the template as the secure `serviceCertificates`
parameter through a mode-0600 temporary file in its protected run directory, and
deletes that file when the run ends. Never put the PEM in the config, print it or
paste it anywhere. Export the variable on every deployment in this mode. Native
encrypted secrets still require credential rotation and restricted
secret-reading/application-modification access.

## Runtime behavior and verification

- One authoritative replica per tenant/service target set, single-revision mode and
  independent cadence; rollouts may briefly overlap, so probes are not exactly once.
- Default sizing is 0.25 CPU/0.5 GiB per app, not a performance/reliability guarantee.
  Always-running replicas and the registry incur charges.
- Each worker runs `node dist/<service>/src/worker.js` with
  `--config /etc/probe/monitoring.config.json --tenant <tenant id>` against the
  read-only mounted root config. Config changes create a new revision; secret-only
  rotations may require an explicit restart.
- Selected live calls expose only the Teams HTTPS callback on `/api/calls`.
  `/healthz` is static readiness, not proof of journey progress.
- Direct reports and console diagnostics are always active. Platform log forwarding
  is disabled by default; durable diagnostic retention needs separate configuration.
- Shutdown allows 60 seconds for bounded cleanup/reporting. Workers retain no
  cross-cycle journey history or durable outbox.

Verify every selected journey/action, fresh report timestamps and native service/root
rollup, not just successful ARM provisioning. The checked-in config selects ten
active journeys and 38 business steps, plus Exchange's Mail and Calendar
parents, across four models, 57 entities and 53 relationships by default;
enabling Service Health adds three entities and
relationships. There is no proposal catalog. Provider context
is separate and impact-suppressed. Invalid schemas or unusable report credentials
can prevent publication and require independent detection.

Each service's optional stable collector also runs an independent provider lane
(`providerIntervalSeconds`, default 300), with no second worker/container.
Exchange/Teams additionally support five approved beta activity functions each.
Beta collection needs `deployment.enableBetaServiceActivity: true`, which mounts
`ENABLE_BETA_SERVICE_ACTIVITY=true`; the service's `execution.serviceActivity` still
owns beta enablement, functions and thresholds. See the
[direct provider report setup](../../docs/provider-monitoring.md).
OneDrive rejects beta activity settings; its stable collector requires the approved
provider application's consent and federation trust for the OneDrive worker UAMI.

Production acceptance additionally requires [worker-stall, publication-failure and
end-to-end notification checks](../../docs/operations.md#enterprise-reliability-acceptance-gate).
TTL expiry removes reports; it does not guarantee an Unhealthy state or alert.

## Optional OTEL export

Root `otel` is disabled by default. Disabled/console-only modes add no Application
Insights settings or platform log forwarding. Azure Monitor export runs in the
same workers, not a separate telemetry service.

For `destination: azure-monitor`, the [model/telemetry resources](../../health-model/README.md#optional-otel-signals)
deploy before the workers. The worker template reads `appi-<healthModel.name>` (or the
matching `deployment.applicationInsightsName`) and passes its connection string as a
secret reference, not a normal parameter. Verify live ingestion/query evaluation,
report independence, retention and cost; offline tests do not prove cloud export.

When disabling OTEL, incremental deployment does not remove old query bindings,
permissions, app settings or telemetry resources. Follow the [model migration
procedure](../../health-model/README.md#apply-and-migrate), preserve active models
and remove only owned resources after retention/export review.
