# Deploy the model, then connect workers

The sample model `m365-experience-poc` is deployed in `rg-m365-demo`, Central US. The authoritative template, commands, topology, and real Azure verification are in the [health-model guide](../health-model/README.md).

This deployment contains only the model, thirteen entities, and eleven relationships. It does not create a Container App, registry, telemetry workspace, storage account, mailbox, or Microsoft 365 permission grant.

## Verify the existing model

Use the intended subscription explicitly; do not assume a shared machine's active Azure subscription has not changed.

```sh
SUBSCRIPTION_ID='<approved-subscription-id>'
az deployment group show \
  --subscription "$SUBSCRIPTION_ID" \
  --resource-group rg-m365-demo \
  --name m365-model-foundation \
  --query '{state:properties.provisioningState,modelId:properties.outputs.modelId.value}'
```

Reapply the Bicep template only after reviewing its `what-if` output, using the same model name/resource group. Do not create a duplicate model merely because the active CLI subscription changed.

## Run a worker locally

```sh
npm run probe -- --config probes/exchange/config.json --once
npm run probe -- --config probes/sharepoint/config.json --once
```

The checked-in configs simulate outcomes and disable Azure reporting. Each service has its own config and cadence; Teams remains disabled because it has no handler. See the [worker guide](../runner/README.md).

## Connect reports deliberately

1. Approve a model for simulation or live evidence; do not mix those modes in one model.
2. Ensure the exact config `cohort` exists as a model entity.
3. Set `reportToHealthModel: true` in the approved config.
4. Supply `AHM_MODEL_ID` and the submitting identity's model-scoped access. The validated API version is `2026-05-01-preview`.
5. Use one `--once` run and read back the cohort before scheduling.

Reporting is a real Azure write even when the probe mode is simulation. Live execution also needs the workload's approved test resources and narrowly scoped permissions.

| Current handler | Default entity / signal |
| --- | --- |
| Exchange | `exchange-global` / `synthetic-health` |
| SharePoint | `sharepoint-global` / `synthetic-health` |

Provider context, Graph availability, global runner heartbeat, and Teams remain model placeholders, not active producers. Their Unknown state must not be hidden or manually marked Healthy to make the graph green.

## Azure Container Apps: next hosting step, not deployed

Use the same application code with separate configs for separate workers. Build with `npm run build`; production startup is `npm start -- --config <service-config.json>`.

Before hosting, implement container packaging, approved Graph identity selection, protected credential storage/rotation, durable isolated state, telemetry retention, and stopped-worker monitoring. Keep one authoritative replica per config/cohort until distributed ownership is implemented. ETags do not prevent duplicate sends.

OTel export and child-probe execution remain future work. Current workers execute their handlers in-process and retain structured results; evaluated health reports use the Health Report Ingestion API, not OTel.

## Acceptance checks

- Model/entity/relationship reads match the template and absent evidence stays Unknown.
- Healthy, Degraded, Unhealthy, and Unknown reports are read back with expected parent propagation.
- Each worker follows its own cadence, skips overruns, and cleans up on cancellation.
- Failed reporting/history writes cannot claim successful execution.
- Live handlers affect only approved resources and clean up only their own artifacts.
- Stopping a worker does not leave stale evidence falsely Healthy.

The existing model's one-minute heartbeat-expiration test returned Unknown after approximately 62 seconds. That is not a blanket guarantee: expired external signals are removed and health is recalculated, so other signals or rollup can mask missing evidence. Revalidate the final connected model before operational use.

Azure Monitor Health Models is a preview service. Confirm current pricing and organizational approval; no compute deployment does not imply a guaranteed zero-cost service. For cleanup, stop producers first and remove only approved dedicated resources, never a shared resource group.
