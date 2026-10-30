# Service communications and readability delivery roadmap

Date: 2026-10-30. Target: complete the work today, in independently reviewable
checkpoints, without mixing the new feature with the subsequent refactor.

## Delivery order and approvals

1. Implement service communications first: active incidents/advisories **and**
   Message Center announcements on the existing Service Health supporting entities.
2. Checkpoint the working feature before making general structural changes.
3. Validate the communications feature before starting the coding refactor.
   Then refactor incrementally for human readability and testability.
4. Finish with integration evidence and an explicit account of anything unverified.

Baseline: `f0a85cc` on `main`. Delivery branch:
`service-communications-refactor`. The worktree was clean at branch creation.

Delivery status: communications revision `5214c49` was deployed and live-accepted
with the presentation limitation below. All four refactor milestones are complete
locally. No refactor rollout or push has been performed.

Read-only Graph/Azure discovery and validated **local checkpoint commits** are
approved. The user separately approved the `ServiceMessage.Read.All` grant to the
existing provider application, one value-less context-ingestion preflight report,
and one clearly labelled Exchange data-annotation preflight. The user subsequently
approved the standard deployment, its existing live journeys, minute annotation
publication and three entity-scoped annotation assignments. The separately approved
entity-read addition has also been applied to that role, without redeploying workers.
The user then replaced quiet minute snapshots with per-notice JSON annotations
and approved one standard rollout of that validated change, explicitly without a
format-preview publication. Generic entity write, broader assignments, new Graph
grants, additional previews, pushing and history rewriting are not approved.

The handoff is the supplied `README-m365-service-communications.md`. It is a
design input, not evidence that the feature or its permissions already work.

## Milestones

The blocks below are the execution order, not guaranteed finish times. Discovery
and external approval can change the critical path. Keep independent read-only
research and bounded checks concurrent; never have parallel tasks edit the same
files.

| ID | Milestone | Depends on | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| C0 | Establish roadmap and rollback baseline | None | Scope, approvals, checkpoints and blockers recorded | Done: `61d673a` |
| C1 | Verify communications contracts | None | v1.0 filters/continuations, actual product labels, relevance semantics, report size and useful portal presentation established or explicitly blocked | Verified, including readable annotation preflight and issue timestamp filters |
| C2 | Add service-scoped collectors and models | C1 contract decisions | Complete bounded snapshots, distinct IDs, isolated source failures, explicit Unknown; no unrelated service feed | Implemented and locally verified |
| C3 | Integrate summaries, signals and configuration | C2 | Existing suppressed entities show bounded data annotations and informational count/status signals; default-off per-service Message Center opt-in; disabled and messages-only gates work | Notice-only JSON revision deployed from `5214c49` |
| C4 | Validate and checkpoint communications | C3 | Existing local checks pass; count scope, permissions, limits and remaining live gates documented | Initial feature `1410917`; entity-read fix `bd0f751`; notice-only JSON `5214c49` |
| V2 | Complete authorized live acceptance | C4 and separate approvals | Real scoped feeds, fresh ingested summaries, useful presentation and unchanged rollup verified; remaining reliability limits stated | Accepted by user: live quiet/count/topology plus local formatting evidence; no natural update observed |
| R1 | Strengthen resolved execution models | C4 and V2 | Journey-specific probe/dependency types replace invalid optional-field combinations without changing user config or result contracts | Complete: `588dca7`, validated live inputs, typed handlers and structural client ports |
| R2 | Clarify reporting and ingestion boundaries | R1 | Shared pure measurement interpretation; transport-specific aggregation preserved; ingestion processing imports without constructing Azure clients | Complete: `fd4cf48`, pure measurement mapping and injected ingestion sinks |
| R3 | Simplify worker and journey lifecycles | R2 | Named orchestration and workflow functions; controllable time/deadline seams; existing scheduling, cancellation, cleanup and request bounds preserved | Complete: `0fd1ffd`, scoped lane execution, injectable deadlines and owned-resource models |
| R4 | Organize shared modules | R3 | Responsibility-based folders with imports, packaging, commands and source fingerprints kept consistent | Complete: `95b3f78`, six focused folders, imports and deployment entry updated |
| V1 | Complete local integration verification | R4 | Final checks, focused behavior comparisons, reviewed diff and local checkpoint history | Complete: integrated local evidence and reversible checkpoint history; no new rollout |

