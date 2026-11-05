import { z } from "zod";
import { dirname, resolve } from "node:path";
import { applyBindings, readBindings } from "./bindings.js";
import { ConfigurationError, readConfigJson } from "./config.js";
import { probeServices } from "../contracts.js";
import { executionLanes } from "../execution/execution-lanes.js";
import { resolveGroups, tenantGroups, userGroupTargets, type TenantGroup } from "./groups.js";
import { expandReferences } from "./references.js";
import { isRecord, records } from "./raw-config.js";
import {
  hasProviderSources, parseServiceConfig, parseServiceExecution, serviceExecutionSchema, serviceTargetSchemas, teamsCallTargetsSchema, validateTeamsBotPairs,
  type ServiceConfig, type ServiceExecution,
} from "./service-config.js";
import { applicationAccessSchema, deploymentSettingsSchema, managedIdentityResourceId, teamsBotPairSchema } from "./deployment-config.js";
import { canonicalProjectFile } from "../paths.js";
import { sharePointTargetId } from "./sharepoint-target.js";

export const serviceTypes = ["exchange", "teams", "onedrive", "sharepoint"] as const;
const serviceTypeSchema = z.enum(serviceTypes);
type ServiceJourney<S extends ServiceConfig["type"]> =
  Extract<(typeof probeServices)[keyof typeof probeServices], { service: S }>["journey"];
function scenarioSelection<S extends ServiceConfig["type"]>(service: S) {
  const shape = Object.fromEntries(Object.values(probeServices)
    .filter(journey => journey.service === service)
    .map(journey => [journey.journey, z.boolean().default(true)])) as {
      [Journey in ServiceJourney<S>]: z.ZodDefault<z.ZodBoolean>;
    };
  const scenarios = z.object(shape).strict();
  // Every scenario of a service is on unless the config turns it off, so the whole block may be omitted.
  return scenarios.default({} as z.input<typeof scenarios>);
}
const selection = {
  enabled: z.boolean().default(true),
  execution: serviceExecutionSchema,
  access: applicationAccessSchema.default({}),
  identityResourceId: managedIdentityResourceId.optional(),
  identityClientId: z.string().uuid().optional(),
};
const actionGroupResourceId = z.string().trim().regex(
  /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[a-z0-9_().-]{1,90}\/providers\/Microsoft\.Insights\/actionGroups\/[^\x00-\x1f<>%&\\/?#]{0,259}[^\x00-\x1f<>%&\\/?# .]$/i,
);
const healthModelSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{1,31}[a-zA-Z0-9]$/),
  subscriptionId: z.string().uuid(),
  resourceGroup: z.string().regex(/^[a-zA-Z0-9_().-]{1,90}$/).refine(value => !value.endsWith(".")),
  alertActionGroupIds: z.array(actionGroupResourceId).max(5).default([]),
  signalWindowMinutes: z.number().int().min(1).max(10080),
  minimumSamples: z.number().int().min(1).max(1000000).default(1),
  successDegradedPercent: z.number().min(0).max(100),
  successUnhealthyPercent: z.number().min(0).max(100),
  latencyDegradedMilliseconds: z.number().int().nonnegative(),
  latencyUnhealthyMilliseconds: z.number().int().nonnegative(),
}).strict();
const slug = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(40);
const displayName = z.string().trim().min(1).max(260);
const groupId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*$/).max(40);
function userGroups<T extends z.AnyZodObject>(users: z.ZodArray<T>) {
  return z.record(groupId, z.object({ userGroupName: displayName, users }).strict());
}
const tenantServicesSchema = z.object({
  exchange: z.object({
    ...selection,
    scenarios: scenarioSelection("exchange"),
    targets: userGroups(serviceTargetSchemas.exchange),
  }).strict(),
  teams: z.object({
    ...selection,
    botPairs: z.array(teamsBotPairSchema).max(1000).default([]),
    scenarios: scenarioSelection("teams"),
    targets: serviceTargetSchemas.teams,
    callTargets: teamsCallTargetsSchema,
  }).strict(),
  onedrive: z.object({
    ...selection,
    scenarios: scenarioSelection("onedrive"),
    targets: userGroups(serviceTargetSchemas.onedrive),
    setup: z.object({
      identityResourceId: managedIdentityResourceId,
      concurrency: z.number().int().min(1).max(10).default(4),
      targetTimeoutSeconds: z.number().int().min(30).max(3600).default(300),
    }).strict().optional(),
  }).strict(),
  sharepoint: z.object({
    ...selection,
    scenarios: scenarioSelection("sharepoint"),
    targets: serviceTargetSchemas.sharepoint,
  }).strict(),
}).strict();
const logAnalyticsResourcesSchema = z.object({
  dataCollectionEndpointName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{1,58}[a-zA-Z0-9]$/),
  dataCollectionRuleName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{1,58}[a-zA-Z0-9]$/),
});
export const projectDocumentSchema = z.object({
  schemaVersion: z.literal("2.0"),
  healthModel: healthModelSchema,
  logAnalytics: z.discriminatedUnion("enabled", [
    logAnalyticsResourcesSchema.extend({ enabled: z.literal(true) }).strict(),
    logAnalyticsResourcesSchema.partial().extend({ enabled: z.literal(false) }).strict(),
  ]).default({ enabled: false }),
  deployment: deploymentSettingsSchema.optional(),
  serviceHealth: z.object({
    enabled: z.boolean().default(false),
  }).strict().default({}),
  tenants: z.array(z.object({
    id: slug, displayName, tenantId: z.string().uuid(), services: tenantServicesSchema,
    $comment: z.string().optional(),
  }).strict()).min(1),
}).strict();
export type ProjectDocument = z.infer<typeof projectDocumentSchema>;

