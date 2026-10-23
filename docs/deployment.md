# Root configuration, health models, then Container Apps

## Deployment status and order

The [model templates](../health-model/README.md) define a root Azure Monitor Health Models resource referencing independent service models. Exchange and SharePoint each have two independently selected journeys; Teams has messaging, reply and individual-account calling journeys. Each journey has business-step child entities and receives aggregated direct reports in **External Reports**, plus optional OTEL query signals when Azure Monitor export is selected. All services/scenarios give four models, 38 entities, 34 relationships, seven journeys and 21 business-step entities. Token acquisition and internal cleanup have neither entities nor published step data; ending a test call is an explicit business step.

**Recorded live baseline, 2026-10-23:** the same-tenant
`m365-experience-consto` trial uses the private root profile `monitoring.consto.json`,
three ready revision-9 workers and immutable image
`sha256:16283e992e86f59853239047a5266b8afa4daba40598d6a631012ea835c4ef69`.
This is acceptance evidence, not a default configuration or proof of later deployments.

| Surface | Verified outcome |
| --- | --- |
| Exchange | Managed-identity mail/draft journeys Healthy; retained Inbox/Sent copies and drafts; out-of-scope control mailbox denied |
| Teams messaging/replies | Two scheduled cycles at 19:54/19:56 UTC posted retained content and verified exact bot author/correlation through Graph |
| Teams calls | Six calls across all three configured accounts completed placement, ten-second wait and verified hang-up; real signed callbacks accepted, unsigned requests rejected |
| Teams model | Experience, all three journeys/eight business steps and native root Teams reference Healthy; fresh second-cycle reports at 19:56:39-41 UTC |
| SharePoint/root | SharePoint targets/access incomplete and Unhealthy; overall root therefore Unhealthy |
| Provider/operations | Optional Service Health denied/Unknown with suppressed impact; independent worker-stall/publication detection, end-to-end notifications and OTEL cloud export unverified |

The bot-installation fault was a configuration error: RSC referenced a managed
identity rather than an Entra application registration. The corrected package keeps
the bot UAMI and uses a separate team-scoped readback application authenticated by
worker-UAMI federation. Temporary installer applications/grants were removed.
Runtime needs no user MFA, user cache, certificate or secret for these Teams journeys.
Mail/message cleanup remains disabled for inspection; mandatory hang-up is independent.

For reusable setup, follow the guides below and the [worker hosting guide](../synthetic-tests/infra/README.md).
The [action catalog](./m365-automation-capabilities.md) separates implemented journeys
from possible future capabilities; answered calls, audio verification and a second
bot are not part of this baseline.

1. Prepare a private copy of [monitoring.config.json](../monitoring.config.json): select services/scenarios, account/target metadata, health-model destination, and report policy.
2. Establish the root and enabled service models before enabling live workers.
3. Authorize each worker identity separately for its scoped Microsoft 365 journey and health-report ingestion on its own service model.
4. Package and host one worker per enabled service in Azure Container Apps.
5. Prove direct journey/step/provider reports, cross-model propagation, independent monitoring and notifications.

Follow the [model deployment/migration guide](../health-model/README.md). Preview with the approved subscription/resource group and the same private root config passed as `projectConfig=@<absolute-path>`. Deployment scope must match `healthModel.subscriptionId` and `resourceGroup`; the template cannot relocate resources based on worker destination metadata. Incremental deployment does **not** remove previously enabled service models, query signals, authentication settings or telemetry resources.

## Safe local validation

The Node package, dependencies and build output remain entirely inside [synthetic-tests/](../synthetic-tests/README.md). From the repository root:

```sh
npm --prefix synthetic-tests ci
npm --prefix synthetic-tests run exchange -- --once
npm --prefix synthetic-tests run teams -- --once
npm --prefix synthetic-tests run sharepoint -- --once
```

All services and supported journeys default to enabled. Checked-in service files select **simulation**. Console results and reports are clearly labeled previews, with no Graph/ARM credentials, real messages/files, Azure ingestion, or saved state. Simulation must not publish cloud health.

## Root and service configuration

Root `services.<service>.configFile` paths are relative to the root config's directory. Keep cadences, timeouts, mode, authentication and provider opt-ins in these separate service files. Root service/scenario switches, targets and report policy have a single source of truth; duplicate `enabled`, `targets` and obsolete `telemetry` service-file keys are rejected. Root service/scenario selection controls whether a worker runs.

Use a mounted private root config for hosted workers:

