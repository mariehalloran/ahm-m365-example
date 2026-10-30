import { z } from "zod";
import { applyBindings, readBindings } from "./bindings.js";
import { ConfigurationError, readConfigJson } from "./config.js";
import { probeServices } from "./contracts.js";
import { executionLanes } from "./execution-lanes.js";
import { resolveGroups, tenantGroups, userGroupTargets, type TenantGroup } from "./groups.js";
import { expandReferences } from "./references.js";
import {
  parseServiceConfig, parseServiceExecution, serviceExecutionSchema, serviceTargetSchemas, teamsCallTargetsSchema,
  type ServiceConfig, type ServiceExecution,
} from "./service-config.js";
import { applicationAccessSchema, deploymentSettingsSchema, workerSettingsSchema } from "./deployment-config.js";
import { canonicalProjectFile } from "./paths.js";

export const serviceTypes = ["exchange", "teams", "onedrive"] as const;
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
  worker: workerSettingsSchema.optional(),
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
    scenarios: scenarioSelection("teams"),
    targets: serviceTargetSchemas.teams,
    callTargets: teamsCallTargetsSchema,
  }).strict(),
  onedrive: z.object({
    ...selection,
    scenarios: scenarioSelection("onedrive"),
    targets: userGroups(serviceTargetSchemas.onedrive),
    setup: z.object({
      authentication: z.enum(["azure-cli", "managed-identity", "certificate"]),
      workerClientId: z.string().uuid(),
      setupClientId: z.string().uuid().optional(),
      certificatePath: z.string().min(1).optional(),
      concurrency: z.number().int().min(1).max(10).default(4),
      targetTimeoutSeconds: z.number().int().min(30).max(3600).default(300),
    }).strict().optional(),
  }).strict(),
}).strict();
const logAnalyticsResourcesSchema = z.object({
  eventHubNamespace: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{4,48}[a-zA-Z0-9]$/),
  eventHubName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}[a-zA-Z0-9]$/),
  functionStorageAccount: z.string().regex(/^[a-z0-9]{3,24}$/),
  functionAppName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{1,58}[a-zA-Z0-9]$/),
  functionPlanName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,58}[a-zA-Z0-9]$/),
  ingestionIdentityName: z.string().regex(/^[a-zA-Z0-9_-]{3,128}$/),
  dataCollectionEndpointName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{1,58}[a-zA-Z0-9]$/),
  dataCollectionRuleName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{1,58}[a-zA-Z0-9]$/),
  captureEnabled: z.boolean().default(false),
  archiveRetentionDays: z.number().int().min(1).max(3650).default(90),
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
    throw new ConfigurationError("Migrate monitoring.config.json from schemaVersion 1.0 to 2.0: declare tenants[] with inline service execution, access and targets; configFile and separate service profiles are no longer supported");
  }
  const parsed = projectDocumentSchema.safeParse(document);
  if (!parsed.success) {
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
  return parseProjectDocument(applyBindings(await readConfigJson(file), await readBindings(file)));
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

export function applyProjectConfig(project: ProjectConfig, service: ServiceExecution): ServiceConfig {
  const selected = project.services[service.type];
  const enabled = selected.enabled && Object.values(selected.scenarios).some(Boolean);
  if (enabled && service.mode === "live") {
    if (project.healthModel.subscriptionId === "00000000-0000-0000-0000-000000000000") {
      throw new ConfigurationError("Live health reports require an approved healthModel.subscriptionId");
    }
    const cycleBudgetSeconds = service.type === "exchange" ? 59 : service.cycleTimeoutSeconds + 42;
    const lanes = executionLanes(service)
      .filter(lane => lane.journeys.some(journey => (selected.scenarios as Record<string, boolean>)[journey]));
    const largeCohort = selected.targets.length > 30 ||
      (service.type === "teams" && project.services.teams.callTargets.length > 30);
    if (service.type === "onedrive" || (largeCohort && service.type !== "exchange")) {
      for (const lane of lanes) {
        const attempts = lane.journeys.filter(journey => (selected.scenarios as Record<string, boolean>)[journey])
          .reduce((sum, journey) => sum + (service.type === "teams" && journey === "scheduled-meeting"
            ? project.services.teams.callTargets.length : selected.targets.length), 0);
        const required = Math.ceil(attempts / service.maxConcurrentProbes) * (lane.timeoutSeconds + 12);
        if (service.cycleTimeoutSeconds < required) {
          const label = service.type === "onedrive" ? "OneDrive" : "Teams";
          throw new ConfigurationError(`${label} lane ${lane.name} needs cycleTimeoutSeconds >= ${required} for ${attempts} attempts at maxConcurrentProbes ${service.maxConcurrentProbes}; increase the budget within the concurrency limit or reduce the cohort`);
        }
      }
    }
    const longestInterval = Math.max(...lanes.map(lane => lane.intervalSeconds));
    const providerBudget = project.serviceHealth.enabled && (service.serviceHealth || service.serviceActivity.enabled)
      ? service.providerIntervalSeconds + 60 : 0;
    if (project.healthModel.signalWindowMinutes * 60 <= Math.max(longestInterval + cycleBudgetSeconds, providerBudget)) {
      throw new ConfigurationError(`Signal window must exceed the service cadence plus the bounded cycle/publication budget (${cycleBudgetSeconds} seconds)`);
    }
  }
  return parseServiceConfig({
    ...service, enabled, targets: selected.targets,
    serviceHealth: project.serviceHealth.enabled && service.serviceHealth,
    serviceActivity: { ...service.serviceActivity, enabled: project.serviceHealth.enabled && service.serviceActivity.enabled },
    ...(service.type === "teams" ? { callTargets: project.services.teams.callTargets } : {}),
  });
}

export async function readProjectService(
  type: ServiceConfig["type"], projectFile: string = canonicalProjectFile, tenantAlias?: string,
): Promise<{ project: ProjectConfig; service: ServiceConfig }> {
  const project = selectTenant(await readProjectDocument(projectFile), tenantAlias);
  return { project, service: serviceExecution(project, type) };
}