### Communications first

- Use Microsoft Graph v1.0 `serviceAnnouncement/issues` and
  `serviceAnnouncement/messages`, not the retired Service Communications API.
- Keep the working overview list endpoint and OneDrive overview-ID selection.
  Verify issue/message service labels separately; SharePoint is not OneDrive.
- Prefer verified server-side service filters and retain exact local matching.
  General OData documentation alone does not establish support for a particular
  property filter. Never call a partial tenant-wide page set a complete snapshot.
- Include unresolved incidents regardless of age. Exclude ended announcements
  using verified date semantics, explicitly handle absent end dates, and prioritize
  action deadlines, major changes and recent updates.
- Count distinct IDs, not posts or polls. Document the intentional change from
  historical issue count to active-issue count.
- Put plain-text, bounded summaries in **Data annotations on the existing Service
  Health entities**, as selected by the user. Keep counts/status as signals and
  signal `additionalContext` for diagnostic metadata, not the primary readable
  announcement presentation. Include source IDs/links, relevant dates,
  statuses/categories and latest-update excerpts. Sort posts by timestamp.
  Distinguish total matching items, displayed items and omitted/truncated content.
- The annotation API adds records rather than updating a named current record.
  The user's revised contract is one annotation per new/updated source notice,
  with pretty JSON Description and title-only Details. Do not post quiet or
  unavailable placeholders or repeat the annotation's timestamp in its body.
  Use the overlapping 90-second source window; active count/status signals still
  refresh every minute. Suppress already-recorded versions and retain explicit
  publication/failure/omission diagnostics. Do not add a durable cursor/outbox.
  Retention and deletion have not been established; old annotations remain.
- Reuse the existing worker, Container App and provider lane. Change the configured
  provider cadence from 300 to 60 seconds; synthetic schedules are unchanged.
  Approved beta sources share that lane and are consequently polled more often.
  No new annotation means no unseen change or unavailable collection; signal
  diagnostics distinguish those cases rather than fabricating a quiet success.
  Worker downtime leaves gaps; there is no retrospective backfill or exactly-once
  guarantee across concurrently running revisions.
- Preserve existing status and beta signals. Reuse
  `microsoft-reported-issue-count`; add one informational Message Center count.
  Counts remain Unknown health without outage thresholds.
- Keep one root configuration, the root `serviceHealth.enabled` gate, the existing
  provider lane/cadence and the read-only federated provider application.
  Add default-off `serviceMessages` per service; messages-only selection must work.
- Zero requires a complete successful snapshot. Denied, malformed, stale,
  oversized, cancelled or incomplete collection must publish Unknown without a
  fabricated value. A failed source must not suppress siblings or synthetics.
- Do not add message entities, permanent per-message signals, workers, models,
  aggregation groups, durable cursors, an archive or outbound notification machinery.

### Refactor after live feature acceptance

- Extend the existing strict TypeScript/Zod approach rather than adding a framework.
  Derive types from schemas; keep authored, provisioned and live-execution stages
  distinct.
- Start with one Exchange journey, then apply the resolved model consistently to
  the remaining journeys. Use required, narrow live client interfaces instead of
  repeated optional checks and non-null assertions.
- Keep environment parsing and client construction at boundaries. Give internal
  execution plans clear domain names rather than environment-variable names.
- Share journey/step/call-phase measurement interpretation between direct reports
  and observations. Do not equate settled-cycle aggregation with rolling KQL.
- Separate event parsing/transformation from Function registration and Azure clients.
- Make worker lifecycle, initialization failures, provider execution and publication
  understandable independently. Complete existing clock/sleep injection, including
  deadline timers, without confusing wall-clock timestamps with elapsed time.
- Give Teams call legs named lifecycle operations and split OneDrive workflows into
  focused journey functions. Avoid a generic workflow engine or class hierarchy.
- Reorganize folders last. Keep the Node project under `synthetic-tests/` and model
  infrastructure under `health-model/`; update all directly dependent packaging.

## Validation and definition of done

Use the existing `synthetic-tests` commands: `npm run typecheck`, `npm run build`
and `npm run deploy -- --plan`. Build/lint affected Bicep when infrastructure
changes. Do not add unit-test suites or test tooling; use focused temporary
behavior comparisons where useful, without committing fixtures or tenant data.