```sh
# From synthetic-tests/, after building:
node dist/exchange/src/worker.js \
  --project-config /etc/probe/monitoring.config.json \
  --config /etc/probe/exchange.json --once
```

`--config` overrides only the service file, not root targets/gates/report policy. It is relative to the working directory unless absolute. Without it, the root config's `configFile` is used. Adjust paths in a private config for the image layout; never assume a `synthetic-tests/`-only image includes a repository-root file.

Root targets must contain the approved mailbox address or site/team/channel IDs. Live settings examples select live mode but are not approved resources or permission grants; execution still requires the explicit environment gate. Replace the zero subscription placeholder, configure the exact model prefix/resource group, and ensure report TTL exceeds cadence plus the bounded cycle/report budget: 212 seconds with OTEL off, 224 seconds with it on.

Direct Teams calls select accounts only through root `services.teams.callTargets`.
The separate Teams service file sets `teamsCallingWaitSeconds` (default 10),
`teamsCallingCallbackUrl` and `teamsCallingPort`; it must not duplicate the targets.
Replace the former `teamsCallingRingSeconds` field when migrating an earlier
profile. The current business steps are `place-call`, `wait-before-hangup` and
`end-call`, not a recipient-ringing assertion.

## Identity and permissions

**Recommended enterprise deployment:** host the workers and health models in a customer-controlled Azure subscription associated with the **same Entra tenant as M365**, using a separate UAMI per service. Customer administrators approve scoped M365 grants, images, network egress and diagnostic retention. A subscription's administrator email does not establish its tenant association. Cross-tenant hosting is an explicitly approved alternative, not the default for restrictive customers. See the [short setup instructions and temporary lab procedure](./cross-tenant-access.md).

Application Graph and health reports select credentials **independently**. Both selectors default to `managed-identity`, using the explicitly selected UAMI's `AZURE_CLIENT_ID` with separate Graph/ARM audiences. Exchange/SharePoint journeys and optional providers use these application Graph credentials. **Teams journeys default separately to `teamsAuthentication: "bot"` and `botAuthentication: "managed-identity"`**, using the explicitly configured `BOT_CLIENT_ID` and `BOT_TENANT_ID`. Bot Connector messaging, Graph calling, Graph message observation and ARM reports have separate authorization requirements. Optional user-delegated messaging uses an approved public client and an encrypted-at-rest Blob MSAL cache; follow the [human bootstrap guide](./teams-user-bootstrap.md). That optional mode can require human recovery after consent/session changes and is not the unattended bot default.

