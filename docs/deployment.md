# Deploy the health models, then the workers

## Deployment status and order

The current scope comes from the root profile and
[shared catalogue](../synthetic-tests/utils/src/catalog.ts), not the historical
deployment counts below. There are no planned journey branches. SharePoint's
health model and root reference are deleted, and its old worker has no active revision.

The dated deployment evidence below predates the independent attachment/reply
split; source changes alone do not update the running workers or live model.

The cleanup removes unsupported Teams receipt/P2P/card prototypes and unused
file-sharing/search prototypes rather than publishing hardcoded capability
failures. A source change, a successful deployment, and a successful live journey
are different acceptance gates.

Verified live deployment, 2026-10-26:

- ACR build `cja` produced immutable image
  `sha256:f96ca82926b39991b7b54b9591a7d79699e79f17620ff339d52b186a90ad4c84`.
  Exchange and Teams ready revisions are `0000015`; OneDrive is `0000002`.
  Only these new revisions are active on the selected workers.
- Integrated validation passed: 1,104 tests, TypeScript, build, 20 model contracts
  and 14 worker-infrastructure contracts.
- Stable and approved beta reports now ingest on each product's single,
  suppressed Service Health entity: seven signals each for Exchange and Teams,
  two for OneDrive. External Reports groups have no unresolved members.
  The 14 old per-API child entities and relationships were removed after the
  matching new workers published to their parent entities.
- Exact ARM inventory matches deployment outputs: root 4 entities/3
  relationships, Exchange 33/32, Teams 14/13, OneDrive 17/16; total **68/64**.
  A second provider cycle confirmed fresh parent reports and no recreation of
  retired entities.
- All six Exchange journeys completed real successful attempts on the new image.
  The second cycle ingested 100% success for all six; the meeting journey can
  still be Degraded when its measured duration exceeds the configured latency
  threshold. Its earlier cancellation-cleanup failure is fixed.
- OneDrive app-folder operations succeed. Selected-folder roundtrip and versions
  remain Unhealthy because dedicated folder IDs/resource grants are missing.
  Administrator reads of both configured test-folder paths returned 403; no IDs
  or successful operations were invented.
- Both scheduled-meeting join POSTs now succeed. Call-state verification/cleanup
  readback and channel publication readback still report real read failures;
  these live acceptance issues remain under investigation. The earlier
  primary-token permission error is not the current observed failure.
- OneDrive's approved managed-identity federation to the existing read-only
  collector is verified. Its actual `OneDriveForBusiness` / `Microsoft OneDrive`
  stable feed reports Healthy/100 on the grouped entity. Exchange and Teams
  stable feeds genuinely report Degraded/50; their denied beta calls remain
  diagnostic Unknown. OneDrive has no beta collector.
- One Exchange report acknowledgement timed out, although ARM confirms that
  exact report persisted. The failure remains logged; successful ingestion does
  not retroactively prove receipt of the acknowledgement.

Teams follow-up, 2026-10-26:

- Builds `cjb` and `cjc` contain the bounded messaging-poll fix, provisional
  call-chain handling, and compatibility with Graph's actual `playPrompt`
  response (`@odata.context`, PascalCase status and nullable diagnostics).
- Revision `0000017` is deployed with
  `sha256:33774473931abbe3a57f0fac1d9972c81ba8208f999558455f28a2d5e59075c5`.
  Exchange and OneDrive remain on the initial grouped-rollout image.
  All 1,122 tests, TypeScript and build pass.
- A real revision-16 attempt passed joining, establishment, meeting metadata,
  both rosters and both departures, exposing the playback response-format bug.
  The response-format fix does not weaken authenticated callback correlation.
- The latest observed meeting report is still Unhealthy with a permission
  failure. Full playback and complete live journey acceptance are not confirmed.
  Diagnostic calls were explicitly deleted and termination verified.