const serviceFileMapSchema = z.object({
  exchange: z.string().trim().min(1),
  teams: z.string().trim().min(1),
  onedrive: z.string().trim().min(1),
  sharepoint: z.string().trim().min(1),
}).strict();
const projectServiceFileSchema = z.object({
  schemaVersion: z.literal("2.0"),
  service: serviceTypeSchema,
  tenants: z.array(z.object({
    id: slug,
    config: z.unknown(),
  }).strict()).default([]),
}).strict();

type ServiceFileEntry = z.infer<typeof projectServiceFileSchema>["tenants"][number];

async function composeServiceFiles(raw: unknown, file: string): Promise<unknown> {
  const document = structuredClone(raw);
  if (!isRecord(document) || !isRecord(document.serviceFiles)) return document;
  const serviceFiles = serviceFileMapSchema.safeParse(document.serviceFiles);
  if (!serviceFiles.success) throw new ConfigurationError("serviceFiles must map exchange, teams, onedrive and sharepoint to JSON config paths");
  const tenants = records(document.tenants);
  if (tenants.some(tenant => tenant.services !== undefined)) {
    throw new ConfigurationError("When serviceFiles is configured, remove tenants[].services from monitoring.config.json");
  }
  const tenantIds = tenants.map(tenant => tenant.id).filter((id): id is string => typeof id === "string");
  if (tenantIds.length !== tenants.length) throw new ConfigurationError("Each main tenant entry must include a valid id when serviceFiles is configured");
  if (new Set(tenantIds).size !== tenantIds.length) throw new ConfigurationError("Main tenant ids must be unique when serviceFiles is configured");
  const serviceEntries = {} as Record<ServiceConfig["type"], Map<string, ServiceFileEntry["config"]>>;
  for (const service of serviceTypes) {
    const path = resolve(dirname(file), serviceFiles.data[service]);
    const parsed = projectServiceFileSchema.safeParse(await readConfigJson(path));
    if (!parsed.success || parsed.data.service !== service) {
      throw new ConfigurationError(`Invalid ${service} service file at ${serviceFiles.data[service]}: expected schemaVersion 2.0 and service '${service}'`);
    }
    const ids = parsed.data.tenants.map(tenant => tenant.id);
    if (new Set(ids).size !== ids.length) throw new ConfigurationError(`Service file ${serviceFiles.data[service]} has duplicate tenant ids`);
    const unknownTenant = ids.find(id => !tenantIds.includes(id));
    if (unknownTenant) throw new ConfigurationError(`Service file ${serviceFiles.data[service]} includes unknown tenant id '${unknownTenant}'`);
    serviceEntries[service] = new Map(parsed.data.tenants.map(tenant => [tenant.id, tenant.config]));
  }
  for (const tenant of tenants) {
    const id = tenant.id as string;
    const services: Record<string, unknown> = {};
    for (const service of serviceTypes) {
      const config = serviceEntries[service].get(id);
      if (config === undefined) {
        throw new ConfigurationError(`Tenant '${id}' is missing in ${serviceFiles.data[service]}`);
      }
      services[service] = config;
    }
    tenant.services = services;
  }
  delete document.serviceFiles;
  return document;
}
type TenantInventory = ProjectDocument["tenants"][number];
type ProjectServices = {
  [Service in ServiceConfig["type"]]: Omit<TenantInventory["services"][Service], "targets"> & {
    targets: Extract<ServiceConfig, { type: Service }>["targets"];
  };
};
/** One tenant's runtime view, with user targets flattened once and group membership kept separately. */
export type ProjectConfig = Omit<ProjectDocument, "tenants"> & {
  tenant: Pick<TenantInventory, "id" | "displayName" | "tenantId">;
  /** True when the document has several tenants; overall signals are then published as tenant-<alias>--<signal>. */
  multiTenant: boolean;
  services: ProjectServices;
  groups: TenantGroup[];
};

