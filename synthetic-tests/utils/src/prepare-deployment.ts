import { ConfigurationError } from "./config.js";
import { modelCatalog } from "./catalog.js";
import { type DeploymentSettings } from "./deployment-config.js";
import { reportingGroups } from "./groups.js";
import {
  parseProjectDocument, selectTenant, serviceExecution, serviceModelName, serviceTypes,
  type ProjectConfig, type ProjectDocument,
} from "./project-config.js";
import { healthModelResourceId, managedIdentityType } from "./references.js";
import { validateProjectTenantBinding } from "./runtime.js";
import { serviceSettings, type ServiceConfig } from "./service-config.js";

export interface DeploymentWorker {
  tenant: string;
  type: ServiceConfig["type"];
  appName: string;
  identityResourceId: string;
  project: ProjectConfig;
  service: ServiceConfig;
}

export function activeServiceInventory(root: string, type: ServiceConfig["type"]) {
  const definition = modelCatalog.serviceDefinitions.find(service => service.service === type)!;
  const model = `${root}-${type}`;
  const groups = [...new Set(definition.journeys.flatMap(journey => "group" in journey ? [journey.group.entityName] : []))];
  const entityNames = new Set([
    model, `${type}-service-health`, ...groups,
    ...definition.journeys.flatMap(journey => [journey.entityName, ...journey.steps.map(step => `${journey.entityName}-${step.name}`)]),
  ]);
  const relationshipNames = new Set([
    `${model}-to-${type}-service-health`, ...groups.map(group => `${model}-to-${group}`),
    ...definition.journeys.flatMap(journey => [
      `${"group" in journey ? journey.group.entityName : model}-to-${journey.entityName}`,
      ...journey.steps.map(step => `${journey.entityName}-to-${journey.entityName}-${step.name}`),
    ]),
  ]);
  return { entityNames, relationshipNames };
}

function validateAccess(worker: DeploymentWorker, settings: DeploymentSettings): void {
  // The foundation stage deploys no workers and runs before the environment (hence the callback URL) exists.
  if (settings.stage !== "workers") return;
  const { service, project } = worker;
  const selected = project.services[service.type];
  const access = selected.access;
  const live = service.mode === "live";
  const calling = live && service.type === "teams" && project.services.teams.scenarios["scheduled-meeting"];
  if (calling && (service.teamsCallingPort !== 8080 || !service.teamsCallingCallbackUrl)) {
    throw new ConfigurationError("Live Teams meetings require port 8080 and the existing worker's HTTPS callback");
  }
  if (live && service.type === "teams" && project.services.teams.botPairs.some(pair => !pair.botClientId || !pair.botPeerClientId)) {
    throw new ConfigurationError("Live Teams requires generated client IDs for every botPairs identity; run npm run setup:ids");
  }
  const certificate = service.graphAuthentication === "certificate";
  const certificateFields = access.m365ClientId || access.m365TenantId || access.m365CertificateSource ||
    access.m365CertificateSecretUri || access.m365CertificateRevision ||
    access.m365CertificateEnvironmentVariable || access.m365CertificatePath;
  if (!certificate && certificateFields) throw new ConfigurationError("M365 certificate references require graphAuthentication: certificate");
  if (certificate && live) {
    const native = access.m365CertificateSource === "container-app";
    if (!access.m365TenantId || !access.m365ClientId ||
        (native ? !access.m365CertificateEnvironmentVariable || !access.m365CertificateRevision || access.m365CertificateSecretUri
          : !access.m365CertificateSecretUri || access.m365CertificateEnvironmentVariable || access.m365CertificateRevision)) {
      throw new ConfigurationError("Hosted Graph certificates require explicit M365 tenant/client and exactly one complete Key Vault or environment-referenced native certificate source");
    }
  }
  if (!live) return;
  if (!settings.enableLiveProbes) throw new ConfigurationError("Live execution requires deployment.enableLiveProbes: true");
  if (!selected.worker?.identityResourceId) throw new ConfigurationError("Live workers must bind an existing approved worker.identity; deployment never grants Graph access");
  if (service.healthReportAuthentication !== "managed-identity") throw new ConfigurationError("Hosted workers require healthReportAuthentication: managed-identity");
  if (service.serviceActivity.enabled && !settings.enableBetaServiceActivity) {
    throw new ConfigurationError("Beta collection requires deployment.enableBetaServiceActivity: true");
  }
  const identity = selected.worker.identityClientId ?? "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const env = {
    ENABLE_LIVE_M365: "true", ENABLE_BETA_SERVICE_ACTIVITY: settings.enableBetaServiceActivity ? "true" : "false",
    AZURE_TENANT_ID: settings.azureTenantId, AZURE_CLIENT_ID: identity,
    BOT_TENANT_ID: settings.azureTenantId,
    M365_TENANT_ID: access.m365TenantId ?? settings.azureTenantId,
  };
  validateProjectTenantBinding(project.tenant, service, env);
  serviceSettings(service, env, selected.scenarios);
  if (service.type === "exchange" && project.services.exchange.scenarios["reply-mail"] &&
      project.services.exchange.targets.some(target => !target.replySeed)) {
    throw new ConfigurationError("Live SELF-REPLY requires retained received self-addressed replySeed bindings for every selected mailbox; run npm run setup:reply-seeds (it writes them to .env); re-provision incompatible paired seeds before upgrading");
  }
  if (service.type === "onedrive" &&
      (project.services.onedrive.scenarios["user-drive-roundtrip"] || project.services.onedrive.scenarios["document-versions"]) &&
      project.services.onedrive.targets.some(target => !target.driveId || !target.folderId)) {
    throw new ConfigurationError("Live OneDrive selected-folder journeys require approved driveId/folderId bindings; run npm run onedrive:setup (it writes them to .env)");
  }
}