Preserve single-minute Exchange alignment, global/per-mailbox actual request
permits, all-target execution, timeout-as-failure, bounded cleanup/publication,
stateless workers, skipped-action semantics, existing signal IDs and both logging
modes. Provider context remains suppressed and cannot affect synthetic scores or
Experience rollup.

The approvals above cover the initial live acceptance only. Any further grants,
scope broadening or rollouts need separate approval. Filtering is not permission
scoping: provider Graph grants are tenant-wide. Do not broaden synthetic identities.

Check disabled/root-off/messages-only cases, multi-service membership, old active
incidents, duplicate IDs, pagination exhaustion, stale data and denied access.
Check actual ingestion and portal usefulness, not just HTTP success. Do not mark
live acceptance complete based on build, deployment or readiness alone.

## Commit and rollback discipline

Use small local commits with explicit intent:

1. `docs: record service communications and refactor roadmap`
2. `feat: add service-scoped communications collection`
3. `feat: surface bounded service communications summaries`
4. `refactor: strengthen resolved journey contracts`
5. `refactor: share measurement and isolate ingestion processing`
6. `refactor: clarify worker and journey lifecycles`
7. `refactor: organize shared monitoring modules`
8. `docs: record delivery verification and remaining gates`

Keep each checkpoint buildable; foundational feature commits stay inactive until
wired behind the opt-in. Combine tightly dependent pieces when separating them
would leave a misleading or broken intermediate state.

Rollback uses new `git revert` commits, normally in reverse dependency order;
never reset shared history. A source revert does not roll back cloud resources,
restore a previous container revision or revoke a grant. Plan and approve those
actions separately. No push is authorized.

## PM update format

At meaningful checkpoints report: **done**, **next**, **blocked**, and any
**decision needed**. Record actual commit hashes and verification evidence here
as work lands. Keep completed work, locally verified work and live-accepted work
distinct; do not silently reduce the feature to counts if summary presentation
does not meet the acceptance gate.

## Current evidence and blockers

- Roadmap checkpoint: `61d673a`; feature checkpoint: `1410917`; baseline `f0a85cc`.
  Existing `typecheck`, `build`
  and `deploy -- --plan` passed before implementation; the plan reported no cloud
  changes. That checkpoint implemented communications only, before the coding
  refactor began.
- Final feature sources pass `typecheck`, `build` and `deploy -- --plan`
  (`cloudChanges: false`, three existing workers and four existing models).
  The affected worker Bicep compiles and lints successfully.
- Eight temporary no-cloud behavior groups passed: scoped complete collection and
  distinct active counts; exact OneDrive aliases and text conversion; invalid
  continuation/budget failures; minute snapshots and version suppression; Unicode
  size/omission disclosure and stale values; source permission isolation; annotation
  failure/no ambiguous write retry; and messages-only/root-off routing.
- Live reads through the existing federated provider application verified issue
  `service`/`isResolved` filters, message `services/any` filters, negative controls
  and default pagination. Exchange had 41 historical issues versus one active
  issue; Teams returned 129 distinct messages across two pages.
- Actual OneDrive issue/message membership is `Microsoft OneDrive` in this
  tenant. The message filter also accepts the documented exact alias
  `OneDrive for Business`; SharePoint membership alone is not sufficient.
- Fresh hosted Message Center reads returned 51 Exchange, 129 Teams and 18
  OneDrive records. All supplied the required identity, membership, title, body,
  category, severity, major-change and last-modified fields; body formats and
  timestamps were valid. These are returned-record totals, not active counts.
- `$top=2` silently capped Exchange issues without a continuation despite more
  matching records. Collection must omit `$top`, follow validated continuations,
  retain the service filter and fail explicitly on any collection budget limit.
- The approved Message Center permission grant was applied only to the existing
  read-only provider application. Federated message reads then succeeded; no
  synthetic identity or other Graph grant was changed.
- A value-less Unknown report on `microsoft-message-center-count` accepted and
  returned 4096 ASCII characters of labelled preflight context. It did not contain
  real announcements, alter issue count, or establish useful portal presentation.
- The user selected entity Data annotations instead of signal context for readable
  communications. The canonical CloudHealth API defines `addDataAnnotation` and
  `getDataAnnotations`, at most 10 detail fields with 256-character values, and an
  optional 4096-character description. It also bounds report `additionalContext`
  at 4096 characters; these limits do not imply rich HTML or clickable rendering.
