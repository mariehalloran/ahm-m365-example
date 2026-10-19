import { readFile } from "node:fs/promises";
import { z } from "zod";
import { probeSchema, scenarios } from "../../shared/src/contracts.js";
import { ConfigurationError, loadConfig, type Config } from "./config.js";

const common = {
  enabled: z.boolean(),
  intervalSeconds: z.number().int().min(1).max(86400),
  timeoutSeconds: z.number().int().min(1).max(120),
  mode: z.enum(["simulation", "live"]),
  scenario: z.enum(scenarios).default("healthy"),
  cohort: probeSchema.shape.cohort,
  telemetry: z.enum(["console", "azure-monitor"]).default("console"),
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
  z.object({ ...common, type: z.literal("teams"), targets: z.array(target.strict()).max(30) }).strict(),
]);
export type ServiceConfig = z.infer<typeof serviceSchema>;

export function parseServiceConfig(raw: unknown): ServiceConfig {
  const parsed = serviceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid service config fields: ${parsed.error.issues.map(issue => issue.path.join(".") || "(root)").join(", ")}`);
  }
  const service = parsed.data;
  if (service.type === "teams" && service.enabled) throw new ConfigurationError("Teams probes are not implemented; keep this config disabled");
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
  if (service.type === "teams") throw new ConfigurationError("Teams probes are not implemented");
  return loadConfig({
    ...env,
    EXECUTION_MODE: service.mode,
    SYNTHETIC_SCENARIO: service.scenario,
    PROBE_TIMEOUT_MS: String(service.timeoutSeconds * 1000),
    PROBES_JSON: JSON.stringify(service.targets.map(item => ({
      ...item, cohort: service.cohort, type: service.type === "exchange" ? "exchange-mail-flow" : "sharepoint-file",
    }))),
  });
}
