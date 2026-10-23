import { readFile } from "node:fs/promises";
import { z } from "zod";
import { probeSchema, probeServices, scenarios, testTypes, type Probe } from "./contracts.js";
import { ConfigurationError, loadConfig, teamsCallingCallbackUrlSchema, type Config } from "./config.js";

export const activityFunctions = {
  exchange: ["getConnectivityMetricsForExchange"],
  teams: ["getMessageVolumeMetricsForTeamsChat"],
  sharepoint: [],
} as const;
export const serviceActivitySchema = z.object({
  enabled: z.boolean().default(false),
  aggregationIntervalMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30)]).default(15),
  lookbackMinutes: z.number().int().min(5).max(1440).default(30),
  functions: z.array(z.enum(["getConnectivityMetricsForExchange", "getMessageVolumeMetricsForTeamsChat"])).min(1).max(1).optional(),
}).strict();
const serviceFields = {
  intervalSeconds: z.number().int().min(1).max(86400),
  timeoutSeconds: z.number().int().min(1).max(120),
  mode: z.enum(["simulation", "live"]),
  scenario: z.enum(scenarios).default("healthy"),
  cohort: probeSchema.shape.cohort,
  graphAuthentication: z.enum(["managed-identity", "certificate"]).default("managed-identity"),
  teamsAuthentication: z.enum(["user-delegated", "bot"]).default("bot"),
  botAuthentication: z.enum(["managed-identity", "certificate"]).default("managed-identity"),
  teamsReadbackClientId: z.string().uuid().optional(),
  teamsCallingCallbackUrl: teamsCallingCallbackUrlSchema.optional(),
  teamsCallingPort: z.number().int().min(1024).max(65535).default(8080),
  teamsCallingWaitSeconds: z.number().int().min(1).max(30).default(10),
  teamsCleanupEnabled: z.boolean().default(true),
  exchangeCleanupEnabled: z.boolean().default(true),
  healthReportAuthentication: z.enum(["managed-identity", "certificate"]).default("managed-identity"),
  serviceHealth: z.boolean().default(false),
  serviceActivity: serviceActivitySchema.default({}),
};
const serviceFileSchema = z.object({
  ...serviceFields, type: z.enum(["exchange", "sharepoint", "teams"]),
}).strict();
export type ServiceFileConfig = z.infer<typeof serviceFileSchema>;
const common = {
  ...serviceFields,
  enabled: z.boolean(),
};
const target = probeSchema.pick({ id: true, region: true, scenario: true });
const serviceSchema = z.discriminatedUnion("type", [
  z.object({
    ...common, type: z.literal("exchange"),
    targets: z.array(target.extend({ mailbox: probeSchema.shape.mailbox }).strict()).max(30),
  }).strict(),
  z.object({
    ...common, type: z.literal("sharepoint"),
    targets: z.array(target.extend({
      siteId: probeSchema.shape.siteId, driveId: probeSchema.shape.driveId, folderId: probeSchema.shape.folderId,
    }).strict()).max(30),
  }).strict(),
  z.object({
    ...common, type: z.literal("teams"),
    targets: z.array(target.extend({
      tenantId: probeSchema.shape.tenantId,
      userPrincipalName: probeSchema.shape.userPrincipalName,
      teamId: probeSchema.shape.teamId,
      channelId: probeSchema.shape.channelId,
      serviceUrl: probeSchema.shape.serviceUrl,
    }).strict()).max(30),
    callTargets: z.array(target.extend({
      tenantId: z.string().uuid(), callUserId: z.string().uuid(),
    }).strict()).max(30).default([]),
  }).strict(),
]);
export type ServiceConfig = z.infer<typeof serviceSchema>;