function runtimeServices(services: TenantInventory["services"]): ProjectServices {
  return {
    exchange: { ...services.exchange, targets: userGroupTargets(services.exchange.targets) },
    teams: services.teams,
    onedrive: { ...services.onedrive, targets: userGroupTargets(services.onedrive.targets) },
    sharepoint: { ...services.sharepoint, targets: services.sharepoint.targets.map(target => ({
      ...target, id: sharePointTargetId(target),
    })) },
  };
}

function validateHealthPolicy(policy: ProjectDocument["healthModel"]): void {
  if (policy.successUnhealthyPercent > policy.successDegradedPercent ||
      policy.latencyUnhealthyMilliseconds < policy.latencyDegradedMilliseconds) {
    throw new ConfigurationError("Health thresholds must order Degraded before Unhealthy");
  }
  if (new Set(policy.alertActionGroupIds.map(id => id.toLowerCase())).size !== policy.alertActionGroupIds.length) {
    throw new ConfigurationError("healthModel.alertActionGroupIds must contain unique action group resource IDs (case-insensitive)");
  }
}

function validateServiceSelection(services: ProjectConfig["services"], tenantId: string): void {
  const teams = services.teams;
  const onedrive = services.onedrive;
  if (Object.values(services.sharepoint.access).some(value => value !== undefined)) {
    throw new ConfigurationError("SharePoint uses the explicitly selected managed identity, not certificate or secret access references");
  }
  validateTeamsBotPairs(teams);
  if (new Set(services.exchange.targets.map(target => target.mailbox.toLowerCase())).size !== services.exchange.targets.length) {
    throw new ConfigurationError("Exchange targets must identify unique independent mailboxes");
  }
  for (const field of ["userId", "userPrincipalName", "driveId"] as const) {
    const values = onedrive.targets.flatMap(item => item[field] ? [item[field]!.toLowerCase()] : []);
    if (new Set(values).size !== values.length) throw new ConfigurationError("OneDrive accounts and drives must be unique");
  }
  if (teams.enabled && teams.scenarios["scheduled-meeting"] && teams.callTargets.length === 0) {
    throw new ConfigurationError("Enabled scheduled-meeting requires root-configured callTargets");
  }
  if (new Set(teams.callTargets.map(item => item.id)).size !== teams.callTargets.length ||
      new Set(teams.callTargets.map(item => `${item.tenantId.toLowerCase()}:${item.meetingThreadId}`)).size !== teams.callTargets.length) {
    throw new ConfigurationError("Call target IDs and dedicated meetings must be unique");
  }
  if ([...teams.targets, ...teams.callTargets].some(target =>
    target.tenantId !== undefined && target.tenantId.toLowerCase() !== tenantId.toLowerCase())) {
    throw new ConfigurationError("Teams targets must belong to their root inventory tenant UUID");
  }
  for (const selected of Object.values(services)) {
    if (new Set(selected.targets.map(item => item.id)).size !== selected.targets.length) {
      throw new ConfigurationError("Project target IDs must be unique within each service");
    }
    const needsMessageTargets = selected !== teams || teams.scenarios["channel-conversation"];
    if (selected.enabled && Object.values(selected.scenarios).some(Boolean) && needsMessageTargets && selected.targets.length === 0) {
      throw new ConfigurationError("Enabled project scenarios require at least one target");
    }
  }
}

