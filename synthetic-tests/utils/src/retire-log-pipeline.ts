import { z } from "zod";
import { ConfigurationError } from "./config.js";
import { az, azJson, type DeploymentRun } from "./deploy-phases.js";

const management = "https://management.azure.com";
const readerRole = "73c42c96-874c-492b-b04d-ab87d138a893";
const publisherRole = "3913510d-42f4-4e42-8a64-420c390055eb";
const blobContributorRole = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";
const resourceSchema = z.object({
  id: z.string(), name: z.string(), type: z.string(),
  tags: z.record(z.string()).nullish(),
});
type Resource = z.infer<typeof resourceSchema>;
interface Retirement {
  id: string;
  type: string;
  apiVersion: string;
}
export interface LogPipelineRetirement {
  resources: Retirement[];
  namespaces: string[];
  functions: string[];
  identityPrincipals: string[];
  capturePrincipals: string[];
  alertPrincipals: string[];
  hostStorageIds: string[];
  hubIds: string[];
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const workspaceId = (run: DeploymentRun) => `${resourceGroupId(run)}/providers/Microsoft.OperationalInsights/workspaces/${
  run.prepared.settings.workspaceName ?? `law-${run.prepared.document.healthModel.name}`}`;
const resourceGroupId = (run: DeploymentRun) => `/subscriptions/${run.prepared.document.healthModel.subscriptionId}/resourceGroups/${run.prepared.document.healthModel.resourceGroup}`;

async function inventory(run: DeploymentRun): Promise<Resource[]> {
  return z.array(resourceSchema).parse(await azJson<unknown>(run, "reporting-resource-inventory", [
    "resource", "list", "--resource-group", run.prepared.document.healthModel.resourceGroup, ...run.subscription,
    "--query", "[].{id:id,name:name,type:type,tags:tags}",
  ]));
}

async function properties(run: DeploymentRun, resource: Retirement): Promise<Record<string, unknown>> {
  return z.record(z.unknown()).parse(await azJson<unknown>(run, "reporting-resource-binding", [
    "resource", "show", "--ids", resource.id, "--api-version", resource.apiVersion,
    ...run.subscription, "--query", "properties",
  ]));
}

export async function prepareLogPipelineRetirement(run: DeploymentRun): Promise<LogPipelineRetirement> {
  const resources = await inventory(run);
  const selected: Retirement[] = [];
  const result: LogPipelineRetirement = {
    resources: selected, namespaces: [], functions: [], identityPrincipals: [],
    capturePrincipals: [], alertPrincipals: [], hostStorageIds: [], hubIds: [],
  };
  const owned = (resource: Resource) => resource.tags?.workload === run.prepared.document.healthModel.name &&
    resource.tags?.purpose === "synthetic-observations";
  const add = (resource: Resource, apiVersion: string) => {
    if (!selected.some(item => same(item.id, resource.id))) {
      selected.push({ id: resource.id, type: resource.type, apiVersion });
    }
  };
  const ruleIds = new Set<string>();
  const functionPlans = new Set<string>();
  for (const resource of resources.filter(item => same(item.type, "Microsoft.Web/sites") && owned(item))) {
    const app = await properties(run, { ...resource, apiVersion: "2024-04-01" });
    functionPlans.add(z.string().parse(app.serverFarmId).toLowerCase());
    const settings = z.object({ properties: z.record(z.string()) }).parse(await azJson<unknown>(run, "retirement-function-binding", [
      "rest", "--method", "post", "--url", `${management}${resource.id}/config/appsettings/list?api-version=2024-04-01`,
      ...run.subscription,
    ])).properties;
    if (!settings.OBSERVATION_RULE_ID || !settings.ObservationEvents__fullyQualifiedNamespace) {
      throw new ConfigurationError(`Refusing to retire a Function without the expected observation bindings: ${resource.name}`);
    }
    ruleIds.add(settings.OBSERVATION_RULE_ID);
    const hostStorage = resources.find(item => same(item.type, "Microsoft.Storage/storageAccounts") &&
      item.name === settings.AzureWebJobsStorage__accountName && owned(item));
    if (hostStorage) result.hostStorageIds.push(hostStorage.id);
    result.functions.push(resource.id);
    add(resource, "2024-04-01");
  }
  for (const resource of resources.filter(item => same(item.type, "Microsoft.Web/serverfarms") && functionPlans.has(item.id.toLowerCase()))) {
    const sites = z.object({ value: z.array(z.object({ id: z.string() })) }).parse(await azJson<unknown>(run, "retirement-plan-binding", [
      "rest", "--method", "get", "--url", `${management}${resource.id}/sites?api-version=2024-04-01`, ...run.subscription,
    ])).value;
    if (sites.some(site => !result.functions.some(id => same(id, site.id)))) {
      throw new ConfigurationError(`Refusing to delete a Function plan shared with another application: ${resource.name}`);
    }
    add(resource, "2024-04-01");
  }
  for (const resource of resources.filter(item => same(item.type, "Microsoft.EventHub/namespaces") && owned(item))) {
    const hubs = z.array(z.object({ name: z.string() })).parse(await azJson<unknown>(run, "retirement-event-hub-binding", [
      "eventhubs", "eventhub", "list", "--resource-group", run.prepared.document.healthModel.resourceGroup,
      "--namespace-name", resource.name, ...run.subscription, "--query", "[].{name:name}",
    ]));
    if (hubs.some(hub => hub.name !== run.prepared.document.logAnalytics.eventHubName)) {
      throw new ConfigurationError(`Refusing to delete an Event Hub namespace with an unconfigured hub: ${resource.name}`);
    }
    result.namespaces.push(resource.id);
    result.hubIds.push(...hubs.map(hub => `${resource.id}/eventhubs/${hub.name}`));
    result.capturePrincipals.push(z.string().uuid().parse(await azJson<unknown>(run, "retirement-capture-identity", [
      "resource", "show", "--ids", resource.id, "--api-version", "2024-01-01", ...run.subscription,
      "--query", "identity.principalId",
    ])));
    add(resource, "2024-01-01");
  }
  for (const resource of resources.filter(item => same(item.type, "Microsoft.Insights/dataCollectionRules"))) {
    const rule = await properties(run, { ...resource, apiVersion: "2024-03-11" });
    if (!ruleIds.has(z.string().parse(rule.immutableId))) continue;
    const destinations = z.object({
      logAnalytics: z.array(z.object({ workspaceResourceId: z.string() })),
    }).parse(rule.destinations);
    if (destinations.logAnalytics.some(destination => !same(destination.workspaceResourceId, workspaceId(run)))) {
      throw new ConfigurationError(`Refusing to delete an ingestion rule targeting a different workspace: ${resource.name}`);
    }
    add(resource, "2024-03-11");
    const endpoint = resources.find(item => same(item.id, z.string().parse(rule.dataCollectionEndpointId)));
    if (endpoint) add(endpoint, "2023-03-11");
  }
  for (const resource of resources.filter(item => same(item.type, "Microsoft.ManagedIdentity/userAssignedIdentities") && owned(item))) {
    const identity = await properties(run, { ...resource, apiVersion: "2024-11-30" });
    result.identityPrincipals.push(z.string().uuid().parse(identity.principalId));
    add(resource, "2024-11-30");
  }
  const alert = resources.find(item => same(item.type, "Microsoft.Insights/scheduledQueryRules") &&
    item.name === `${run.prepared.document.healthModel.name}-observation-freshness`);
  if (alert) {
    const rule = await properties(run, { ...alert, apiVersion: "2023-12-01" });
    const scopes = z.array(z.string()).parse(rule.scopes);
    if (scopes.length !== 1 || !same(scopes[0]!, workspaceId(run))) {
      throw new ConfigurationError("Refusing to retire a freshness rule that targets a different workspace");
    }
    selected.unshift({ id: alert.id, type: alert.type, apiVersion: "2023-12-01" });
    result.alertPrincipals.push(z.string().uuid().parse(await azJson<unknown>(run, "retirement-alert-identity", [
      "resource", "show", "--ids", alert.id, "--api-version", "2023-12-01", ...run.subscription,
      "--query", "identity.principalId",
    ])));
  }
  return result;
}

async function removeGrants(run: DeploymentRun, scope: string, principals: string[], role: string): Promise<void> {
  if (!principals.length) return;
  const assignments = z.array(z.object({
    id: z.string(), scope: z.string(), principalId: z.string(), roleDefinitionId: z.string(),
  })).parse(await azJson<unknown>(run, "obsolete-reporting-grants", [
    "role", "assignment", "list", "--scope", scope, ...run.subscription,
    "--query", "[].{id:id,scope:scope,principalId:principalId,roleDefinitionId:roleDefinitionId}",
  ]));
  for (const assignment of assignments.filter(item => same(item.scope, scope) &&
    principals.some(principal => same(principal, item.principalId)) &&
    item.roleDefinitionId.toLowerCase().endsWith(`/${role}`))) {
    await az(run, "retire-obsolete-reporting-grant", ["role", "assignment", "delete", "--ids", assignment.id, ...run.subscription]);
  }
}

export async function retireWorkerDiagnosticGrants(run: DeploymentRun, additionalPrincipals: string[] = []): Promise<void> {
  const resources = await inventory(run);
  const insights = resources.find(item => same(item.type, "Microsoft.Insights/components") &&
    item.name === (run.prepared.settings.applicationInsightsName ?? `appi-${run.prepared.document.healthModel.name}`));
  if (!insights) return;
  const workers = run.provenance.identityBindings?.map(identity => identity.principalId) ?? [];
  await removeGrants(run, insights.id, [...workers, ...additionalPrincipals], publisherRole);
}

export async function retireLogPipeline(run: DeploymentRun, plan: LogPipelineRetirement): Promise<void> {
  if (run.prepared.document.logAnalytics.enabled) throw new ConfigurationError("Cannot retire an enabled Log Analytics pipeline");
  run.phase = "retire-log-pipeline";
  const alerts = plan.resources.filter(resource => same(resource.type, "Microsoft.Insights/scheduledQueryRules"));
  for (const resource of alerts) {
    await az(run, "retire-log-freshness-alert", [
      "resource", "delete", "--ids", resource.id, "--api-version", resource.apiVersion, ...run.subscription,
    ]);
  }
  if (plan.namespaces.length) {
    const until = run.now() + 360000;
    run.emit({ event: "log-pipeline-draining", until: new Date(until).toISOString(), reason: "Allow final Capture windows and ingestion to settle before retirement" });
    while (run.now() < until) {
      run.signal.throwIfAborted();
      await run.sleep(Math.min(10000, until - run.now()));
    }
  }
  for (const id of plan.functions) {
    await az(run, "stop-retired-log-ingestion", ["functionapp", "stop", "--ids", id, ...run.subscription]);
  }
  await retireWorkerDiagnosticGrants(run, plan.identityPrincipals);
  const storage = `${resourceGroupId(run)}/providers/Microsoft.Storage/storageAccounts/${run.prepared.settings.configurationStorageAccount}`;
  if (plan.capturePrincipals.length) {
    await removeGrants(run, `${storage}/blobServices/default/containers/capture`, plan.capturePrincipals, blobContributorRole);
  }
  if (plan.identityPrincipals.length) {
    await removeGrants(run, `${storage}/blobServices/default/containers/quarantine`, plan.identityPrincipals, blobContributorRole);
    for (const scope of plan.hostStorageIds) {
      await removeGrants(run, scope, plan.identityPrincipals, "b7e6dc6d-f1e8-4753-8033-0f276bb0955b");
      await removeGrants(run, scope, plan.identityPrincipals, "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3");
    }
    for (const scope of plan.hubIds) {
      await removeGrants(run, scope, plan.identityPrincipals, "a638d3c7-ab3a-418d-83e6-5f17a39d4fde");
    }
    for (const resource of plan.resources.filter(item => same(item.type, "Microsoft.Insights/dataCollectionRules"))) {
      await removeGrants(run, resource.id, plan.identityPrincipals, publisherRole);
    }
  }
  for (const resource of plan.resources.filter(resource => !alerts.includes(resource))) {
    await az(run, "retire-owned-log-pipeline-resource", [
      "resource", "delete", "--ids", resource.id, "--api-version", resource.apiVersion, ...run.subscription,
    ]);
  }
  const resources = await inventory(run);
  if (plan.resources.some(item => resources.some(resource => same(resource.id, item.id)))) {
    throw new ConfigurationError("An owned logging pipeline resource remains after retirement");
  }
  if (resources.some(item => same(item.id, workspaceId(run)))) {
    const principals = [...plan.alertPrincipals];
    for (const name of run.prepared.modelNames) {
      const model = `${resourceGroupId(run)}/providers/Microsoft.CloudHealth/healthmodels/${name}`;
      const principal = z.string().uuid().parse(await azJson<unknown>(run, "direct-model-identity", [
        "resource", "show", "--ids", model, "--api-version", "2026-05-01-preview", ...run.subscription,
        "--query", "identity.principalId",
      ]));
      principals.push(principal);
      const settings = z.object({ value: z.array(z.object({ name: z.string(), id: z.string() })) }).parse(await azJson<unknown>(run, "direct-model-authentication", [
        "rest", "--method", "get", "--url", `${management}${model}/authenticationSettings?api-version=2026-05-01-preview`,
        ...run.subscription,
      ])).value;
      for (const setting of settings.filter(item => item.name === "workspace-query" || item.name.endsWith("/workspace-query"))) {
        await az(run, "retire-log-query-authentication", [
          "rest", "--method", "delete", "--url", `${management}${setting.id}?api-version=2026-05-01-preview`, ...run.subscription,
        ]);
      }
    }
    await removeGrants(run, workspaceId(run), principals, readerRole);
  }
  run.emit({
    event: "log-pipeline-retired", retiredResources: plan.resources.map(resource => resource.id),
    retained: ["Log Analytics history", "Capture/quarantine archives", "private worker configuration", "Function storage history"],
  });
}