- The separately approved Exchange annotation preflight was created at
  `2026-10-30T14:10:46Z`, ID `234aa5a5-d738-4e7d-abad-a3321ed79343`, with title
  `PREFLIGHT: Service communications display check`. It is explicitly not a real
  service notice. Query readback succeeded and the user confirmed it is readable.
- Existing-provider live controls verified the combined issue predicate
  `service eq 'Exchange Online' and (isResolved eq false or lastModifiedDateTime ge ...)`:
  the historical positive cutoff returned 41 records, a future cutoff returned the
  one unresolved issue, and all results were complete and service-scoped.
- Azure's operations inventory advertises the annotation actions
  `Microsoft.CloudHealth/healthmodels/entities/addDataAnnotation/action` and
  `Microsoft.CloudHealth/healthmodels/entities/getDataAnnotations/action`.
  The approved deployment applied one assignment per existing worker at its exact
  Service Health entity, without broadening the ingest-only role.
- Standard deployment `20261030T150234969Z-cb0f6b74` succeeded from `1410917`.
  All three existing applications use image digest
  `9a14dfab47a778380cfd0ea1f55cc6d2999d9578c2933f9b16d9695dcf3a7cf6`;
  identity sets and root relationships are unchanged. The Exchange observation
  check found 40 records for 20 journey/target pairs, including one real failure;
  successful delivery does not mean every synthetic journey was healthy.
- Independent deployed collectors at `2026-10-30T15:17:23Z` matched native active
  issue/message signals: Exchange `1/51`, Teams `0/129`, OneDrive `1/18`.
  All three supporting entities remained suppressed. No recent source updates
  were observed; new/update rendering has mocked coverage, not a forced live notice.
- Native annotation history reads returned HTTP 403 under the actual worker
  credential, explicitly requiring
  `Microsoft.CloudHealth/healthModels/entities/read`. Both preview API versions
  behaved identically. The separately approved entity-read action was added to the
  same role at `2026-10-30T15:31:58Z`; Bicep build/lint passed, and the same three
  direct entity-scoped assignments were verified unchanged. No worker restart,
  generic entity-write permission or additional Graph grant was applied.
- As of the worker-identity read at approximately `15:37Z`, ARM still rejected
  entity read. Recent native annotation history was empty and count diagnostics
  explicitly recorded annotation permission failure. The role definition update
  is not proof of effective authorization. Append authorization remains unverified;
  malformed requests returning HTTP 400 did not establish it.
- Authorization subsequently became effective without a worker restart or broader
  grant. The first real Exchange annotation was confirmed at `15:49Z`; native
  worker-credential reads with both supported ARM token audiences succeeded.
  The initial live helper encountered server timestamp normalization (seven
  fractional digits versus three), not different instants; its literal timestamp
  assertion did not establish complete acceptance.
- The user rejected the quiet entries and old presentation. The replacement emits
  only new/updated notices, one title-only annotation each, with pretty JSON and no
  duplicate snapshot timestamp. The entire rejected quiet placeholder is absent
  from the publisher; an empty selection returns before any annotation append.
  No preview publication is approved.
- Revised sources pass `typecheck`, `build`, the local no-cloud deployment plan
  and nine temporary behavior groups, including quiet suppression, per-notice
  JSON, legacy/tenant-isolated version history, valid Unicode truncation and
  partial-append recovery without duplicate notices. The final RBAC audit confirms
  exactly the three approved actions and unchanged direct entity assignments.
- Revised checkpoint `5214c49` was deployed by standard run
  `20261030T161657796Z-d4d76395`, completed at `2026-10-30T16:29:57Z`.
  All three existing workers run image digest
  `e48377ad9d0ccbbb6bf286642f68f1aff7e25fc5fd8648e2614ba044489fa6e5`.
  Independent readback verified the source revision, ready revisions, unchanged
  worker identity sets and unchanged root relationships.
- Fresh hosted source controls at `2026-10-30T16:30:47Z` returned active
  issue/message counts of Exchange `1/51`, Teams `0/129` and OneDrive `1/18`,
  with no recent updates. Native acceptance observed two aligned post-rollout
  cycles for every service, matching those full counts and adding **zero Data
  annotations** after the rollout cutoff. Quiet cycles no longer append the
  rejected placeholder; previously stored annotations remain.
