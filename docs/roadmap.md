# Service communications and readability delivery roadmap

Date: 2026-10-30. Target: complete the work today, in independently reviewable
checkpoints, without mixing the new feature with the subsequent refactor.

## Delivery order and approvals

1. Implement service communications first: active incidents/advisories **and**
   Message Center announcements on the existing Service Health supporting entities.
2. Checkpoint the working feature before making general structural changes.
3. Refactor incrementally for human readability and testability, preserving behavior.
4. Finish with integration evidence and an explicit account of anything unverified.

Baseline: `f0a85cc` on `main`. Delivery branch:
`service-communications-refactor`. The worktree was clean at branch creation.

Read-only Graph/Azure discovery using existing permissions and validated **local
checkpoint commits** are approved. Permission grants, deployment, live synthetic
mutations, pushing and history rewriting are not approved.

The handoff is the supplied `README-m365-service-communications.md`. It is a
design input, not evidence that the feature or its permissions already work.

## Milestones

The blocks below are the execution order, not guaranteed finish times. Discovery
and external approval can change the critical path. Keep independent read-only
research and bounded checks concurrent; never have parallel tasks edit the same
files.

| ID | Milestone | Depends on | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| C0 | Establish roadmap and rollback baseline | None | Scope, approvals, checkpoints and blockers recorded | In progress |
| C1 | Verify communications contracts | None | v1.0 filters/continuations, actual product labels, relevance semantics, report size and useful portal presentation established or explicitly blocked | In progress |
| C2 | Add service-scoped collectors and models | C1 contract decisions | Complete bounded snapshots, distinct IDs, isolated source failures, explicit Unknown; no unrelated service feed | Planned |
| C3 | Integrate summaries, signals and configuration | C2 | Existing suppressed entities show bounded summaries and informational counts; default-off per-service Message Center opt-in; disabled and messages-only gates work | Planned |
| C4 | Validate and checkpoint communications | C3 | Existing local checks pass; count scope, permissions, limits and remaining live gates documented | Planned |
| R1 | Strengthen resolved execution models | C4 | Journey-specific probe/dependency types replace invalid optional-field combinations without changing user config or result contracts | Planned |
| R2 | Clarify reporting and ingestion boundaries | R1 | Shared pure measurement interpretation; transport-specific aggregation preserved; ingestion processing imports without constructing Azure clients | Planned |
| R3 | Simplify worker and journey lifecycles | R2 | Named orchestration and workflow functions; controllable time/deadline seams; existing scheduling, cancellation, cleanup and request bounds preserved | Planned |
| R4 | Organize shared modules | R3 | Responsibility-based folders with imports, packaging, commands and source fingerprints kept consistent | Planned |
| V1 | Complete local integration verification | R4 | Final checks, focused behavior comparisons, reviewed diff and local checkpoint history | Planned |
| V2 | Complete authorized live acceptance | C4 and separate approvals | Real scoped feeds, fresh ingested summaries, useful presentation and unchanged rollup verified; remaining reliability limits stated | Approval gated |

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
- Attach plain-text, bounded summaries with source IDs/links, relevant dates,
  statuses/categories and latest-update excerpts. Sort posts by timestamp.
  Distinguish total matching items, displayed items and omitted/truncated content.
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

### Refactor after the feature checkpoint

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

Live acceptance needs separate approvals where it requires a new
`ServiceMessage.Read.All` application grant, a deployment or live synthetic
mutations. Filtering is not permission scoping: the provider grants are
tenant-wide. Do not broaden synthetic identities.

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

- Baseline and clean delivery branch established.
- Existing Azure CLI session is available for approved read-only discovery.
- Microsoft Graph v1.0 documentation confirms both list endpoints and their
  separate permissions, but not the proposed property-specific filter contracts.
- Additional-context SDK documentation confirms a string field, not a guaranteed
  rich portal list or a verified size budget. Presentation and limits remain open.
- New permission grants, deployment and live synthetic execution remain approval
  gates, not implementation authorization.
