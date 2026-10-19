import { createHash } from "node:crypto";
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
  reportToHealthModel: z.boolean().default(false),
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
  const config = loadConfig({
    ...env,
    EXECUTION_MODE: service.mode,
    SYNTHETIC_SCENARIO: service.scenario,
    PROBE_TIMEOUT_MS: String(service.timeoutSeconds * 1000),
    PROBES_JSON: JSON.stringify(service.targets.map(item => ({
      ...item, cohort: service.cohort, type: service.type === "exchange" ? "exchange-mail-flow" : "sharepoint-file",
    }))),
    ...(!service.reportToHealthModel ? { AHM_MODEL_ID: undefined, AHM_API_VERSION: undefined, STATE_STORAGE_URL: undefined } : {}),
  });
  if (service.reportToHealthModel) {
    if (!config.AHM_MODEL_ID) throw new ConfigurationError("reportToHealthModel=true requires explicit AHM_MODEL_ID");
    const minimumTtl = service.intervalSeconds + service.timeoutSeconds + 90;
    if (config.REPORT_TTL_SECONDS < minimumTtl) {
      throw new ConfigurationError(`Reporting requires REPORT_TTL_SECONDS >= intervalSeconds + timeoutSeconds + 90 (${minimumTtl})`);
    }
  }
  return config;
}

export function serviceStateLocation(service: ServiceConfig, config: Config) {
  const { probes: _probes, PROBES_JSON: _json, ...settings } = config;
  const targets = [...service.targets].sort((a, b) => a.id.localeCompare(b.id));
  const identity = createHash("sha256").update(JSON.stringify({ service: { ...service, targets }, settings })).digest("hex").slice(0, 24);
  const name = `${service.type}/${service.mode}-${identity}/aggregation.json`;
  return { file: `.azure/probes/${name}`, blob: `probes/${name}` };
}
