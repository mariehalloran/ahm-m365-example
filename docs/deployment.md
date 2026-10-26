# Root configuration, health models, then Container Apps

## Deployment status and order

The [model templates](../health-model/README.md) define a root referencing independent service models. Exchange has six implemented journeys, SharePoint two and Teams three. Each implemented journey/business step receives aggregated direct **External Reports**, plus optional OTEL query signals. The full documented catalog also includes 23 explicitly planned/unimplemented Unknown journey roots and 78 planned steps, including a planned-only OneDrive model, without adding runtime scenarios or workers. All default selections give five models, 180 entities, 175 relationships, 34 journey roots and 118 business steps. Planned roots and the OneDrive reference are suppressed to preserve implemented synthetic rollup. Token acquisition and generic cleanup are internal; explicit deletion/cancellation/hang-up are business steps. Provider context is separately suppressed and runs on independent container-local lanes.

### Full documented catalog rollout — 2026-10-26

Deployed to subscription `17a37fff-b1ef-4af7-9bd2-70898b286aaf`, tenant
`5e7897a0-4a38-43f3-914d-195d5355e969`, resource group `rg-m365-consto`,
root model `m365-experience-consto`. The original active private
`monitoring.consto.json` and its existing service files were retained: no hidden
profile, target/scenario override, Microsoft 365 permission change, new Reader
grant or dependency upgrade. Model what-if showed no deletes or unrelated
infrastructure changes. Models were deployed before the reporter update.

All three existing Container Apps use ready revision **0000012**, with image-only
updates preserving configured environment/root/service settings and assigned UAMIs:

```text
crm365ctbcoagujf67a.azurecr.io/m365-synthetic@sha256:c30eb4681e8477478548be524718e891beb1baff3e1f6c60a9865514fb495b53
```

ACR build `cj5`, tag `journey-catalog-20261026`. No OneDrive worker, worker identity,
schedule, runtime scenario, live target or fabricated health report was added.

**Catalog reconciliation:** paginated live ARM entity/relationship inventories
were compared with the implemented and planned catalogs, including every business
step and relationship, not just deployment outputs.

| Model | Implemented journeys expected / deployed | Planned roots expected / deployed | Entities expected / deployed | Relationships expected / deployed |
| --- | --- | --- | --- | --- |
| Exchange | 6 / 6 | 4 / 4 | 53 / 53 | 52 / 52 |
| Teams | 3 / 3 | 7 / 7 | 50 / 50 | 49 / 49 |
| SharePoint | 2 / 2 | 6 / 6 | 43 / 43 | 42 / 42 |
| OneDrive | 0 / 0 | 6 / 6 | 29 / 29 | 28 / 28 |
| Root references | — | — | 5 / 5 | 4 / 4 |
| **Total** | **11 / 11** | **23 / 23** | **180 / 180** | **175 / 175** |

Implemented names/IDs are unchanged: Exchange `exchange-global`, `exchange-draft`,
`exchange-attachment`, `exchange-distribution`, `exchange-recurring`,
`exchange-meeting`; Teams `teams-global`, `teams-reply`, `teams-call`; SharePoint
`sharepoint-global`, `sharepoint-rename`.

