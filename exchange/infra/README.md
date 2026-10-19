# Exchange synthetic hosting mock — NOT DEPLOYED

This is a **compile-only Bicep scaffold**, not a deployment or an operational
monitor. No Azure resources, tenant permissions, mailbox permissions, or images
have been created by this setup. It does not validate Azure capacity, image
availability, tenant authorization, or live mail delivery.

## Scope and safe defaults

| Future setting | Resources / behavior |
| --- | --- |
| `deployWorker = false` (default) | Only the Exchange/environment-specific user-assigned managed identity would be created. |
| `deployWorker = true` | Also creates one dedicated Container Apps environment and one Container App. |
| `enableLiveProbe = false` (default) | Mounted live config is disabled, and `ENABLE_LIVE_M365` is `false`. No simulated results or fabricated health are substituted. |
| `enableLiveProbe = true` | Enables live execution, but grants no authorization. Approved mailbox, image, and tenant permissions remain prerequisites. |

The flags are independent. Creating the app with its probe disabled is
**intentionally nonoperational**: the current disabled worker exits rather than
running a monitoring loop. A minimum replica count does not make that revision
stable, healthy, or useful; restarts may occur. Keep the app off until its
prerequisites are ready.

The worker is stateless, has **no HTTP ingress, listening port, Blob storage,
checkpoint store, or separate telemetry worker**. It uses one replica
(`minReplicas = maxReplicas = 1`) and single-revision mode. The sample
`0.25` vCPU / `0.5Gi` sizing is not a production reliability or performance
commitment. Stopped/stalled-worker and telemetry-loss detection, notification
testing, capacity, and production hardening remain separate acceptance gates.

No Log Analytics workspace, Application Insights component, health-model
workspace, registry, role assignment, app registration, or Key Vault is created.
Existing Log Analytics and Application Insights are not infrastructure
dependencies. Container Apps platform log forwarding is explicitly disabled
(`destination: none`); that is separate from the optional in-process exporter.

## Inputs

| Parameter | Default / purpose |
| --- | --- |
| `location` | Current resource group's location. |
| `identityName` | `uami-exchange-synthetic-mock`; choose a stable, distinct identity per service/environment. |
| `environmentName` | `cae-exchange-synthetic-mock`; optional dedicated ACA environment. |
| `appName` | `ca-exchange-synthetic-mock`; optional Exchange app. |
| `deployWorker` | `false`; controls both ACA resources, not the identity. |
| `enableLiveProbe` | `false`; explicit live-execution gate. |
| `workerImage` | Required existing approved image URI; the parameter file contains an unusable placeholder. |
| `workerEntrypoint` | `dist/exchange/src/worker.js`, relative to the image working directory. |
| `registryServer` | Empty; optionally an existing ACR hostname, without scheme or image path. |
| `mailboxAddress` | Empty; later supply the explicitly approved same-tenant mailbox. |
| `intervalSeconds` | `60`, allowed `1–86400`; Exchange-only cadence. |
| `timeoutSeconds` | `45`, allowed `1–120`; journey timeout. |
| `applicationInsightsConnectionString` | Empty secure parameter; only a supplied value selects `azure-monitor` telemetry. |

Identity naming is independent of the app name so app replacement does not
require an identity change. Retain that identity deliberately; deployment mode
and deletion/lifecycle governance are outside this mock.

## Image and single-config contract

An **approved image built from this repository and already published** must
exist before the worker is usable. This mock does not add a Dockerfile, install
dependencies, build/package the application, or publish an image.

The image must include Node.js, the compiled root-package output and its runtime
dependencies (including the embedded OpenTelemetry SDK/exporter), and an image
working directory matching `workerEntrypoint`. The container command is:

```text
node dist/exchange/src/worker.js --config /etc/probe/exchange.json
```

The approved root-package image must contain that compiled worker path.
`workerEntrypoint` can be overridden if an approved image uses another working
directory/layout. Replace the image placeholder in `main.bicepparam` before any
future deployment. No runtime source changes are part of this scaffold.

The template renders exactly one Exchange config and mounts it read-only at
`/etc/probe/exchange.json` using an ACA secret-backed volume. The config contains
noncredential target metadata; the secret volume is just a convenient file
mount. No startup shell writes a file, and no `PROBES_JSON` environment variable
is supplied. Its contents are equivalent to:

```json
{
  "type": "exchange",
  "enabled": false,
  "intervalSeconds": 60,
  "timeoutSeconds": 45,
  "mode": "live",
  "graphAuthentication": "managed-identity",
  "cohort": "exchange-global",
  "telemetry": "console",
  "targets": []
}
```

