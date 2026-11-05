import { ConfigurationError } from "../configuration/config.js";
import { modelCatalog } from "../catalog.js";
import { reportingGroups } from "../configuration/groups.js";
import {
  parseProjectDocument, selectTenant, serviceExecution, serviceModelName, serviceTypes,
  type ProjectConfig,
} from "../configuration/project-config.js";
import { validateProjectTenantBinding } from "../execution/runtime.js";
import { serviceSettings, type ServiceConfig } from "../configuration/service-config.js";
import { dispatchInventory } from "../../../functions/src/dispatch.js";

export interface ExecutionOwner {
  tenant: string;
  type: ServiceConfig["type"];
  identityResourceId: string;
  project: ProjectConfig;
  service: ServiceConfig;
}

/** Identifies catalogue-owned entities so explicit retirement cannot remove an active journey. */
export function activeServiceInventory(root: string, type: ServiceConfig["type"]) {
  const definition = modelCatalog.serviceDefinitions.find(service => service.service === type)!;
  const model = `${root}-${type}`;
  const groups = [...new Set(definition.journeys.flatMap(journey => "group" in journey ? [journey.group.entityName] : []))];
  return {
    entityNames: new Set([
      model, `${type}-service-health`, ...groups,
      ...definition.journeys.flatMap(journey => [journey.entityName, ...journey.steps.map(step => `${journey.entityName}-${step.name}`)]),
    ]),
  };
}

/** Validates hosted managed-identity execution without performing any setup or Graph mutations. */
function validateHostedAccess(owner: ExecutionOwner): void {
  const { project, service } = owner;
  const settings = project.deployment!;
  if (settings.stage === "foundation" || service.mode !== "live") return;
  const selected = project.services[service.type];
  if (!settings.enableLiveProbes) throw new ConfigurationError("Live execution requires deployment.enableLiveProbes: true");
  if (service.graphAuthentication !== "managed-identity" || service.healthReportAuthentication !== "managed-identity" ||
      Object.values(selected.access).some(value => value !== undefined)) {
    throw new ConfigurationError("Hosted execution uses explicit managed identities only; certificate authentication is local diagnostics only");
  }
  if (service.serviceActivity.enabled && !settings.enableBetaServiceActivity) {
    throw new ConfigurationError("Beta collection requires deployment.enableBetaServiceActivity: true");
  }
  const env = {
    ENABLE_LIVE_M365: "true", ENABLE_BETA_SERVICE_ACTIVITY: settings.enableBetaServiceActivity ? "true" : "false",
    AZURE_TENANT_ID: settings.azureTenantId, AZURE_CLIENT_ID: selected.identityClientId,
    BOT_TENANT_ID: settings.azureTenantId,
  };
  validateProjectTenantBinding(project.tenant, service, env);
  serviceSettings(service, env, selected.scenarios);
  if (service.type === "exchange" && project.services.exchange.scenarios["reply-mail"] &&
      project.services.exchange.targets.some(target => !target.replySeed)) {
    throw new ConfigurationError("SELF-REPLY requires retained self-addressed fixture bindings for every mailbox; run npm run setup:reply-seeds");
  }
  if (service.type === "onedrive" &&
      (project.services.onedrive.scenarios["user-drive-roundtrip"] || project.services.onedrive.scenarios["document-versions"]) &&
      project.services.onedrive.targets.some(target => !target.driveId || !target.folderId)) {
    throw new ConfigurationError("Selected OneDrive folders require generated drive/folder bindings; run npm run onedrive:setup");
  }
  if (service.type === "teams" && project.services.teams.botPairs.some(pair => !pair.botClientId || !pair.botPeerClientId)) {
    throw new ConfigurationError("Every selected Teams bot pair requires its generated managed-identity client IDs; run npm run setup:ids");
  }
  if (service.type === "sharepoint" && service.targets.some(target => !target.siteId ||
      ((project.services.sharepoint.scenarios["document-library-roundtrip"] || project.services.sharepoint.scenarios["document-versions"]) &&
        (!target.driveId || !target.folderId)) || (project.services.sharepoint.scenarios["list-item-lifecycle"] && !target.listId))) {
    throw new ConfigurationError("SharePoint requires discovered selected-site/library/folder/list IDs; run npm run setup:ids -- -SharePointOnly");
  }
}

/** Normalizes one root configuration into models, lane owners and the single project dispatcher. */
export function prepareProjectDeployment(raw: unknown) {
  const document = parseProjectDocument(raw);
  const settings = document.deployment;
  if (!settings) throw new ConfigurationError("Deployment requires the root deployment section");
  if (Number(settings.coordinator.memory.replace("Gi", "")) !== settings.coordinator.cpu * 2) {
    throw new ConfigurationError("The Consumption coordinator requires memory in Gi equal to twice cpu");
  }
  const owners = document.tenants.flatMap(tenant => {
    const project = selectTenant(document, tenant.id);
    return serviceTypes.filter(type => project.services[type].enabled && Object.values(project.services[type].scenarios).some(Boolean))
      .map(type => {
        const identityResourceId = project.services[type].identityResourceId;
        if (!identityResourceId) throw new ConfigurationError("Each selected service requires an explicit execution identity");
        return { tenant: tenant.id, type, identityResourceId, project, service: serviceExecution(project, type) };
      });
  });
  if (!owners.length) throw new ConfigurationError("Deployment requires at least one selected service journey");
  for (const owner of owners) validateHostedAccess(owner);
  const bots = owners.filter(owner => owner.type === "teams").flatMap(owner =>
    owner.project.services.teams.botPairs.flatMap(pair => [pair.botResourceId, pair.botPeerResourceId]));
  if (new Set(bots.map(id => id.toLowerCase())).size !== bots.length) {
    throw new ConfigurationError("Each Teams bot registration requires one tenant/service callback owner");
  }
  for (const entry of settings.retireEntities) {
    if (activeServiceInventory(document.healthModel.name, entry.service).entityNames.has(entry.entityName)) {
      throw new ConfigurationError("Cannot retire an active catalogue entity");
    }
  }
  const groups = reportingGroups(document);
  return {
    document, settings, owners, reportingGroups: groups,
    lanes: dispatchInventory(document, "0".repeat(64)),
    modelNames: [document.healthModel.name, ...serviceTypes.filter(type => owners.some(owner => owner.type === type))
      .map(type => serviceModelName(document, type))],
  };
}
export type PreparedDeployment = ReturnType<typeof prepareProjectDeployment>;

/** Builds an ARM parameter document, never a separate user-maintained deployment profile. */
export function deploymentParameters(values: Record<string, unknown>) {
  return {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    contentVersion: "1.0.0.0",
    parameters: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }])),
  };
}