function validateProviderSettings(service: ServiceFileConfig): void {
  if (service.teamsReadbackClientId !== undefined &&
      (service.type !== "teams" || service.teamsAuthentication !== "bot" || service.graphAuthentication !== "managed-identity")) {
    throw new ConfigurationError("teamsReadbackClientId requires Teams bot mode with managed-identity Graph authentication");
  }
  const activity = service.serviceActivity;
  if (activity.lookbackMinutes < activity.aggregationIntervalMinutes ||
      activity.lookbackMinutes % activity.aggregationIntervalMinutes !== 0) {
    throw new ConfigurationError("serviceActivity.lookbackMinutes must be a multiple of aggregationIntervalMinutes, between that interval and 1440");
  }
  const allowed: readonly string[] = activityFunctions[service.type];
  if ((service.type === "sharepoint" && activity.enabled) || activity.functions?.some(name => !allowed.includes(name))) {
    throw new ConfigurationError("Unsupported serviceActivity function for this service; SharePoint has no supported beta collector");
  }
}

export function parseServiceFileConfig(raw: unknown): ServiceFileConfig {
  const parsed = serviceFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid service config fields: ${parsed.error.issues.map(issue => issue.path.join(".") || "(root)").join(", ")}; enabled and targets belong in the root project config`);
  }
  validateProviderSettings(parsed.data);
  return parsed.data;
}

export function parseServiceConfig(raw: unknown): ServiceConfig {
  const parsed = serviceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid service config fields: ${parsed.error.issues.map(issue => issue.path.join(".") || "(root)").join(", ")}`);
  }
  const service = parsed.data;
  if (service.type === "teams" && service.enabled && service.mode === "live" && service.teamsAuthentication === "user-delegated") {
    const tenants = new Set(service.targets.map(item => item.tenantId?.toLowerCase()));
    if (tenants.size > 1) {
      throw new ConfigurationError("Delegated Teams targets must use one tenantId");
    }
  }
  validateProviderSettings(service);
  if (service.enabled && service.targets.length === 0 && (service.type !== "teams" || service.callTargets.length === 0)) {
    throw new ConfigurationError("Enabled service config requires at least one target");
  }
  if (new Set(service.targets.map(item => item.id)).size !== service.targets.length) {
    throw new ConfigurationError("Probe IDs must be unique");
  }
  return service;
}

export async function readServiceConfig(file: string): Promise<ServiceFileConfig> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch { throw new ConfigurationError("Cannot read the service config file"); }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new ConfigurationError("Service config must contain a valid JSON object"); }
  return parseServiceFileConfig(raw);
}

export function serviceProbes(service: ServiceConfig, selectedScenarios?: Readonly<Record<string, boolean>>): Probe[] {
  const supported = testTypes.filter(type => probeServices[type].service === service.type);
  const selected = selectedScenarios
    ? supported.filter(type => selectedScenarios[probeServices[type].journey])
    : supported.slice(0, 1);
  return selected.flatMap(type => (type === "teams-call" && service.type === "teams" ? service.callTargets : service.targets)
    .map(item => ({ ...item, cohort: service.cohort, type })));
}

export function serviceSettings(
  service: ServiceConfig, env: NodeJS.ProcessEnv = process.env, selectedScenarios?: Readonly<Record<string, boolean>>,
): Config {
  if (!service.enabled) throw new ConfigurationError("Disabled configs do not create a runtime");
  if (service.serviceActivity.enabled && env.ENABLE_BETA_SERVICE_ACTIVITY !== "true") {
    throw new ConfigurationError("serviceActivity.enabled requires ENABLE_BETA_SERVICE_ACTIVITY=true (experimental diagnostics only)");
  }
  return loadConfig({
    ...env,
    EXECUTION_MODE: service.mode,
    TEAMS_AUTHENTICATION: service.teamsAuthentication,
    BOT_AUTHENTICATION: service.botAuthentication,
    TEAMS_CALLING_CALLBACK_URL: service.teamsCallingCallbackUrl,
    TEAMS_CALLING_PORT: String(service.teamsCallingPort),
    TEAMS_CALLING_WAIT_SECONDS: String(service.teamsCallingWaitSeconds),
    TEAMS_CLEANUP_ENABLED: String(service.teamsCleanupEnabled),
    EXCHANGE_CLEANUP_ENABLED: String(service.exchangeCleanupEnabled),
    SYNTHETIC_SCENARIO: service.scenario,
    PROBE_TIMEOUT_MS: String(service.timeoutSeconds * 1000),
    PROBES_JSON: JSON.stringify(serviceProbes(service, selectedScenarios)),
  });
}
