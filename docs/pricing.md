# Pricing and cost differences

Pricing is controlled by one setting in root `monitoring.config.json`:

- `logAnalytics.enabled: false` - direct container health reports
- `logAnalytics.enabled: true` - observation pipeline (Event Hubs + ingestion Function + Log Analytics)

## Monthly estimate summary

Assumptions used for this guide:

- Central US list pricing checked on 2026-10-30
- 730 hours/month
- baseline topology: 3 workers (Exchange, Teams, OneDrive), 1 Basic ACR

| Mode | Baseline (4 Exchange, 2 OneDrive, 1 Teams pair) | 100 Exchange + 100 OneDrive (baseline Teams) |
| --- | ---: | ---: |
| Direct reports (`logAnalytics.enabled: false`) | ~ $65/month | ~ $65/month* |
| Observations, Capture off | ~ $105-115/month | ~ $510-530/month |
| Observations, Capture on | ~ $180-190/month | ~ $590-610/month |

\* Worker cost stays near baseline only if current sizing can still complete within configured deadlines.

## Main cost drivers

### Always present

- Container Apps workers (3 x 0.25 vCPU / 0.5 GiB): ~ $59/month at full active rate
- Basic Azure Container Registry: ~ $5/month
- Config/auxiliary storage: small recurring storage + transaction cost

### Only when `logAnalytics.enabled: true`

- Event Hubs Standard (1 TU): ~ $21.90/month base capacity
- Log Analytics ingestion: depends on billed GB (`_BilledSize`)
- Ingestion Function (Flex Consumption): execution and GB-seconds
- Optional Event Hubs Capture: ~ $73/month per TU + archive storage/transactions

## Logging add-on comparison

If you treat workers/registry as already funded, the additional logging path is approximately:

| Logging add-on | Baseline | 100-account projection |
| --- | ---: | ---: |
| Capture off | ~ $40-50/month | ~ $445-465/month |
| Capture on | ~ $115-125/month | ~ $525-545/month |

## What turning logging off removes

After deploy applies `logAnalytics.enabled: false`, the logging pipeline is drained and retired:

- Event Hub namespace owned by this deployment path
- ingestion Function/plan
- DCR/DCE and ingestion identity
- log-freshness alert tied to ingestion pipeline

Historical workspace/archive data retention remains subject to each resource's configured retention.

## Check estimates against actual usage

1. Deploy current config:
   ```sh
   cd synthetic-tests
   npm run deploy
   ```
2. When logging is enabled, review ingestion volume with:
   - `health-model/queries/admin/ingestion-volume.kql`
3. Confirm billed meters and grants in Azure Cost Management.

## Pricing references

- [Container Apps pricing](https://azure.microsoft.com/pricing/details/container-apps/)
- [Container Registry pricing](https://azure.microsoft.com/pricing/details/container-registry/)
- [Event Hubs pricing](https://azure.microsoft.com/pricing/details/event-hubs/)
- [Azure Monitor pricing](https://azure.microsoft.com/pricing/details/monitor/)
- [Functions pricing](https://azure.microsoft.com/pricing/details/functions/)
- [Blob Storage pricing](https://azure.microsoft.com/pricing/details/storage/blobs/)