Source update, 2026-10-27 (**not deployed**): scheduled meetings now verify both
bots' establishment, meeting metadata, both rosters and both departures without
uploading or playing audio. The audio step, endpoint and playback reports are
removed from the desired model/runtime. Private calling profiles and the existing
audio child require the [ordered migration](../health-model/README.md#retiring-teams-audio-testing);
the live revision and its last observed failure above are unchanged. Optional
post-call quality collection remains disabled by default; see
[quality options and latency limits](../synthetic-tests/teams/README.md#meeting-and-audio-quality-options).
The opt-in hosted-audio feasibility command is also source-only: it plays one
synthetic clip, verifies departure, then waits separately for exact-ID call
records. Only returned quality measurements can be published to `teams-call`;
no audio entity or unselected quality members are added. Live playback,
populated bot audio telemetry and ingestion still require an approved hosted run.

Exchange hierarchy deployed, 2026-10-27: deployment
`exchange-mail-calendar-20261027` updated only `m365-experience-consto-exchange`
in `rg-m365-consto`, using the approved `monitoring.consto.json` profile.
Four mail journeys now roll up through **Mail** and two calendar journeys
through **Calendar**, both with native UserFlow icons. The six old direct
root-to-journey links were removed after their replacements were verified.
Journey/step IDs, workers, other service models, root references and permissions
were unchanged.

Paginated live inventory is **35 entities/34 relationships**, including the
existing suppressed Service Health branch retained unchanged by this scoped
rollout. All six journey External Reports groups resolve. Fresh mail reports
at **14:19:49 UTC** show 100% success after deployment. At verification, native
rollup was **Mail Degraded** (attachment journey mean duration 15,556 ms, above
the 15,000 ms threshold) and **Calendar Healthy**.

Do not treat partial live acceptance as proof that every journey or the
independent worker/report-freshness/notification safeguards are green.

OneDrive setup completed, 2026-10-27: both configured test accounts now have
dedicated test folders and verified Selected-folder write grants. Their real
folder bindings are persisted in the approved private root profile and deployed
OneDrive configuration. Only that worker's configuration was updated and its
existing `sh-omit-d09c316d` revision restarted; its image, service configuration,
single-replica settings and unrelated workers were unchanged.

Fresh reports at **14:54:16-14:54:18 UTC** confirm **100% success (2/2 accounts)**
for user-drive roundtrip, app-folder lifecycle and document versions. All three
journeys, all 11 required business steps and **OneDrive Experience are Healthy**.
The disabled optional restore step remains suppressed. Temporary tenant-wide
provisioning grants, applications/service principals and certificate files were
removed. Worker Graph roles remain `Files.ReadWrite.AppFolder` and
`Files.SelectedOperations.Selected`, without tenant-wide file access. See
[programmatic OneDrive setup](onedrive-setup.md) for bulk provisioning and reruns.

Stable Service Health enabled across all three products, 2026-10-27:
the canonical private root explicitly enables provider context, all three
service-level flags are enabled, and Teams' missing suppressed Service Health
entity/relationship is restored. Five unavailable beta members were removed
from Exchange's External Reports group; existing beta collection selections
were not changed. All business entities, worker images and managed identities
were preserved. Existing read-only permission and federation trusts were
verified; no permissions, credentials or trusts were added.

At **15:25 UTC**, fresh accepted v1.0 overview/issues reports confirm working
collection for every product, with no unresolved group members. **OneDrive is
Healthy/100; Exchange and Teams are Degraded/50**, reflecting Microsoft's actual
`serviceDegradation` statuses, not collection failures. These states were not
overridden to manufacture green. OneDrive's three synthetic journeys still
report 100% success for both accounts.

The existing Exchange/OneDrive images predate the project-root Service Health
field: their deployed copies retain the working `serviceHealth: true` service
setting without the unsupported root field. Adding it caused startup validation
failures, which were corrected before fresh reports were verified. The canonical
profile and newer Teams worker use explicit root enablement. Use a matching new
worker image before applying that root field to the legacy workers.

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
  of both owned call legs. Meeting connectivity does not prove received audio
  or bidirectional media quality.
- **Optional call records:** explicitly approved tenant-wide
  `CallRecords.Read.All` on the primary caller only. Collection requests only
  known call IDs, which is an application safeguard, not permission scoping.
  Delayed, absent or denied quality measurements remain diagnostics and do not
  create placeholder entity reports. The one-shot audio test has a separate
  bounded readback window; it does not hold a meeting open for record generation.
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

## Teams live verification — 2026-10-27

Only the Teams model and worker were deployed from the approved
`monitoring.consto.json` / `teams.consto.bot.live.json` profiles. ACR build `cjh`
produced immutable image
`sha256:763ebdcaf5b3fc5338850818a0a9cb47708cf624225069e95f185a213b845ac1`,
deployed as revision `m365-ctbcoa-teams--0000018`, config revision `rotd6sga77wp2`.
It is the sole active normal revision; identities, mounts, probes and routing
were preserved. OTEL and root-default Service Health remain disabled.

Real meetings ended at **14:49:54.562** and **14:51:55.130 UTC** after both
bots joined, established, verified metadata/both rosters, reconfirmed established
state and independently departed. ARM readback confirms all five steps at 100%,
with actual durations and matching cycle IDs. Channel journeys also succeeded.
Exact Teams inventory is **12 entities/11 relationships** after retiring only
its audio and disabled Service Health branches; six call External Reports
members remain. At **15:02:33 UTC**, old playback/placeholder reports had expired
naturally and every Teams entity, including both native journey rollups and the
Teams Experience, was Healthy. No external signal definitions were rewritten.

Reporting is **not fully green**: the 14:48–14:52 UTC window contained 11 cancelled
acknowledgements across three cycles. Three exact reports subsequently persisted;
earlier overwritten statuses cannot establish receipt. The existing five-second
request deadline remains unchanged. Container Apps exec returned
`ErrorGeneratingAuthToken`; credential-free ACR run `cjj` verified the exact
image's CLI `--help` instead. Local Docker was unavailable.

The existing primary-bot `CallRecords.Read.All` grant was verified and retained;
no grants were added. Same-cycle quality remained pending without invented
measurements. **The live audio pilot and audio-quality ingestion are NOT YET
verified.**

### Isolated audio pilot preparation — 2026-10-27, 15:24 UTC

ACR build `cjk` derived the temporary harness from the exact normal image above,
producing
`sha256:0c18252234a9cde91445a55948b786d7bba374d25df86aa81f778d328639af2f`.
All seven offline lifecycle/WAV tests passed against that immutable image in
credential-free ACR run `cjm`.

**The live pilot was not started.** Before any pilot app mutation, preflight
detected an unexpected concurrent Teams app write at 15:19:13 UTC and restart
at 15:19:33 UTC. App template/routing metadata still matched the saved normal
snapshot, but mounted-secret equality could not be assumed. The previously
retired Teams Service Health entity/relationship also reappeared: observed
inventory was **13 entities/12 relationships**, not the approved 12/11 baseline.
These external changes were not reverted by the pilot.

No pilot revision, public WAV endpoint or control secret was created; no pilot
call-record request, permission grant, audio/quality publication or model change
occurred. Therefore no pilot restoration was necessary. Revision `0000018`
remained the sole active revision in Single mode with 100% normal traffic and
its public readiness endpoint responding. Fresh normal meetings ended at
15:21:53.583 and 15:23:53.839 UTC with all five steps and both departures verified.
Live playback and received audio remain unverified. Resume only after reconciling
the external writer and refreshing the canonical mounted restoration snapshot.
