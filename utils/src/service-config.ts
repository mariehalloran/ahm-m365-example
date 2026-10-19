import { readFile } from "node:fs/promises";
import { z } from "zod";
import { probeSchema, scenarios } from "./contracts.js";
import { ConfigurationError, loadConfig, type Config } from "./config.js";

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
const common = {
  enabled: z.boolean(),
  intervalSeconds: z.number().int().min(1).max(86400),
  timeoutSeconds: z.number().int().min(1).max(120),
  mode: z.enum(["simulation", "live"]),
  scenario: z.enum(scenarios).default("healthy"),
  cohort: probeSchema.shape.cohort,
  telemetry: z.enum(["console", "azure-monitor"]).default("console"),
  graphAuthentication: z.enum(["managed-identity", "certificate"]).default("managed-identity"),
  serviceHealth: z.boolean().default(false),
  serviceActivity: serviceActivitySchema.default({}),
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
      teamId: probeSchema.shape.teamId,
      channelId: probeSchema.shape.channelId,
      serviceUrl: probeSchema.shape.serviceUrl,
    }).strict()).max(30),
  }).strict(),
]);
export type ServiceConfig = z.infer<typeof serviceSchema>;

export function parseServiceConfig(raw: unknown): ServiceConfig {
  const parsed = serviceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid service config fields: ${parsed.error.issues.map(issue => issue.path.join(".") || "(root)").join(", ")}`);
  }
  const service = parsed.data;
  const activity = service.serviceActivity;
  if (activity.lookbackMinutes < activity.aggregationIntervalMinutes ||
      activity.lookbackMinutes % activity.aggregationIntervalMinutes !== 0) {
    throw new ConfigurationError("serviceActivity.lookbackMinutes must be a multiple of aggregationIntervalMinutes, between that interval and 1440");
  }
  const allowed: readonly string[] = activityFunctions[service.type];
  if ((service.type === "sharepoint" && activity.enabled) || activity.functions?.some(name => !allowed.includes(name))) {
    throw new ConfigurationError("Unsupported serviceActivity function for this service; SharePoint has no supported beta collector");
  }
  if (service.enabled && service.targets.length === 0) throw new ConfigurationError("Enabled service config requires at least one target");
  if (new Set(service.targets.map(item => item.id)).size !== service.targets.length) {
    throw new ConfigurationError("Probe IDs must be unique");
  }
  return service;
}

export async function readServiceConfig(file: string): Promise<ServiceConfig> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch { throw new ConfigurationError("Cannot read the service config file"); }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new ConfigurationError("Service config must contain a valid JSON object"); }
  return parseServiceConfig(raw);
}

export function serviceSettings(service: ServiceConfig, env: NodeJS.ProcessEnv = process.env): Config {
  if (!service.enabled) throw new ConfigurationError("Disabled configs do not create a runtime");
  if (service.serviceActivity.enabled && env.ENABLE_BETA_SERVICE_ACTIVITY !== "true") {
    throw new ConfigurationError("serviceActivity.enabled requires ENABLE_BETA_SERVICE_ACTIVITY=true (experimental diagnostics only)");
  }
  return loadConfig({
    ...env,
    EXECUTION_MODE: service.mode,
    SYNTHETIC_SCENARIO: service.scenario,
    PROBE_TIMEOUT_MS: String(service.timeoutSeconds * 1000),
    PROBES_JSON: JSON.stringify(service.targets.map(item => ({
      ...item,
      cohort: service.cohort,
      type: service.type === "exchange"
        ? "exchange-mail-flow"
        : service.type === "sharepoint"
          ? "sharepoint-file"
          : "teams-channel-message",
    }))),
  });
}