For an approved cross-tenant application-Graph lab, select `graphAuthentication: certificate` with `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_CERTIFICATE_PATH`, and keep `healthReportAuthentication: managed-identity`. No Azure subscription is required in the M365 tenant for that application-Graph option. There is no runtime CLI/default-identity/credential fallback. Teams delegated hosting requires the same tenant. Generic cross-tenant federation is not implemented; Teams bot readback explicitly supports same-tenant federation through service `teamsReadbackClientId`, as described in the [bot setup](../synthetic-tests/teams/README.md#primary-setup-unattended-bot).

For explicit local report certificates, independently select `healthReportAuthentication: certificate` and set the Azure-authorized application's `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_CERTIFICATE_PATH`. **Migration:** Graph certificate mode no longer reads `AZURE_*`; move Graph credential metadata to `M365_*`. The shared hosted template supports managed-identity reporting only.

The model must already contain each destination entity; ingestion does not create entities. The worker needs the report-ingestion action on its **service model**, not subscription Owner/Contributor or root-model administration. See the [model permission contract](../health-model/README.md). The root model identity's native-reference permissions are separate from worker permissions.

Approve the [Exchange mailbox grants](../MAILBOX-SYNTHETIC-ACCESS.md), SharePoint `Sites.Selected` site-write grant, and Teams bot installation/readback permissions independently, on the identity actually accessing M365. Direct calling additionally needs `Calls.Initiate.All`, enabled calling on the Azure Bot registration, and the worker's authenticated public HTTPS callback. This calling grant is tenant-wide; root-configured call targets are a code/configuration allowlist, not an Entra recipient restriction. Explicit bot certificate authentication and optional delegated messaging remain separate choices. Graph managed identity alone does not authorize bot posting; delegated tokens never authorize provider collection or ARM reports.

Calling callbacks use Microsoft's calling-service JWT metadata, not ordinary
Entra v2 discovery. Validation requires a trusted signature/issuer, the exact bot
audience, expiry and a signed matching tenant. The raw `tid` claim and the legacy
tenant-claim URI are normalized consistently with Microsoft's .NET SDK; conflicting
aliases are rejected. Optional `nbf` is validated when present. Diagnostics expose
only allowlisted error codes/claim names, never bearer tokens or claim values.

Live execution also requires `mode: live`, all selection gates, approved targets and `ENABLE_LIVE_M365=true`. Live examples collect stable Service Health once per cycle independently of journey initialization; simulation keeps it off. Stable context needs separately approved `ServiceHealth.Read.All` admin consent. Exact overview status reports directly to `${service}-service-health` using `microsoft-reported-service-status` (100 healthy, 50 degraded, 0 interruption), with `impactSuppressed`. Failed/missing/unknown overviews produce Unknown without a numeric value and retain failure context; the existing trial observes Graph 403 pending consent. Experimental beta diagnostics remain off and require service-specific permissions plus `ENABLE_BETA_SERVICE_ACTIVITY=true`. Neither provider context nor beta diagnostics contributes to synthetic reports or Experience rollup.

## Container Apps boundary

### Optional telemetry deployment

Keep OTEL in root `otel`, not the service files. Disabled is the default; enabled `destination: console` requires no Azure telemetry resources. For `destination: azure-monitor`, deploy the model template first with the same private root config. It creates workspace-backed Application Insights and service-model query permissions. The shared worker template reads that component and supplies `APPLICATIONINSIGHTS_CONNECTION_STRING` as a secret; parameter files do not contain it. Custom `applicationInsightsName` values must match across deployments.

Direct reports continue in every mode. OTEL initialization/export failures do not suppress report attempts, but are explicit cycle failures. Review ingestion authentication, retention/cost, and actual live ingestion/query evaluation before treating OTEL as deployed. OTEL-enabled cloud ingestion remains unverified. See [OTEL model behavior](../health-model/README.md#optional-otel-signals) and [export behavior](../synthetic-tests/utils/README.md#optional-opentelemetry).

Build from the self-contained Node project:

```sh
npm --prefix synthetic-tests run build
```

Use `synthetic-tests/` as the image's application/build context. Include its compiled service entries and runtime dependencies, then mount the project-root config separately and the selected service config at explicit paths. The same image can run an explicitly selected Exchange, Teams or SharePoint entry; separate apps retain independent 60/120/300-second default cadences.

The [shared hosting template](../synthetic-tests/infra/main.bicep) and [worker module](../synthetic-tests/infra/worker.bicep) support all three selected services using the [Dockerfile](../synthetic-tests/Dockerfile). Apps use single-revision mode, one replica and 0.25 CPU/0.5 GiB each. Only selected live Teams calls enable HTTPS ingress for the authenticated callback; other apps remain private. Use one authoritative replica per target set; rollouts/restarts can repeat attempts. Config hashes trigger rollouts when mounted configuration changes. Always-running loops require CPU outside HTTP requests and an instance that does not scale to zero; validate billing/scaling settings.

Workers have no persistent volume/history/outbox. Report retries and cycle aggregation are bounded memory only. Console diagnostics remain available, but reports are not a full metrics store, percentile history, or arbitrary log-query interface. Protect certificates where explicitly required, rotate them, and verify graceful shutdown and cleanup.

## Acceptance and cleanup

- Confirm entity-level direct reports, numeric aggregates, skipped Unknowns, separate suppressed provider status, and propagation through service/root models.
- Deny report ingestion and verify explicit failures without confusing publication failures with Microsoft 365 outages.
- Stop/stall workers, observe report expiry, and verify independent detection: TTL removes external signals, not a guaranteed Unhealthy state or alert.
- Test notifications end to end through a route not dependent only on Microsoft 365.

The [enterprise reliability gate](./operations.md#enterprise-reliability-acceptance-gate), independently observed freshness, model/reference authorization and a tested alert path remain requirements, not deployed functionality.

Reports, model evaluations and always-running compute incur costs. Agree on budgets, report cadence, TTL and diagnostic retention. Azure Monitor Health Models is preview; confirm applicable terms.

Incremental deployment does not remove obsolete query bindings, permissions,
telemetry resources or app settings. Follow the [migration procedure](../health-model/README.md#apply-and-migrate);
review ownership and retention/export obligations before any deletion. Preserve
active model entities, native references and workers.

Stop producers first when decommissioning. Reconcile stale report signals and model references, revoke only approved permissions, review retained synthetic artifacts, and remove dedicated resources only after owner approval. Never delete a shared resource group or unrelated resources.
