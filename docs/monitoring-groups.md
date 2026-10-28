# Reporting groups

Groups are optional, user-named views of the same journeys, such as "United States Users"
next to "United Kingdom Users". They are defined in the single root
[monitoring.config.json](../monitoring.config.json) and are additive: tests, workers,
models and the overall signals do not change.

## Define groups

```json
"groups": [
  { "id": "united-states-users", "displayName": "United States Users", "description": "Optional",
    "accounts": ["test-user-1@example.invalid", "test-user-2@example.invalid"],
    "teams": ["teams-probe-001", "teams-bot-meeting-001"] },
  { "id": "united-kingdom-users", "displayName": "United Kingdom Users",
    "accounts": ["test-user-4@example.invalid", "test-user-5@example.invalid"],
    "teams": ["teams-probe-002"] }
]
```

- `id` is a unique lowercase slug with single hyphens, up to 40 characters;
  `displayName` is up to 260; `description` is optional.
- `accounts` are UPNs matched case-insensitively to each Exchange target's `mailbox`
  and OneDrive target's `userPrincipalName`. Only the initiating mailbox counts: an
  A→B mail attempt belongs to A's group.
- `teams` are ids of Teams channel `targets[]` and meeting `callTargets[]` (bots,
  not user accounts). `npm run setup` also adds the group's `accounts` to the team of
  each Teams channel target it lists, so the group's users are members of the team its
  channel lives in ([setup](./deployment.md#set-up-microsoft-365-with-one-script)); the
  journeys themselves stay bot-only.
- A group needs at least one member. The tenant is derived from the members; an
  account or id that matches nothing, matches more than one tenant, or repeats in a
  list is a configuration error, reported whenever the config is read (including
  `npm run deploy -- --plan`).
- Accounts outside every group are still tested and counted in the overall signals.
  An account can belong to several groups; each publishes its own signals.

## What you get

Each group adds **one signal aggregation group, named after its `displayName`, to
each journey entity** it has members for. It holds the
group's `synthetic-success-percentage` and `synthetic-mean-duration` (plus the four
call-phase signals on `teams-call`), published as `group-<id>--tenant-<tenant>--<signal>`,
for example `group-united-states-users--tenant-contoso--synthetic-success-percentage`.
`<tenant>` is the tenant entry's `id`; a group spanning tenants has one signal set
per tenant, combined worst-of rather than as a pooled percentage. These are the only
aggregation groups in the model; overall signals publish ungrouped.

- No group or tenant entity branches, per-group models or per-account entities.
- Journey entities only: not business steps, Service Health or OTEL.
- Group health reaches the Experience and root entities through the normal
  dependency roll-up.
- A group appears on a journey when its tenant service and scenario are enabled and
  it has a member target there (Teams: a channel target for `channel-conversation`,
  a meeting for `scheduled-meeting`).

Naming rule: with one tenant in the config, overall signals keep their plain names
(`synthetic-success-percentage`). With more than one, every overall signal a worker
publishes is `tenant-<tenant>--<signal>`, so tenants do not overwrite one another on
the shared service model. Group signals stay `group-<id>--tenant-<tenant>--<signal>`
and are never qualified twice. Adding a second tenant renames every overall signal in
one step: deploy with `npm run deploy` so models and workers change together; old
plain-named reports expire after the report TTL.

## Run and deploy

From `synthetic-tests/`:

```sh
npm run exchange -- --once                    # one tenant in the config
npm run onedrive -- --once --tenant contoso   # --tenant <id> when there are several
npm run deploy -- --plan                      # no Azure changes; lists groups that reach a journey
```

`--group`, `--all-groups` and `--project-config` no longer exist. Workers stay
centrally hosted: group names are reporting labels, not execution regions.

## Per-group searches in Log Analytics

With `otel.enabled: true` and `destination: "azure-monitor"`, every step and result
record carries the group's `monitoring.group` (id) and `monitoring.group_name`, so the
three saved searches break failures, impacted users and success rates down per group. A
target that belongs to several groups writes one record per group; every record after
the first is marked `monitoring.group_duplicate = "true"`, which the overall model
signals skip so each attempt counts once and the per-group searches keep. See
[Log Analytics for administrators](./operations.md#log-analytics-for-administrators).

## Limits

- Group health joins each journey's worst-of composite, so a small group (one
  account) can turn an entity Degraded or Unhealthy on a single failed attempt that
  the overall percentage would absorb.
- Each group adds journey-level health reports every cycle, so report requests grow
  with groups x journeys.
- Unknown never overrides a known state, so a stopped worker is not visible through
  a group; use the [operations checks](./operations.md#enterprise-reliability-acceptance-gate).
- Groups label API-backed results; they do not measure employee experience or
  anything from the named location. Source and template tests cover them; see the
  [dated deployment evidence](./deployment.md#deployment-status-and-order) for what
  was observed live.