function deploymentWorker(document: ProjectDocument, project: ProjectConfig, type: ServiceConfig["type"]): DeploymentWorker {
  const hosting = project.services[type].worker;
  if (!hosting || Boolean(hosting.identityName) === Boolean(hosting.identityResourceId)) {
    throw new ConfigurationError("Each deployed tenant/service requires worker.appName and exactly one of worker.identity or worker.identityName");
  }
  if (Number(hosting.memory.replace("Gi", "")) !== hosting.cpu * 2) {
    throw new ConfigurationError("Consumption workers require memory in Gi equal to twice cpu");
  }
  const identityResourceId = hosting.identityResourceId ??
    healthModelResourceId(document.healthModel, managedIdentityType, hosting.identityName!);
  return {
    tenant: project.tenant.id, type, appName: hosting.appName, identityResourceId, project,
    service: serviceExecution(project, type),
  };
}

// One worker per tenant and service that has an enabled scenario; it runs the tenant's whole inventory.
function deploymentWorkers(document: ProjectDocument, settings: DeploymentSettings): DeploymentWorker[] {
  const workers = document.tenants.flatMap(tenant => {
    const project = selectTenant(document, tenant.id);
    return serviceTypes
      .filter(type => project.services[type].enabled && Object.values(project.services[type].scenarios).some(Boolean))
      .map(type => deploymentWorker(document, project, type));
  });
  for (const worker of workers) validateAccess(worker, settings);
  if (new Set(workers.map(worker => worker.appName)).size !== workers.length) {
    throw new ConfigurationError("Worker appName values must be unique across tenant/service execution owners");
  }
  const bots = workers.filter(worker => worker.type === "teams").flatMap(worker =>
    worker.project.services.teams.botPairs.flatMap(pair => [pair.botResourceId, pair.botPeerResourceId]));
  if (new Set(bots.map(id => id.toLowerCase())).size !== bots.length) {
    throw new ConfigurationError("Each approved Teams bot must have exactly one tenant/service callback owner");
  }
  return workers;
}

export function prepareProjectDeployment(raw: unknown, workerImage?: string) {
  const document = parseProjectDocument(raw);
  const settings = document.deployment;
  if (!settings) throw new ConfigurationError("Deployment requires the deployment section in monitoring.config.json");
  if (workerImage !== undefined && !/^.+@sha256:[a-f0-9]{64}$/.test(workerImage)) {
    throw new ConfigurationError("Worker images must be pinned by immutable sha256 digest");
  }
  const workers = deploymentWorkers(document, settings);
  for (const entry of settings.retireEntities) {
    if (activeServiceInventory(document.healthModel.name, entry.service).entityNames.has(entry.entityName)) {
      throw new ConfigurationError("Cannot retire an entity still supported by the source catalogue");
    }
  }
  const parameters = (values: Record<string, unknown>) => ({
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    contentVersion: "1.0.0.0",
    parameters: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }])),
  });
  const groups = reportingGroups(document);
  return {
    document, settings, workers, reportingGroups: groups,
    modelNames: [document.healthModel.name, ...serviceTypes.filter(type => workers.some(worker => worker.type === type))
      .map(type => serviceModelName(document, type))],
    healthParameters: parameters({
      projectConfig: document, reportingGroups: groups, location: settings.healthModelLocation ?? settings.location,
      workspaceName: settings.workspaceName ?? `law-${document.healthModel.name}`,
      applicationInsightsName: settings.applicationInsightsName ?? `appi-${document.healthModel.name}`,
    }),
    workerParameters: parameters({
      projectConfig: document, location: settings.location,
      deployWorkers: settings.stage === "workers", workerImage: workerImage ?? "",
    }),
  };
}
export type PreparedDeployment = ReturnType<typeof prepareProjectDeployment>;
