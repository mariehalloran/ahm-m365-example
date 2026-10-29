# Reporting groups

User groups apply to **Exchange and OneDrive only**. Define them under each tenant's
service `targets` in the single root [monitoring.config.json](../monitoring.config.json).
Teams channel `targets[]` and meeting `callTargets[]` remain ungrouped: their
participants are bots, not the users in these groups.

## Define groups

For `tenants[].services.exchange`, `targets` is an object keyed by group ID:

```json
{
  "targets": {
    "userGroup1": {
      "userGroupName": "User Group One",
      "users": [
        { "mailbox": "test-user-1@example.invalid" }
      ]
    },
    "userGroup2": {
      "userGroupName": "User Group Two",
      "users": [
        { "mailbox": "test-user-2@example.invalid" }
      ]
    }
  }
}
```

OneDrive uses the same shape, with its per-user fields inside
`users`: `userPrincipalName`, `folderName` and optional `restoreVersion`.
Exchange accounts are identified by `mailbox`, and OneDrive accounts by
`userPrincipalName`, case-insensitively. Neither accepts a manually assigned `id`.
Generated reply seeds and OneDrive IDs still come from the adjacent `.env`, matched
by tenant and an automatically derived account key; moving an account between groups
does not rename its bindings. See [generated IDs](./deployment.md#generated-ids-in-env).

- A group ID starts with a letter, contains letters/digits and optional single
  hyphens, and is at most 40 characters. `userGroupName` is a nonempty display name
  of at most 260 characters.
- IDs are service-local: Exchange and OneDrive may use the same ID independently.
  Within one service, matching IDs across tenants combine into one model group and
  must use identical casing and `userGroupName`.
- Every configured Exchange/OneDrive user belongs inside a group's `users`.
  Repeat the same account address and identical settings to put a user in several groups:
  the worker executes it once and includes the result in each group.
- Repeated account addresses inside one group and conflicting settings across groups
  are rejected. The limit is
  1,000 unique user targets per tenant/service, not 1,000 per group.
- An empty group is allowed but has no model signals until it has runnable users.
  An enabled service with selected journeys still needs at least one user.
- Root `groups`, `accounts` membership lists and flat Exchange/OneDrive target
  arrays are no longer supported. Teams never reads these user groups or uses
  them to grant team membership.

## What you get

Each user group adds **one signal aggregation group, named after its `userGroupName`,
to each Exchange/OneDrive journey entity** it has runnable users for. It holds the
group's `synthetic-success-percentage` and `synthetic-mean-duration`,
published as `group-<id>--tenant-<tenant>--<signal>`,
for example `group-united-states-users--tenant-contoso--synthetic-success-percentage`.
`<tenant>` is the tenant entry's `id`; a group spanning tenants has one signal set
per tenant, combined worst-of rather than as a pooled percentage. These are the only
aggregation groups in the model; overall signals publish ungrouped.

- No group or tenant entity branches, per-group models or per-account entities.
- Journey entities only: not business steps, Service Health or OTEL.
- Group health reaches the Experience and root entities through the normal
  dependency roll-up.
- A group appears on a journey when its tenant service and scenario are enabled and
  it has a user target there.
- Teams journey, step and call-phase reports remain ungrouped. Redeployment replaces
  their journey definitions without user groups; old ingested group observations stop
  being refreshed and expire after the report TTL.

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
npm run deploy -- --plan                      # no Azure changes; lists user groups by service
```

Deploy the models and worker images together with `npm run deploy`. Older images
expect flat Exchange/OneDrive target arrays and cannot read this grouped format.

`--group`, `--all-groups` and `--project-config` no longer exist. Workers stay
centrally hosted: group names are reporting labels, not execution regions.

## Per-group searches in Log Analytics

With `otel.enabled: true` and `destination: "azure-monitor"`, Exchange/OneDrive step
and result records carry the group's `monitoring.group` (id) and `monitoring.group_name`, so the
three saved searches break failures, impacted users and success rates down per group. A
target that belongs to several groups writes one record per group; every record after
the first is marked `monitoring.group_duplicate = "true"`, which the overall model
signals skip so each attempt counts once and the per-group searches keep.
Teams records have no user-group attributes. See
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
  anything from the named location. Local configuration/build checks are not live
  acceptance; see the
  [dated deployment evidence](./deployment.md#deployment-status-and-order) for what
  was observed live.