function validateTenants(tenants: ProjectDocument["tenants"]): void {
  if (new Set(tenants.map(tenant => tenant.id)).size !== tenants.length ||
      new Set(tenants.map(tenant => tenant.tenantId.toLowerCase())).size !== tenants.length) {
    throw new ConfigurationError("Tenant aliases and tenant UUIDs must be unique in the root inventory");
  }
  for (const tenant of tenants) {
    validateServiceSelection(runtimeServices(tenant.services), tenant.tenantId);
    for (const type of serviceTypes) parseServiceExecution({ ...tenant.services[type].execution, type });
  }
}

export function parseProjectDocument(raw: unknown): ProjectDocument {
  const document = expandReferences(raw);
  if (document && typeof document === "object" && "schemaVersion" in document && document.schemaVersion === "1.0") {
    throw new ConfigurationError("Migrate monitoring.config.json from schemaVersion 1.0 to 2.0 with tenant inventory and service execution settings");
  }
  const parsed = projectDocumentSchema.safeParse(document);
  if (!parsed.success) {
    if (parsed.error.issues.some(issue => issue.code === "unrecognized_keys" &&
        issue.keys.some(key => ["bot", "peerBot", "peerIdentity", "botResourceId", "botPeerResourceId", "botPeerManagedIdentityResourceId", "botPeerClientId"].includes(key)))) {
      throw new ConfigurationError("Move service-wide Teams bot access into teams.botPairs: each named pair needs bot, identity, peerBot and peerIdentity; run npm run setup:ids to generate both client ID bindings");
    }
    if (parsed.error.issues.some(issue => issue.code === "unrecognized_keys" && issue.keys.includes("groups"))) {
      throw new ConfigurationError("Move user groups into Exchange and OneDrive targets as keyed { userGroupName, users } entries; root groups and Teams user groups are not supported");
    }
    if (parsed.error.issues.some(issue => issue.code === "unrecognized_keys" &&
        issue.keys.some(key => ["recipientMailbox", "distributionList", "distribution-list-mail", "meeting-invitation"].includes(key)))) {
      throw new ConfigurationError("Obsolete Exchange pair/distribution/meeting configuration: use one { id, mailbox } target per unique user and only the five supported single-user journeys; re-provision retained SELF-REPLY seeds");
    }
    if (parsed.error.issues.some(issue => issue.code === "unrecognized_keys" && issue.keys.includes("attachment-reply-mail"))) {
      throw new ConfigurationError("Obsolete attachment-reply-mail: select attachment-mail and reply-mail separately, then provision root-owned replySeed bindings");
    }
    if (parsed.error.issues.some(issue => issue.code === "unrecognized_keys" && issue.keys.includes("callUserId"))) {
      throw new ConfigurationError("Obsolete callUserId: use dedicated meetingThreadId, organizerUserId owner metadata and peerBotClientId; no human-calling compatibility path");
    }
    throw new ConfigurationError(`Invalid project config fields: ${parsed.error.issues.map(issue => issue.path.join(".") || "(root)").join(", ")}`);
  }
  validateHealthPolicy(parsed.data.healthModel);
  validateTenants(parsed.data.tenants);
  resolveGroups(parsed.data);
  return parsed.data;
}

export async function readProjectDocument(file: string): Promise<ProjectDocument> {
  return parseProjectDocument(applyBindings(await composeServiceFiles(await readConfigJson(file), file), await readBindings(file)));
}

