# Synthetic worker infrastructure

This folder contains Bicep templates for shared worker foundation resources and per-service container apps.

## What gets deployed

- One container app per enabled service per tenant in `monitoring.config.json`
- Shared monitoring and diagnostics resources for worker hosting
- Identity and secret wiring consumed by worker runtime

## Inputs

Deployment is fully driven by root `monitoring.config.json` and generated `.env` values:

- resource group, region, and tags
- tenant/service enablement and schedules
- worker identity references and app credential references
- Teams callback and bot pair settings when Teams is enabled

## Deploy

From `synthetic-tests/`:

```sh
npm run deploy -- --plan
npm run deploy
```

## Validate templates

```sh
az bicep build --file synthetic-tests/infra/main.bicep --stdout > /dev/null
```

## Related docs

- Deployment flow: `../../docs/deployment.md`
- Runtime details: `../utils/README.md`
