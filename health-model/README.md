# Azure Monitor Health Models

This component owns health-report ingestion, cohort evaluation policy, and the deployable model topology. Probe implementations and runner hosting are separate components.

## Model-first scope

[The Bicep template](./infra/main.bicep) creates only:

- One health model with a system-assigned identity.
- Thirteen entities (including the service-created root) and eleven dependency relationships.
- Explicit `WorstOf` dependency aggregation with `ignoreUnknown: false`.

It does **not** deploy Azure Container Apps, a registry, storage, a telemetry workspace, mailboxes, or Microsoft 365 permissions. The model identity receives no additional role assignments. Azure Container Apps is the intended runner host, not an already deployed service.

```text
Model root: Microsoft 365 Synthetic Health Model (PoC)
|
`-- Microsoft 365 and Azure Experience
    |
    +-- Azure Resource Health                     [not connected]
    +-- Exchange Experience
    |   +-- Exchange Mail-flow Cohort              [not connected]
    +-- Teams Experience
    |   +-- Teams Cohort                          [not implemented]
    +-- SharePoint Experience
    |   +-- SharePoint File Cohort                [not connected]
    +-- Monitoring Pipeline
        +-- Runner Heartbeat                      [runner not deployed]
        +-- Graph Query Availability              [not connected]

Microsoft 365 Service Health                      [separate supporting context]
```

Provider context has no dependency edge to the experience root and has suppressed impact. A provider incident is context, not proof that a mailbox journey failed.

Azure automatically creates an undeletable root entity named after the model. The template explicitly manages its dependency settings and connects the experience subtree to it so the model's actual root participates in rollup.

Unconnected entities must not be presented as measured Healthy. The deployment's empty entities and explicit Unknown propagation are the starting point; manually submitted states are validation data, not synthetic evidence.

## Deploy into an existing resource group

Use an approved Azure subscription and a region supporting `Microsoft.CloudHealth`. The selected provider must already be registered; this template does not register providers or request permissions.

```sh
SUBSCRIPTION_ID='<approved-subscription-id>'
RESOURCE_GROUP='rg-m365-demo'
MODEL_NAME='m365-experience-poc'

az deployment group validate \
  --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" \
  --template-file health-model/infra/main.bicep \
  --parameters modelName="$MODEL_NAME" location=centralus

az deployment group what-if \
  --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" \
  --template-file health-model/infra/main.bicep \
  --parameters modelName="$MODEL_NAME" location=centralus

az deployment group create \
  --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" \
  --name m365-model-foundation \
  --template-file health-model/infra/main.bicep \
  --parameters modelName="$MODEL_NAME" location=centralus
```

Deployment is incremental. Review the preview before applying; do not use complete-mode deployment against a shared resource group.

The template pins `2026-05-01-preview`, a documented version advertised by the selected subscription, to keep topology and ingestion reproducible. Newer advertised API versions require a schema and behavior check before changing the pin.

## Verify actual model behavior

Use the deployment's `modelId` and `apiVersion` outputs:

```sh
export AHM_MODEL_ID='<modelId-output>'
export AHM_API_VERSION='2026-05-01-preview'

az rest --method GET \
  --url "https://management.azure.com${AHM_MODEL_ID}/entities?api-version=${AHM_API_VERSION}" \
  --query 'value[].{entity:name,state:properties.healthState}' --output table
```

Check that all thirteen entities and eleven relationships exist, and that missing evidence remains Unknown. For explicit ingestion testing with workers stopped, submit a clearly marked validation report:

```sh
az rest --method POST --subscription "$SUBSCRIPTION_ID" \
  --url "https://management.azure.com${AHM_MODEL_ID}/entities/exchange-global/ingestHealthReport?api-version=${AHM_API_VERSION}" \
  --body '{"signalName":"synthetic-health","healthState":"Unknown","expiresInMinutes":3,"additionalContext":"Manual model validation only; no probe executed."}'
```

This really writes a report; it does not run a mailbox synthetic. To test transitions, change `healthState` to Healthy, Degraded, Unhealthy, and finally Unknown, reading the leaf and its parent after recalculation each time. Do not infer successful evaluation from an HTTP success response alone.

Return validation signals to Unknown when finished. Other unconnected branches can keep the overall root Unknown, so inspect the tested branch as well as the root.

**Report expiration is not a freshness guarantee.** The ingestion API removes expired external signals and recalculates entity health. Verify that an expired or stopped runner cannot be masked by other healthy evidence before accepting an operational deployment.

### Verified foundation deployment

On 2026-10-19, `m365-experience-poc` was deployed to `rg-m365-demo` in Central US and verified against the real Azure API:

- ARM validation, change preview, and incremental deployment succeeded.
- All thirteen entities and eleven relationships were read back, including the connection to the service-created model root.
- Every entity initially reported Unknown, and provider context remained isolated from experience rollup.
- Explicit Healthy, Degraded, Unhealthy, and Unknown reports were each read back on `exchange-global` and propagated to `exchange-experience`.
- A manual Healthy heartbeat with a one-minute TTL expired to Unknown, with its external signal removed, after approximately 62 seconds.
- Validation reports were returned to Unknown. No real probe was executed.

This verifies the deployed foundation, not a production freshness guarantee under future additional signals. Only the health model is deployed: no runner, telemetry workspace, mailbox, or Microsoft 365 permission grant was created.

## Working backwards toward probes

Keep the evidence paths separate:

1. Each Exchange, Teams, or document probe returns a versioned structured result.
2. The runner retains per-run diagnostics without message bodies, raw mailbox addresses, or secrets.
3. The proposed OpenTelemetry path exports low-cardinality outcome counters and duration histograms. Correlation IDs belong in events/traces, not metric dimensions.
4. Health evaluation produces explicit Healthy, Degraded, Unhealthy, or Unknown reports for the matching model entity.

OpenTelemetry export is **not** direct health-model ingestion. A future metrics/query-based evaluation path needs its own supported Azure Monitor data source and signal configuration. No OpenTelemetry SDK, collector, or metric signal is provisioned by this template.

The [config-driven worker](../runner/README.md) runs one service per config/process, with its own cadence and non-overlapping local scheduling. Container hosting, replica/per-mailbox ownership, bounded child processes, and stopped-runner detection still need implementation and operational validation before deployment. Do not assume a one-minute interval provides distributed ownership or end-to-end monitoring.

See the root [mailbox administrator request](../MAILBOX-SYNTHETIC-ACCESS.md) before connecting Exchange. A different mailbox tenant requires its own approved application identity and an explicit hosted cross-tenant authentication implementation.

## Cost and cleanup boundaries

No continuously running compute or telemetry-ingestion resources are created here. Do not interpret that as a guarantee that Azure Monitor Health Models has no charges; confirm current preview terms, subscription pricing, and organizational approval.

To decommission, stop any connected producers first, then delete only this health model after owner approval. Do not delete the shared resource group or unrelated resources. Mailboxes, tenant applications, and future runner resources have separate lifecycles.

## References

- [Versioned health-model resource definition](https://learn.microsoft.com/en-us/azure/templates/microsoft.cloudhealth/2026-05-01-preview/healthmodels)
- [Entity and dependency aggregation schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.cloudhealth/2026-05-01-preview/healthmodels/entities)
- [Relationship resource definition](https://learn.microsoft.com/en-us/azure/templates/microsoft.cloudhealth/2026-05-01-preview/healthmodels/relationships)
- [External health-report ingestion and expiration](https://learn.microsoft.com/en-us/azure/azure-monitor/health-models/health-report-ingestion)