/** The alias may be omitted only when the document has exactly one tenant. */
export function selectTenant(document: ProjectDocument, alias?: string): ProjectConfig {
  if (alias === undefined && document.tenants.length > 1) {
    throw new ConfigurationError("Select one tenant with --tenant <alias>; the root configuration has more than one");
  }
  const tenant = document.tenants.find(tenant => alias === undefined || tenant.id === alias);
  if (!tenant) throw new ConfigurationError("Unknown --tenant alias in the root inventory");
  const { tenants: _tenants, ...shared } = document;
  return {
    ...shared, services: runtimeServices(tenant.services), groups: tenantGroups(document, tenant.id),
    tenant: { id: tenant.id, displayName: tenant.displayName, tenantId: tenant.tenantId },
    multiTenant: document.tenants.length > 1,
  };
}

export function serviceModelName(project: { healthModel: { name: string } }, service: ServiceConfig["type"]): string {
  return `${project.healthModel.name}-${service}`;
}

export function serviceExecution(project: ProjectConfig, type: ServiceConfig["type"]): ServiceConfig {
  return applyProjectConfig(project, parseServiceExecution({ ...project.services[type].execution, type }));
}

/** Combines selected targets with validated lane, capacity and signal-freshness budgets. */
export function applyProjectConfig(project: ProjectConfig, service: ServiceExecution): ServiceConfig {
  const selected = project.services[service.type];
  const enabled = selected.enabled && Object.values(selected.scenarios).some(Boolean);
  if (enabled && service.mode === "live") {
    if (project.healthModel.subscriptionId === "00000000-0000-0000-0000-000000000000") {
      throw new ConfigurationError("Live health reports require an approved healthModel.subscriptionId");
    }
    const lanes = executionLanes(service)
      .filter(lane => lane.journeys.some(journey => (selected.scenarios as Record<string, boolean>)[journey]));
    const pairCount = service.type === "teams" ? project.services.teams.botPairs.length : 1;
    if (service.type !== "exchange") {
      for (const lane of lanes) {
        const attempts = pairCount * lane.journeys.filter(journey => (selected.scenarios as Record<string, boolean>)[journey])
          .reduce((sum, journey) => sum + (service.type === "teams" && journey === "scheduled-meeting"
            ? project.services.teams.callTargets.length : selected.targets.length), 0);
        const waves = Math.ceil(attempts / service.maxConcurrentProbes);
        const required = waves * lane.timeoutSeconds + Math.max(0, waves - 1) * service.cleanupGraceSeconds;
        if (service.cycleTimeoutSeconds < required) {
          const label = service.type === "onedrive" ? "OneDrive" : service.type === "sharepoint" ? "SharePoint" : "Teams";
          throw new ConfigurationError(`${label} lane ${lane.name} needs cycleTimeoutSeconds >= ${required} for ${attempts} attempts at maxConcurrentProbes ${service.maxConcurrentProbes}; increase concurrency or the configured interval and budgets`);
        }
      }
    }
    const longestInterval = Math.max(...lanes.map(lane => lane.intervalSeconds));
    const cycleBudgetSeconds = service.cycleTimeoutSeconds + service.cleanupGraceSeconds + service.publicationTimeoutSeconds;
    const providerBudget = project.serviceHealth.enabled && hasProviderSources(service)
      ? service.providerIntervalSeconds * 2 : 0;
    if (project.healthModel.signalWindowMinutes * 60 <= Math.max(longestInterval + cycleBudgetSeconds, providerBudget)) {
      throw new ConfigurationError(`Signal window must exceed the service cadence plus the bounded cycle/publication budget (${cycleBudgetSeconds} seconds)`);
    }
  }
  return parseServiceConfig({
    ...service, enabled, targets: selected.targets,
    serviceHealth: project.serviceHealth.enabled && service.serviceHealth,
    serviceMessages: project.serviceHealth.enabled && service.serviceMessages,
    serviceActivity: { ...service.serviceActivity, enabled: project.serviceHealth.enabled && service.serviceActivity.enabled },
    ...(service.type === "teams" ? {
      botPairs: project.services.teams.botPairs, callTargets: project.services.teams.callTargets,
    } : {}),
  });
}

export async function readProjectService(
  type: ServiceConfig["type"], projectFile: string = canonicalProjectFile, tenantAlias?: string,
): Promise<{ project: ProjectConfig; service: ServiceConfig }> {
  const project = selectTenant(await readProjectDocument(projectFile), tenantAlias);
  return { project, service: serviceExecution(project, type) };
}