- All three Service Health entities remain suppressed, service relationships
  are unchanged, and overview and approved beta signals retain fresh reporting
  (nine Exchange and five Teams beta signals). Fresh reports do not establish
  that every beta source is available or every synthetic journey is healthy.
  Deployment ingestion checks observed 77 Exchange records for 20 journey/target
  pairs, including seven failed attempts; Teams had 24 records for six pairs and
  OneDrive had 12 for six, with no failed attempts in those checks.
- New-notice JSON/title-only formatting, version suppression and failure handling
  have local behavioral evidence, but no natural Microsoft update occurred during
  live acceptance. No sample or preview was posted. The remaining presentation
  gate was explicitly accepted by the user using the local formatting evidence
  alongside live quiet/count/topology evidence. No live new-notice rendering is
  claimed; this decision permits the broader coding refactor to start.
- R1 introduces schema-derived live journey inputs and mode-discriminated runtime
  configuration without changing authored probe fields. Runtime filtering preserves
  the live/simulation distinction; handler maps now check journey/input alignment.
  Structural Graph/Bot operation interfaces remove concrete-client coupling from
  journey helpers. Existing fixture ownership checks, request permits, deadlines,
  schedules, provider sources and report contracts remain in place.
- R1 passes the existing `typecheck`, `build` and no-cloud deployment plan.
  Temporary comparisons against compiled baseline `5214c49` passed 81
  configuration cases, 100 simulations, 31 live-handler output/request-trace
  cases and all five Exchange execution-deadline cases. A 100-mailbox inventory
  retains all 500 journey attempts. Compile-time checks reject unresolved inputs
  and wrong-journey handlers while accepting structural client fakes. All nine
  communications behavior groups still pass, including zero quiet annotations.
  No refactor rollout or new cloud mutation is authorized or performed.
- R2 shares one pure journey/step/call-phase measurement mapper between direct
  reports and observations. Direct settled-cycle aggregation stays separate from
  rolling KQL; signal names, skipped-step semantics and event-ID inputs are
  unchanged. Ingestion processing now takes upload/quarantine sinks; environment
  validation, Azure clients and Event Hub registration remain in the adapter.
- R2 passes `typecheck`, `build` and the no-cloud deployment plan. Against frozen
  baseline `5214c49`, 36 reporting cases preserve both outputs exactly, including
  multi-tenant/group signals, minimum samples, binary observations and call-phase
  ordering. Twelve ingestion cases preserve object/string/Buffer handling, byte
  limits, retry exhaustion, quarantine hashes/logs and failure propagation.
  The processor imports with an empty environment; validation made no network
  requests. Function packaging recursively includes all emitted modules.
- R3 isolates synthetic lane execution from worker startup/provider orchestration.
  An injectable clock separates wall timestamps, monotonic completion budgets,
  cancellable timers and deadline signals; sleep reaches journey polling.
  OneDrive has named roundtrip, app-folder and version workflows, with required
  folder/file IDs after successful creation. Teams retains only owned call legs
  with required clients/IDs, including teardown after a failed peer join.
- R3 passes `typecheck`, `build`, the no-cloud plan and all previous baseline and
  communications comparisons. Eight virtual-time groups verify all-target timeout
  failures, independent bounded cleanup, hung-handler grace, publication bounds,
  aligned minutes without catch-up, shared initialization/lane scope, provider
  isolation from initialization failures, and explicit shutdown errors.
- R4 moves 46 shared modules into configuration, execution, integrations,
  reporting, providers and deployment folders using TypeScript's rename tooling.
  Contracts, catalogue/projection and repository-path anchors remain at the
  shared root. The npm deployment entry and source links use the new locations.
- R4 verification finds all 75 TypeScript bodies unchanged except relative
  import paths, and checks all 320 relative imports against the intended moves.
  Emitted dependency closures resolve for every worker and the ingestion entry.
  Existing recursive Docker copies, Function `dist` packaging, TypeScript includes
  and source fingerprint coverage include the nested modules without new lists.
  The relocated fingerprint function resolves the correct repository root.
