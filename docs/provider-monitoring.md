# Microsoft 365 provider monitoring

Provider entities and collection are **off by default**. Set root
`"serviceHealth": { "enabled": true }` to include the supporting entities and
permit the source settings below. Omitting the root setting, omitting `enabled`,
or setting it to `false` means no Service Health entity, provider lane, Graph
provider calls or provider reports. Synthetic journeys are unchanged.

Microsoft documents the related advanced monitoring feature for at least 5,000
qualifying Office/Microsoft 365 E3/E5 licenses and 50 monthly active users.
Confirm beta API eligibility with Microsoft; consent alone does not establish it.
These published feature minimums do not establish the cause of an observed beta 403.
These minimums do **not** apply to stable Service Health.

Each service has an **independent provider schedule**, executed by Azure Functions.
Collection does not wait for synthetic execution and cannot change synthetic
success, business-step measurements or Experience rollup. All stable and approved
beta signals for a product belong to **one** impact-suppressed
`${service}-service-health` entity, reported ungrouped.
The [service READMEs](../synthetic-tests/README.md#services) explain each product's
journeys, model image and optional provider sources.

## Short setup

1. Explicitly enable root `serviceHealth.enabled` only when this supporting context is wanted.
2. Approve application `ServiceHealth.Read.All` for stable health data and separately
   approve `ServiceMessage.Read.All` for Message Center. Beta requires its existing
   `ServiceActivity-Exchange.Read.All` and/or `ServiceActivity-Teams.Read.All`.
   These provider permissions are tenant-wide; runtime filtering is not an access
   boundary. Keep synthetic mailbox/calendar/drive grants narrowly scoped.
   Name the federated read-only provider application once per tenant as
   `providerClientId`: services enabling `serviceHealth`, `serviceMessages` or
   `serviceActivity` inherit it unless `execution.providerClientId` overrides it.
   Each hosted execution identity needs its own federation trust; see
   [provider authentication](#provider-authentication).
3. Set these in the matching service file's `tenants[].config.execution`
   (composed as `tenants[].services.<service>.execution`), not root target fields:

```json
{
  "providerIntervalSeconds": 60,
  "serviceHealth": true,
  "serviceMessages": true,
  "serviceActivity": {
    "enabled": true,
    "aggregationIntervalMinutes": 15,
    "lookbackMinutes": 30,
    "maxAgeMinutes": 60,
    "thresholds": {
      "getConnectivityMetricsForExchange": {
        "degradedBelow": 99,
        "unhealthyBelow": 95
      }
    }
  }
}
```

`serviceMessages` defaults **off**, independently of stable health and beta.
Messages-only selection inherits the same provider app and uses the same service
Function and independent provider schedule. The checked-in test configuration enables messages for all
four selected products and sets the provider cadence to 60 seconds. SharePoint
keeps those stable selections/cadence; missing separately approved provider
access reports Unknown and never triggers an automatic grant. Synthetic schedules
are unchanged. Selected beta functions share that cadence and are polled more
often; their aggregation windows and health mappings do not change.

The threshold example applies to **Exchange only**; Teams may omit `thresholds` entirely. Counts and Teams percentages are diagnostic by default. Thresholds are explicit customer choices, not universal SLOs. An optional `functions` array selects unique functions for that service: up to nine for Exchange or five for Teams. Omitting it selects every supported function for that service. Beta remains **disabled by default**; enable it per service. The checked-in configuration explicitly enables all nine Exchange and five Teams functions.

For **OneDrive and SharePoint**, enable the wanted stable health/messages switches and keep
`serviceActivity.enabled: false`, with no beta `functions` or `thresholds`.
The inherited provider app does not automatically acquire Graph permissions.

4. Set the explicit approvals in root `deployment`, then run `npm run deploy`,
   which establishes matching models before enabling scheduled execution:

```json
"deployment": { "enableLiveProbes": true, "enableBetaServiceActivity": true }
```

`enableBetaServiceActivity: true` supplies `ENABLE_BETA_SERVICE_ACTIVITY=true`
to execution Functions; deployment rejects live beta collection without it.
Local live commands still require both `ENABLE_LIVE_M365=true` and
`ENABLE_BETA_SERVICE_ACTIVITY=true`; beta acknowledgement is also required when
explicitly testing beta-enabled simulation. `--once` settles synthetic and provider
lanes before exit.

5. Validate actual Graph authorization, returned buckets and accepted AHM ingestion. Permission assignment is not proof of tenant eligibility, publication latency, model evaluation or alert delivery. Beta APIs are preview/unsupported for production under their beta contract.

## Provider authentication

Provider read permissions belong to a **separate Entra application**, not the
Exchange mailbox, OneDrive folder, SharePoint site or Teams bot authorization.
This keeps tenant-wide provider consent separate from synthetic resource scopes.
Creating a provider app or federation trust does not grant those permissions.

An application administrator prepares the app/service principal and federation;
a Privileged Role Administrator or Global Administrator approves the required
Microsoft Graph **application** roles:

| Enabled source | Role on the provider application |
| --- | --- |
| Stable overviews/incidents, any selected product | `ServiceHealth.Read.All` |
| Message Center, any selected product | `ServiceMessage.Read.All` |
| Exchange beta activity | `ServiceActivity-Exchange.Read.All` |
| Teams beta activity | `ServiceActivity-Teams.Read.All` |

These are tenant-wide read grants. Service filters select relevant data but are
not permission boundaries. Review existing assignments before adding approved
roles. This first-time example grants stable health on the **provider app's
service principal**, not a worker principal:

```sh
PROVIDER_SP=$(az ad sp show --id <providerClientId> --query id -o tsv)
GRAPH_SP=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)
ROLE_ID=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 \
  --query "appRoles[?value=='ServiceHealth.Read.All'].id | [0]" -o tsv)
az rest --method post \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$PROVIDER_SP/appRoleAssignments" \
  --body "{\"principalId\":\"$PROVIDER_SP\",\"resourceId\":\"$GRAPH_SP\",\"appRoleId\":\"$ROLE_ID\"}"
```

Repeat with only the separately approved role values in the table. Configure the
app's **client/application ID** as root `tenants[].providerClientId`, or override
it in a service's `config.execution.providerClientId`.

For each service identity that collects context, add a federated credential on
the provider app, using its **app-registration object ID** in the URL and the
UAMI's **principal/object ID** as `subject`:

```sh
az rest --method post \
  --url "https://graph.microsoft.com/v1.0/applications/<provider-app-object-id>/federatedIdentityCredentials" \
  --body '{"name":"<tenant-service-execution>","issuer":"https://login.microsoftonline.com/<actual-identity-tenant-id>/v2.0","subject":"<service-UAMI-principalId>","audiences":["api://AzureADTokenExchange"]}'
```

The Function obtains a managed-identity assertion for
`api://AzureADTokenExchange/.default`, exchanges it as the provider app and calls
Graph with `https://graph.microsoft.com/.default`. No client secret, uploaded
certificate or developer-login fallback is used. Use the supported
[same-tenant binding](./cross-tenant-access.md); relabeling tenant IDs does not
create a cross-tenant trust.

If a UAMI is recreated, update its federation subject before expecting collection
to recover. Stop the relevant provider schedules before revocation; remove only
owned trusts/roles after reviewing other services that share the provider app.
Azure Health Model report-ingestion and optional annotation roles are separate
from Graph consent; [annotation access is documented below](#notice-update-data-annotations).

## Exact endpoints and units

Stable GETs use `/v1.0/admin/serviceAnnouncement/healthOverviews`, `/issues` and
`/messages` on `https://graph.microsoft.com`. Issues/messages use verified
server-side service filters plus exact local membership checks:

| Product | Stable service selection | Single destination | Approved beta functions |
| --- | --- | --- | ---: |
| Exchange | `Exchange Online` | `exchange-service-health` | 9 |
| Teams | `Microsoft Teams` | `teams-service-health` | 5 |
| OneDrive | `Microsoft OneDrive`, overview ID `OneDriveForBusiness` | `onedrive-service-health` | 0 |
| SharePoint Online | `SharePoint Online`, overview ID `SharePoint` | `sharepoint-service-health` | 0 |

Issue filtering is `service eq '<service>' and (isResolved eq false or
lastModifiedDateTime ge <window-start>)`: all unresolved issues remain visible,
and recent resolution updates can appear in the timeline without inflating the
active count. Messages use `services/any(s:s eq '<service>')`. OneDrive messages
accept exact `Microsoft OneDrive` and documented `OneDrive for Business` membership,
never SharePoint alone. Multi-service messages appear once per relevant product/ID.

Do **not** add `$top` to these collections: live validation showed it can cap
results without a continuation link. Follow default pages to completion and
retain the original service filter in every validated continuation. Five pages
of at most 100 records and 2 MB/page are hard bounds, not a successful partial total.

The parent verified the OneDrive mapping through the existing hosted identity and existing federated provider application. It is distinct from `{id: "SharePoint", service: "SharePoint Online"}`; no SharePoint alias is used. Keep the working **list** overview endpoint: the same authorized identity returned 403 for `/healthOverviews/OneDriveForBusiness`. This implementation makes no individual-ID lookup. Issues use the exact OneDrive service name. Missing tenant subscription/data or denied issue access produces sanitized Unknown diagnostics rather than a new grant, an alias or fabricated Healthy. No OneDrive beta serviceActivity endpoint has been approved or implemented.

SharePoint uses that distinct existing mapping through the
[stable overview list](https://learn.microsoft.com/en-us/graph/api/serviceannouncement-list-healthoverviews?view=graph-rest-1.0),
exact `SharePoint Online` issue filtering and Message Center membership. Missing
overview/subscription/permissions produces Unknown, not a OneDrive alias or
fabricated Healthy. No SharePoint beta serviceActivity endpoint is configured
or called. Provider permissions remain tenant-wide and separately approved;
`Sites.Selected` synthetic access does not authorize them. SharePoint provider
access and collection have not been verified for the newly selected worker;
no new provider permission or federation grant is part of this integration.

All activity endpoints are GETs beneath `https://graph.microsoft.com/beta/reports/serviceActivity/`:

| Service | Function | Contract and interpretation |
| --- | --- | --- |
| Exchange | `getConnectivityMetricsForExchange` | Percentage of successful provider-observed connections; not customer-owned mail flow |
| Exchange | `getMessageVolumeMetricsForEmailDelivery` | Successfully delivered message count (documented within 15 minutes), not a delivery success rate |
| Exchange | `getActiveUserMetricsForOutlookWebByReadEmail` | Active-user successful read count for Outlook web, not all mail clients |
| Exchange | `getActiveUserMetricsForOutlookWebByAppOpening` | Active-user web-app opening count, not an app-opening success rate |
| Exchange | `getActiveUserMetricsForEmailByModernAuthentication` | Active-user modern-authentication count, not individual sign-in events |
| Exchange | `getActiveUserMetricsForDesktopMailByReadEmail` | Active-user successful read count for desktop mail clients, not a read success rate |
| Exchange | `getActiveUserMetricsForOutlookMobileByReadEmail` | Active-user successful read count for Outlook mobile |
| Exchange | `getActiveUserMetricsForOutlookMacByReadEmail` | Active-user successful read count for Outlook for Mac |
| Exchange | `getActiveUserMetricsForiOSOrAndroidMailByReadEmail` | Active-user successful read count for iOS/Android mail apps |
| Teams | `getUsageMetricsForTeamsByMeetingsJoined` | Successful meeting join count; no failure/total denominator |
| Teams | `getUsageMetricsForTeamsByLaunch` | Successful Teams launch count; no failure/total denominator |
| Teams | `getMessageVolumeMetricsForTeamsChat` | Successfully sent/delivered chat count, not synthetic message success |
| Teams | `getAudioStreamQoEMetricsForTeams` | Percentage of audio streams with QoE telemetry; **coverage, not call quality** |
| Teams | `getAudioStreamsOverUdpMetricsForTeams` | UDP percentage; network context, not automatic outage/call quality |

Append exact interval parameters, for example:

```text
getConnectivityMetricsForExchange(inclusiveIntervalStartDateTime=2026-10-26T12:00:00Z,exclusiveIntervalEndDateTime=2026-10-26T12:30:00Z,aggregationIntervalInMinutes=15)
```

Aggregation is 5/10/15/30 minutes; lookback must be an integer multiple, at most 1,440 minutes. Requests end at the current completed UTC aggregation boundary, stay within 30-day Graph retention, and never request future buckets. One-minute polling does **not** make beta source data one minute fresh.

This is the complete Exchange/Teams inventory in the
[Microsoft Graph serviceActivity resource](https://learn.microsoft.com/en-us/graph/api/resources/serviceactivity?view=graph-rest-beta).
Its Microsoft 365 Apps and Entra methods are different products, not OneDrive
signals; they are outside this project's selected service scope.

## Direct reports and unavailable data

Only approved stable categorical mappings are automatic:

| Overview status | Value / health |
| --- | --- |
| `serviceOperational` | 100 / Healthy |
| `serviceDegradation` | 50 / Degraded |
| `serviceInterruption` | 0 / Unhealthy |
| Missing, failed, unrecognized/investigation/recovery states | Unknown, with no numeric value |

Every enabled selected source produces a report on each provider cycle, even
when it has no usable data. Authentication/permission failures, empty results,
invalid or stale observations produce **explicit Unknown with no numeric value**.
This keeps the signal visible and replaces any prior state without fabricating a
zero, a success or a fallback availability score. Failure categories and HTTP
statuses remain in sanitized report context and console diagnostics.
Successfully retrieved supported statuses use the categorical scores above,
not measured availability percentages.

`microsoft-reported-issue-count` intentionally changes from returned historical
issues to **distinct unresolved issues**, regardless of age.
`microsoft-message-center-count` counts **distinct not-ended announcements** for
the product; absent end dates are explicitly treated as not ended. These are
complete current-state counts, not one-minute update counts. Both are
informational Unknown health without thresholds; announcement severity is not
an outage score. Zero requires a complete successful collection. Failed,
incomplete, missing or stale snapshots have no numeric value.

Application access has no signed-in user's read/archive viewpoint: these are
not "unread notifications." History remains in Microsoft 365; no archive or
outbound notification system is added.

Every enabled selected function produces `microsoft-activity-<function>` on **`${service}-service-health`**, alongside the selected stable status/count reports, whether data is available or not. Signal names remain distinct and unchanged. With more than one tenant in the config each is published as `tenant-<tenant id>--<name>`, one set per tenant on the shared entity; with one tenant the names stay plain. Without a threshold an activity signal reports a fresh numeric measurement with **Unknown**, no evaluation rules, and `evaluated: false` context: display is not an evaluated success. Explicit `serviceActivity.thresholds.<function>` enables `LessThan` customer `degradedBelow` / `unhealthyBelow`, ordered unhealthy ≤ degraded; percentage thresholds cannot exceed 100. Counts require explicit thresholds before producing evaluated health. No count is divided into an invented availability percentage; no raw activity metric changes a synthetic score. A disabled or unselected function receives no new reports; OneDrive has stable health/messages only.

## Notice-update Data annotations

The existing provider reporting stage adds **one Data annotation per new or updated
notice** on `${service}-service-health`. Quiet polls create nothing: there are no
"No newly observed changes" entries or source-unavailability placeholders. Counts
and status still refresh every minute, including explicit failed-source diagnostics.
No new process, container, entity or per-message signal is created.

Each annotation's Details contains only `title`, using the actual notice title.
Description is pretty-printed JSON with the tenant/product, source, ID, latest
update excerpt, status or message category/severity, truncation flag and source URL.
`lastUpdatedAt` is Microsoft's source-update time, not the annotation's own timestamp.
The snapshot timestamp is not repeated; Azure Monitor Health Models supplies the
annotation timestamp. Full counts and publication diagnostics remain in signals.

Only source notices whose `lastModifiedDateTime` falls within the preceding
90 seconds appear as recent changes. Keep `providerIntervalSeconds: 60`; longer
cadences leave gaps. Older ongoing incidents still contribute to the full active
count. Latest issue excerpts are selected by post timestamp, not array order.
Message notices prioritize action-required items, major changes, then recent
updates; ended notices are excluded and missing end dates are retained.

Recent annotation history suppresses already-displayed source/ID/update-time
versions, including retries in the same minute. History reads both the new JSON
format and the previous snapshot version markers during migration; existing old
annotations are not removed. Each feed publishes at most three unseen versions
per cycle, with a conservative **4096 UTF-8-byte budget per JSON description**.
Excerpts are shortened without breaking JSON or dropping IDs/links. The count
signals disclose omitted notices and references to confirmed published annotations.
Source URLs require Graph authorization; clickable portal rendering is not promised.

`annotation.state` distinguishes `no-new-changes` from `source-unavailable`.
Read/write failure is logged and retained in count-signal diagnostics without
suppressing healthy sibling reports. If a later append fails, diagnostics retain
the references already confirmed; no further writes are attempted that cycle.
Reads are paginated and bounded; incomplete history does not authorize an unchecked
append. Writes are not automatically retried after ambiguous failures.
Workers remain stateless: downtime leaves gaps, no missed minutes are backfilled,
and concurrent revisions cannot provide an exactly-once guarantee.

The [CloudHealth API contract](https://github.com/Azure/azure-rest-api-specs/blob/main/specification/cloudhealth/resource-manager/Microsoft.CloudHealth/CloudHealth/main.tsp#L1601-L1630)
allows at most ten annotation detail fields, each value at most 256 characters,
and a 4096-character description. Retention and deletion have not been established.
The existing worker identity needs these additional Azure actions, scoped only to
its Service Health entity, **separately approved before deployment**:

```text
Microsoft.CloudHealth/healthmodels/entities/read
Microsoft.CloudHealth/healthmodels/entities/getDataAnnotations/action
Microsoft.CloudHealth/healthmodels/entities/addDataAnnotation/action
```

Live ARM authorization also requires entity read for annotation history; the two
annotation action names alone are insufficient. The template uses a separate
entity-scoped role, without entity-write permission; ingest-only report permissions
and the read-only Graph provider app are not broadened.

The signals are plain external signals on the one supporting entity: no aggregation group, child-entity graph or writable external-signal declaration is created for them. Per-signal health and source diagnostics remain authoritative for missing data. `additionalContext.source` and `apiVersion` distinguish each stable endpoint/beta function on the shared entity; the supporting entity remains suppressed.
ARM can return external signal names in lowercase. Compare those names
case-insensitively; `additionalContext.source` retains the exact Graph function name.

Units accompany **every direct report** in `additionalContext.unit`: `Percent`, `Count`, or overview `status-score` (categorical 0/50/100, not a percentage). Both numeric diagnostic measurements and missing-data Unknown reports retain unit context. **Native external-report unit labels are not supported by the ingestion API**; no unsupported `dataUnit` is sent and read-only external signal definitions are not written. See [model Service Health context](../health-model/README.md#service-health-context). All old worker revisions must be inactive before final child/relationship pruning.

Select the **latest complete bucket**, not an average/sum of overlapping history. Missing/invalid/duplicate/future/out-of-window data, failed source collection, or bucket age exceeding `maxAgeMinutes` produces **Unknown without a value** on that cycle. Failure categories and HTTP statuses, such as 403, remain console diagnostics and report context. The default maximum age is 60 minutes and is configurable independently of cadence. QoE/UDP interpretations remain explicit in report context even with customer thresholds. No missing-data report changes synthetic attempt success or Experience rollup.

Each source has a 30-second cancellation budget, five exact-origin/version/path pages and a 2 MB/page cap; malformed/partial snapshots fail the source. A rejected source does not kill siblings. Provider lane slots never overlap and missed slots are logged. Simulation emits skipped source diagnostics, never provider status. Console diagnostics always accompany direct provider reporting in either Log Analytics mode.

Report TTL must exceed both selected synthetic lane cadence and provider cadence plus bounded publication budgets. Expiry is not guaranteed Unhealthy or an alert: independently verify worker/report freshness and end-to-end notifications.

References: [Service Health](https://learn.microsoft.com/graph/api/resources/servicehealth?view=graph-rest-1.0), [count contract](https://learn.microsoft.com/graph/api/resources/serviceactivityvaluemetric?view=graph-rest-beta), [percentage contract](https://learn.microsoft.com/graph/api/resources/serviceactivityperformancemetric?view=graph-rest-beta), [operations acceptance](./operations.md#enterprise-reliability-acceptance-gate).