Every planned ID below was present with its documented display name prefixed
`[Planned / unimplemented]`. The full display-name and workflow mapping is in the
[model catalog](../health-model/README.md#catalog-versus-modeled-and-live-coverage)
and [planned definitions](../health-model/infra/planned-catalog.bicep).

| Entity prefix | Deployed planned suffixes (prefix + suffix is the exact ID) |
| --- | --- |
| `exchange-planned-` | `search-organize-mail`, `external-inbound`, `external-outbound`, `outlook-web` |
| `teams-planned-` | `two-bot-conversation`, `answered-audio`, `scheduled-meeting`, `recipient-file-sharing`, `adaptive-card`, `teams-web-messaging`, `teams-web-meeting` |
| `sharepoint-planned-` | `library-folder-roundtrip`, `list-item-lifecycle`, `recipient-sharing`, `document-versions`, `search-indexing`, `browser-upload` |
| `onedrive-planned-` | `user-drive-roundtrip`, `app-folder-lifecycle`, `recipient-sharing`, `document-versions`, `search-retrieve`, `browser-upload` |

All **34 journey roots** have native `properties.icon.iconName: UserFlow`, with no
custom SVG; other entities have no journey icon. All **23 planned roots and 78
planned steps** were Unknown, labeled unimplemented, and had no external/OTEL
signals. Planned roots are impact-suppressed. All four root reference destinations
match the deployed service model IDs; the OneDrive reference is Unknown/suppressed.
No new Reader grant was authorized for that planned-only model, so native OneDrive
health retrieval is not claimed. Existing implemented references retain Standard
impact and existing read permissions.

**Observed reporting, beginning 14:19 UTC on revision 12:**

- All **16 provider-call children** had fresh ingested external signals: seven each
  for Exchange/Teams, two for SharePoint. Stable overview values were Exchange **50 /
  Degraded**, Teams **50 / Degraded**, SharePoint **100 / Healthy**. Their Service
  Health parents remain suppressed, independent of synthetic rollup.
- Issue-count reports were numeric **40 / Unknown**, **0 / Unknown**, **0 / Unknown**
  respectively. Zero issues is not evaluated Healthy without a configured health
  threshold. All ten beta functions still returned **403** and ingested
  **Unknown without numeric values**, not fabricated success.
- Exchange mail/draft/DL completed successfully. Attachment/hash/reply completed
  successfully but one 15,359 ms journey sample breached the 15,000 ms degraded
  duration threshold. Both calendar journeys still produced actual **403 /
  Unhealthy** evidence.
- Teams' first cycle completed messaging, reply and all three signaling-only calls.
  A subsequent publication/readback attempt reported **read-failure / Unhealthy**;
  reply and all three call attempts completed. Do not equate successful attempts
  with an always-Healthy journey or infer audio/second-bot coverage.
- SharePoint's two synthetic journeys remained **configuration-failure /
  Unhealthy** because approved live targets are missing. Healthy provider context
  does not repair or conceal this. Overall experience remained Unhealthy; planned
  Unknown nodes did not replace implemented failure evidence.

A final ARM recheck showed **all three Teams journeys and Teams Experience Healthy**
despite its seven planned Unknown roots, directly confirming suppression does not
poison implemented rollup. Exchange attachment/reply had also returned to Healthy;
mail/draft/DL remained Healthy, both calendars Unhealthy, SharePoint's two journeys
Unhealthy and OneDrive Unknown. The overall root remained Unhealthy. The intermittent
Teams readback failure and earlier latency degradation above remain valid observed
failures, not erased acceptance gaps.

The previous provider-parent signals were still visible during bounded migration
inspection: Exchange last reported at **14:15:36 UTC**, SharePoint **14:15:31 UTC**,
Teams **14:20:28 UTC**. Their normal 15-minute TTLs end around **14:30:36**,
**14:30:31**, **14:35:28 UTC** respectively. New reporters publish to the call
children only; no fabricated cleanup report was posted. Until natural expiry,
these old signals may coexist under the already-suppressed parent.

Direct ingestion has **no native `dataUnit` field**: units are carried in
`additionalContext.unit` (`Percent`, `Milliseconds`, `Count`, categorical
`status-score`). This is not a promise of native external-signal unit labels.
Optional OTEL retains native Percent/Milliseconds units; it remains disabled in
this profile, and planned-only nodes create no OTEL query resources.

Validation passed: **961 tests across 37 worker test files**, TypeScript typecheck
and production build, **16 model template contracts**, **12 worker infrastructure
contracts**, and `git diff --check`. Live checks additionally verified exact
inventory, icons, Unknown/no-reports, suppression, root destinations, new revision
readiness and real provider-child ingestion. Independent stalled-worker /
broken-publication detection, end-to-end notifications, OTEL cloud validation,
calendar authorization, beta backend access and approved SharePoint targets remain
acceptance gaps. This rollout does not claim full enterprise monitoring acceptance.

### Earlier revision-11 live acceptance evidence — 2026-10-26

The same-tenant `m365-experience-consto` trial has all three workers at
ready/desired revision **11**, using immutable image:

```text
crm365ctbcoagujf67a.azurecr.io/m365-synthetic@sha256:d9ffec32e11a207f6393e92e2b1ec2ede7e197eb4cd585d5e0b54d56e7038a82
```

The original private root profile `monitoring.consto.json` was migrated in place:
all six Exchange journeys selected, user1 sender → user2 recipient, dedicated
`ahm-synthetic-mail@constosuites.onmicrosoft.com` with user1/user2 as explicit
expected recipients, provider cadence 300 seconds and explicit live beta approval.
Only the two approved mail/calendar accounts are scoped; user3 remains denied for
both Mail and Calendar, with no tenant-wide grants.

| Surface | Observed outcome |
| --- | --- |
| Exchange mail/draft/DL | Actual revision-11 logs at 13:50 UTC: mailflow, draft and DL journeys passed. Mail/draft cleanup remains disabled; explicit draft deletion was skipped, not counted as failed or verified |
| Exchange attachment/reply | All four business steps passed: send attachment, verify delivered hash, send correlated reply and confirm received reply |
| Exchange calendars | Both selected calendar journeys remain Unhealthy: user1 actual Graph access returns `403 ErrorAccessDenied`; user2 calendar access succeeds. These are real failures, not simulated successes |
| Teams messaging/replies | Actual revision-11 posts and replies passed Graph readback, including expected bot author and correlation |
| Teams calls | All three configured account call flows passed |
| Stable provider context | Real direct reports were ingested through ARM: Exchange and Teams Degraded; SharePoint Healthy; all with suppressed impact, independent of synthetic rollup |
| Beta activity | All ten selected Exchange/Teams functions returned HTTP 403 backend `UnknownError`, “The redirected request failed.” The actual provider token contains both approved beta roles plus Service Health. Collection remains explicitly enabled without synthetic fallback or broader grants |
| SharePoint synthetic journeys | Missing configured live targets remain an acceptance gap and produce Unhealthy evidence; stable provider Healthy does not establish synthetic journey health |
| Scheduling | Nine measured revision-10 fast-lane intervals were 59.977–60.018 seconds; extended interval 300.036941 seconds and provider interval 300.023373 seconds. Revision 11 uses the same scheduler/configuration; these measurements are not a new revision-11 cadence sample |

**Calendar acceptance remains pending.** Scoped RBAC diagnostics show user1 in
scope, but those diagnostics bypass the application authorization cache. Microsoft
documents that an active application cache can retain authorization for up to two
hours ([Exchange application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)).
The grant was applied around 13:05 UTC; do not treat an in-scope diagnostic as proof
of effective Graph access or assume that the observed denial is resolved. Recheck
actual operations after cache refresh; retain Unhealthy reports until they succeed.
Do not switch actors or broaden grants to hide this failure.

**This is observed deployment evidence, not full enterprise monitoring acceptance.**
Independent stopped/stalled-worker and broken-publication/telemetry/alerting
detection, end-to-end notification delivery and OTEL cloud ingestion/query evaluation
remain unverified. The current capture does not establish fresh complete
journey/step/root rollup verification. Beta backend availability and SharePoint
live setup remain unresolved. API-backed messaging/call operations do not establish
employee UI experience, answered calls or audio quality.

### Historical live baseline — 2026-10-23

The earlier same-tenant
`m365-experience-consto` trial used the private root profile `monitoring.consto.json`,
three ready revision-9 workers and immutable image
`sha256:16283e992e86f59853239047a5266b8afa4daba40598d6a631012ea835c4ef69`.
The following outcomes apply only to that historical baseline, not revision 11.

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

Live execution requires `mode: live`, root selection, approved targets and `ENABLE_LIVE_M365=true`. Independent provider lanes inside each service container default to 300 seconds (`providerIntervalSeconds`), with separate provider identity/permissions. Approved stable states report directly to suppressed Service Health; missing/failed/unapproved data is Unknown. Optional beta supports all five approved Exchange and Teams functions, with explicit customer thresholds for direct context reports; otherwise raw activity remains diagnostic. No mandatory Log Analytics or synthetic/Experience rollup impact is added. Parameter preparation requires **`--enable-beta-service-activity`** to set ARM `enableBetaServiceActivity: true` and mount **`ENABLE_BETA_SERVICE_ACTIVITY=true`**; it never silently enables beta from another profile. See [exact provider setup and endpoints](./provider-monitoring.md).

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