- Final organized sources pass `typecheck`, `build`, the no-cloud deployment plan
  and negative type contracts, including partial OneDrive ownership rejection.
  All R1/R2 baseline comparisons, eight lifecycle groups and nine communications
  groups still pass. No dependencies, permissions, synthetic schedules, root
  configuration or health-model topology changed during the refactor.

## Final handoff

The local refactor checkpoints are `588dca7` (execution models), `fd4cf48`
(measurements/ingestion), `0fd1ffd` (lifecycles/clocks) and `95b3f78`
(organization). Session-only validation artifacts retain the frozen feature
baseline and focused comparisons; no test suite, fixtures or new tooling were
added to the repository.

Reversing R4 through R1 in a private Git index reproduced the `5214c49` tree
exactly, without modifying the worktree, creating commits or touching Azure.

The last authorized rollout is notice-only revision `5214c49`, not the refactor.
No new format preview, Graph grant, Azure permission change, push or refactor
deployment was performed. A genuine updated notice was not available for live
rendering acceptance; the user accepted local formatting evidence plus live
quiet/count/topology checks. Historical quiet/preflight annotations remain.
Further deployment or pushing still requires separate approval; local rollback
does not undo a cloud rollout or revoke permissions.

## Round 2 refactoring plan: Idiomatic Node.js, function comments, readability, and README alignment

This next refactoring round addresses four goals across the repository without
adding test frameworks or changing runtime behavior, signal contracts, or cloud
topology:

| ID | Milestone | Scope | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| R5 | Replace bespoke helpers with Node.js 22 built-ins | `utils/src/execution`, `utils/src/integrations`, `utils/src/deployment`, `onedrive/src`, `teams/src`, `exchange/src` | `clock.ts` (`ExecutionClock`) and empty `utils/src/graph/` removed; `Date.now()`, `performance.now()`, `node:timers/promises` `setTimeout`, `AbortSignal.timeout()`, and `node:util` `parseArgs` used directly | Planned |
| R6 | Add clear comments above every function | All `.ts` files in `synthetic-tests/{utils,exchange,teams,onedrive,ingestion}/src` | Every exported and internal function/method has a concise, accurate comment immediately above it | Planned |
| R7 | Make control flow and data construction human-readable | `utils/src/*`, `exchange/src/*`, `teams/src/*`, `onedrive/src/*`, `ingestion/src/*` | Nested ternaries, compressed one-line `try/catch/finally` blocks, `Object.assign` mutations, and dense conditional spreads replaced with readable step-by-step code | Planned |
| R8 | Align all READMEs and guides with current implementation | `README.md`, `health-model/README.md`, `synthetic-tests/**/README.md`, `docs/*.md` | `providerIntervalSeconds` (60s), `serviceMessages` data annotations, module layout, and auth guidance are consistent and clear across all READMEs and docs | Planned |

### 1. Remove overly custom and bespoke abstractions (R5)

- **Remove `ExecutionClock` (`synthetic-tests/utils/src/execution/clock.ts`) and injected clock/time wrappers**:
  - Delete `clock.ts` and remove `clock`, `now`, and `sleep` injection fields from `execution/worker.ts`, `execution/runner.ts`, `execution/steps.ts`, `execution/probes.ts`, `teams/src/call.ts`, `teams/src/call-steps.ts`, `integrations/teams-calling-auth.ts`, `integrations/teams-call-operations.ts`, and `onedrive/src/journey.ts`.
  - Use Node.js built-ins directly: `Date.now()` for wall-clock timestamps, `performance.now()` for elapsed durations, `setTimeout(delayMs, undefined, { signal })` from `node:timers/promises` for abortable delays, and `AbortSignal.timeout(delayMs)` / `AbortSignal.any([...])` for deadlines.
- **Standardize CLI argument parsing on `node:util` `parseArgs`**:
  - Replace custom loop parsers `parseWorkerArguments` (`utils/src/execution/worker.ts`), `parseSetupArguments` (`onedrive/src/setup-command.ts`), and `parseDeployArguments` (`utils/src/deployment/deploy.ts`) with `parseArgs` from `node:util` (matching `exchange/src/mail-test-command.ts`).
- **Simplify bespoke utilities and remove dead directories**:
  - Remove the empty `synthetic-tests/utils/src/graph/` directory left behind by R4.
  - Consolidate duplicate SHA-256 helpers in `exchange/src/extended-journeys.ts` and `onedrive/src/steps.ts`.
  - Simplify `filterRuntimeProbes` in `utils/src/configuration/config.ts` and streamline response-reading helpers in `utils/src/integrations/`.

