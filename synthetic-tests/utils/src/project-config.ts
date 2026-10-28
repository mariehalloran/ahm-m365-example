import { z } from "zod";
import { ConfigurationError, readConfigJson } from "./config.js";
import { probeSchema, probeServices } from "./contracts.js";
import { executionLanes } from "./execution-lanes.js";
import { resolveGroups, tenantGroups, type TenantGroup } from "./groups.js";
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
  return z.object(shape).strict();
}
const selection = {
  enabled: z.boolean().default(true),
  execution: serviceExecutionSchema,
  access: applicationAccessSchema.default({}),
  worker: workerSettingsSchema.optional(),
};
const healthModelSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{1,31}[a-zA-Z0-9]$/),
  subscriptionId: z.string().uuid(),
  resourceGroup: z.string().regex(/^[a-zA-Z0-9_().-]{1,90}$/).refine(value => !value.endsWith(".")),
  reportTtlMinutes: z.number().int().min(1).max(10080),
  successDegradedPercent: z.number().min(0).max(100),
  successUnhealthyPercent: z.number().min(0).max(100),
  latencyDegradedMilliseconds: z.number().int().nonnegative(),
  latencyUnhealthyMilliseconds: z.number().int().nonnegative(),
}).strict();
const slug = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(40);
const displayName = z.string().trim().min(1).max(260);
const tenantServicesSchema = z.object({
  exchange: z.object({
    ...selection,
    scenarios: scenarioSelection("exchange"),
    targets: serviceTargetSchemas.exchange,
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
    targets: serviceTargetSchemas.onedrive,
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
const groupSchema = z.object({
  id: slug, displayName, description: displayName.optional(),
  accounts: z.array(z.string().trim().email()).default([]),
  teams: z.array(probeSchema.shape.id).default([]),
}).strict();
export const projectDocumentSchema = z.object({
  schemaVersion: z.literal("2.0"),
  healthModel: healthModelSchema,
  deployment: deploymentSettingsSchema.optional(),
  otel: z.object({
    enabled: z.boolean().default(false),
    destination: z.enum(["console", "azure-monitor"]).default("console"),
  }).strict().default({}),
  serviceHealth: z.object({
    enabled: z.boolean().default(false),
  }).strict().default({}),
  tenants: z.array(z.object({
    id: slug, displayName, tenantId: z.string().uuid(), services: tenantServicesSchema,
  }).strict()).min(1),
  groups: z.array(groupSchema).default([]),
}).strict();
export type ProjectDocument = z.infer<typeof projectDocumentSchema>;
type TenantInventory = ProjectDocument["tenants"][number];
/** One tenant's view of the document: its inventory plus the groups that have members in it. */
export type ProjectConfig = Omit<ProjectDocument, "tenants" | "groups"> & {
  tenant: Pick<TenantInventory, "id" | "displayName" | "tenantId">;
  /** True when the document has several tenants; overall signals are then published as tenant-<alias>--<signal>. */
  multiTenant: boolean;
  services: TenantInventory["services"];
  groups: TenantGroup[];
};

function validateHealthPolicy(policy: ProjectDocument["healthModel"]): void {
  if (policy.successUnhealthyPercent > policy.successDegradedPercent ||
      policy.latencyUnhealthyMilliseconds < policy.latencyDegradedMilliseconds) {
    throw new ConfigurationError("Health thresholds must order Degraded before Unhealthy");
  }
}

function validateServiceSelection(services: ProjectConfig["services"], tenantId: string): void {
  const teams = services.teams;
  const onedrive = services.onedrive;
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
    validateServiceSelection(tenant.services, tenant.tenantId);
    for (const type of serviceTypes) parseServiceExecution({ ...tenant.services[type].execution, type });
  }
}

export function parseProjectDocument(raw: unknown): ProjectDocument {
  if (raw && typeof raw === "object" && "schemaVersion" in raw && raw.schemaVersion === "1.0") {
    throw new ConfigurationError("Migrate monitoring.config.json from schemaVersion 1.0 to 2.0: declare tenants[] with inline service execution, access and targets; configFile and separate service profiles are no longer supported");
  }
  const parsed = projectDocumentSchema.safeParse(raw);
  if (!parsed.success) {
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
  return parseProjectDocument(await readConfigJson(file));
}

/** The alias may be omitted only when the document has exactly one tenant. */
export function selectTenant(document: ProjectDocument, alias?: string): ProjectConfig {
  if (alias === undefined && document.tenants.length > 1) {
    throw new ConfigurationError("Select one tenant with --tenant <alias>; the root configuration has more than one");
  }
  const tenant = document.tenants.find(tenant => alias === undefined || tenant.id === alias);
  if (!tenant) throw new ConfigurationError("Unknown --tenant alias in the root inventory");
  const { tenants: _tenants, groups: _groups, ...shared } = document;
  return {
    ...shared, services: tenant.services, groups: tenantGroups(document, tenant.id),
    tenant: { id: tenant.id, displayName: tenant.displayName, tenantId: tenant.tenantId },
    multiTenant: document.tenants.length > 1,
  };
}

export function serviceModelName(project: { healthModel: { name: string } }, service: ServiceConfig["type"]): string {
  return `${project.healthModel.name}-${service}`;
}

// Setup write-backs edit the user's original JSON, never the default-expanded normalization.
export function rawTenantServices(raw: unknown, alias: string): TenantInventory["services"] {
  const tenant = (raw as ProjectDocument).tenants.find(tenant => tenant.id === alias);
  if (!tenant) throw new ConfigurationError("Unknown --tenant alias in the root inventory");
  return tenant.services;
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
    // Allow 12 seconds for cleanup, 30 for reports, and optionally 12 for OTEL.
    const cycleBudgetSeconds = service.cycleTimeoutSeconds + (project.otel.enabled ? 54 : 42);
    const lanes = executionLanes(service)
      .filter(lane => lane.journeys.some(journey => (selected.scenarios as Record<string, boolean>)[journey]));
    const largeCohort = selected.targets.length > 30 ||
      (service.type === "teams" && project.services.teams.callTargets.length > 30);
    if (service.type === "onedrive" || largeCohort) {
      for (const lane of lanes) {
        const attempts = lane.journeys.filter(journey => (selected.scenarios as Record<string, boolean>)[journey])
          .reduce((sum, journey) => sum + (service.type === "teams" && journey === "scheduled-meeting"
            ? project.services.teams.callTargets.length : selected.targets.length), 0);
        const required = Math.ceil(attempts / service.maxConcurrentProbes) * (lane.timeoutSeconds + 12);
        if (service.cycleTimeoutSeconds < required) {
          const label = service.type === "onedrive" ? "OneDrive" : service.type === "exchange" ? "Exchange" : "Teams";
          throw new ConfigurationError(`${label} lane ${lane.name} needs cycleTimeoutSeconds >= ${required} for ${attempts} attempts at maxConcurrentProbes ${service.maxConcurrentProbes}; increase the budget within the concurrency limit or reduce the cohort`);
        }
      }
    }
    const longestInterval = Math.max(...lanes.map(lane => lane.intervalSeconds));
    const providerBudget = project.serviceHealth.enabled && (service.serviceHealth || service.serviceActivity.enabled)
      ? service.providerIntervalSeconds + (project.otel.enabled ? 72 : 60) : 0;
    if (project.healthModel.reportTtlMinutes * 60 <= Math.max(longestInterval + cycleBudgetSeconds, providerBudget)) {
      throw new ConfigurationError(`Health report TTL must exceed the service cadence plus the bounded cycle/report budget (${cycleBudgetSeconds} seconds)`);
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