A nonempty `mailboxAddress` produces
`targets: [{ "id": "exchange-probe-001", "mailbox": "<approved mailbox>" }]`.
An empty target list is valid while disabled; enabling without a target must
fail configuration validation rather than invent a target. The worker exports
binary attempt success (`1`/`0`), request/send duration, confirmed-delivery
duration, and total journey duration. Success rates and health are evaluated
downstream, not stored in the worker.

## Same-tenant identity and authorization handoff

1. **Identity stage, later and explicitly authorized:** a deployment with
   `deployWorker = false` would create just the UAMI. Its outputs support the
   external administrator handoff. No deployment is performed here.
2. **Tenant authorization, external administrator:** authorize the selected
   UAMI's service principal for the Exchange synthetic's required application
   permissions/Exchange application RBAC and restrict mailbox access to the
   approved test mailbox. The Azure subscription identity and mailbox must
   belong to the same Microsoft Entra tenant. Mailbox provisioning/licensing,
   Graph application-role assignment, Exchange RBAC, and consent are not Bicep
   resources in this scaffold and are not changed by starting the app.
3. **Image-pull authorization, external administrator if ACR is private:** set
   `registryServer` to the existing registry hostname and authorize this UAMI
   for the registry's pull-only role at the appropriate registry/repository
   scope. For a registry using classic RBAC, that is scoped `AcrPull`; registries
   using repository ABAC require the corresponding repository-reader role and
   conditions instead. Ensure the registry accepts managed-identity image
   pulls. Do not enable admin passwords or grant broad Contributor permissions.
   No registry or role assignment is created here.
4. **Worker stage, later and explicitly authorized:** replace the image
   placeholder, verify the packaged entrypoint, supply the approved mailbox, complete the external
   permission handoff, and only then consider `deployWorker = true` and
   `enableLiveProbe = true`.

The app explicitly attaches this UAMI and sets:

- `AZURE_CLIENT_ID` to its client ID.
- `AZURE_TENANT_ID` to the Azure subscription tenant ID.
- `ENABLE_LIVE_M365` from `enableLiveProbe`.

These identifiers are not credentials. The managed-identity runtime contract
is **only** `ManagedIdentityCredential({ clientId })` with Graph scope
`https://graph.microsoft.com/.default`; it must not guess a host identity, use
`DefaultAzureCredential`, or fall back to certificates/secrets. No
`AZURE_CLIENT_CERTIFICATE_PATH` is needed or supplied for hosted Exchange.
Explicit local certificate authentication and Teams bot certificate
authentication are outside this mock.

Optional telemetry uses the **existing** Application Insights connection string
only when `applicationInsightsConnectionString` is supplied securely. It is
stored as an ACA secret and referenced by
`APPLICATIONINSIGHTS_CONNECTION_STRING`, never output. Without it, the config
selects `console`. This is a telemetry-ingestion setting, separate from mailbox
authentication; no Application Insights keys are queried and no new telemetry
resources are created. Keep real connection strings out of committed parameter
files and command history.

## Compile-only verification

With the existing Bicep CLI available, run from this directory:

```sh
bicep build main.bicep --stdout > /dev/null
bicep build-params main.bicepparam --stdout > /dev/null
```

If the CLI is not on `PATH`, use its existing installed executable (for example,
`"$HOME/.azure/bin/bicep"`) instead. No compiler upgrade/install is needed for
this mock. Compilation may restore public Bicep type definitions; it does not
deploy, obtain Graph tokens, assign permissions, or perform ARM validation or
what-if. Do not treat compilation as deployment or operational verification.

The resource API versions are
`Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30`,
`Microsoft.App/managedEnvironments@2025-07-01`, and
`Microsoft.App/containerApps@2025-07-01`. The schemas were checked against
Bicep's authoritative resource catalog.

Outputs are limited to `identityResourceId`, `clientId`, `principalId`,
`tenantId`, and `appId` (empty when `deployWorker = false`). No token, mailbox
content, or connection string is output.

References:
[Container Apps schema](https://learn.microsoft.com/azure/templates/microsoft.app/2025-07-01/containerapps),
[managed environment schema](https://learn.microsoft.com/azure/templates/microsoft.app/2025-07-01/managedenvironments),
[UAMI schema](https://learn.microsoft.com/azure/templates/microsoft.managedidentity/2024-11-30/userassignedidentities).