### 2. Add comments above every function (R6)

- Add a clear, concise comment immediately above every function and class method across all 74 TypeScript files (after removing `clock.ts`):
  - `synthetic-tests/utils/src/execution/` (`command.ts`, `execution-lanes.ts`, `graph-request-permits.ts`, `probes.ts`, `runner.ts`, `runtime.ts`, `steps.ts`, `worker.ts`)
  - `synthetic-tests/utils/src/configuration/` (`account-identity.ts`, `bindings.ts`, `config.ts`, `deployment-config.ts`, `groups.ts`, `project-config.ts`, `raw-config.ts`, `references.ts`, `resolved-probes.ts`, `service-config.ts`)
  - `synthetic-tests/utils/src/integrations/` (`auth.ts`, `graph.ts`, `http.ts`, `teams.ts`, `teams-call-operations.ts`, `teams-calling-auth.ts`, `teams-calling-callback.ts`)
  - `synthetic-tests/utils/src/providers/` (`provider-catalog.ts`, `provider-collection.ts`, `provider-diagnostics.ts`, `provider-health-reports.ts`, `service-activity.ts`, `service-annotations.ts`, `service-communications.ts`, `service-health.ts`, `service-messages.ts`)
  - `synthetic-tests/utils/src/reporting/` (`health-report-client.ts`, `health-reports.ts`, `measurements.ts`, `observation-publisher.ts`, `observations.ts`, `results.ts`)
  - `synthetic-tests/utils/src/deployment/` (`deploy.ts`, `deploy-phases.ts`, `prepare-deployment.ts`, `reporting-deployment.ts`, `retire-log-pipeline.ts`) and root `utils/src/` (`catalog.ts`, `catalog-projection.ts`, `contracts.ts`, `paths.ts`)
  - `synthetic-tests/exchange/src/`, `synthetic-tests/teams/src/`, `synthetic-tests/onedrive/src/`, and `synthetic-tests/ingestion/src/`

### 3. Improve human readability (R7)

- Expand nested ternaries into explicit helper functions or `if`/`else` blocks (e.g., error classification in `exchange/src/journey.ts`, `teams/src/conversation.ts`, `teams/src/call.ts`, `onedrive/src/setup.ts`; health state and activity evaluation in `providers/provider-health-reports.ts`; resource ID formatting in `configuration/references.ts`).
- Expand compressed single-line `try { ... } catch { ... } finally { ... }` blocks and dense object spreads in `execution/worker.ts`, `execution/runner.ts`, `execution/steps.ts`, `execution/graph-request-permits.ts`, `providers/service-annotations.ts`, `providers/service-health.ts`, and `deployment/deploy.ts`.
- Replace `Object.assign` state mutation one-liners in `onedrive/src/journey.ts`, `onedrive/src/steps.ts`, and `providers/provider-diagnostics.ts` with explicit typed object construction.
- Break up long validation and orchestration functions in `configuration/project-config.ts`, `configuration/service-config.ts`, `integrations/graph.ts`, `integrations/teams-calling-callback.ts`, `deployment/deploy-phases.ts`, and `deployment/reporting-deployment.ts` into well-named steps.

### 4. Make all READMEs and documentation consistent (R8)

- **`synthetic-tests/README.md`, `synthetic-tests/exchange/README.md`, `synthetic-tests/teams/README.md`, `synthetic-tests/onedrive/README.md`, `synthetic-tests/infra/README.md`**:
  - Update `providerIntervalSeconds` default from `300` seconds to `60` seconds and document optional `serviceMessages` (Message Center) collection and entity Data annotations consistently.
- **`synthetic-tests/utils/README.md`**:
  - Remove `clock.ts` / `ExecutionClock` references and describe direct use of Node.js built-ins.
- **`health-model/README.md` and `docs/*.md`**:
  - Fix `health-model/README.md` so Data annotations describe per-notice publication (no quiet minute snapshots).
  - Remove or mark unsupported the legacy certificate/PEM cross-tenant instructions in `docs/cross-tenant-access.md` and `docs/operations.md` to match the managed-identity-only policy.
  - Clarify archive vs. current topology in `docs/deployment.md` and replica wording in `docs/pricing.md`.
