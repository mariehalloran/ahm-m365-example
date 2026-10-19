import { z } from "zod";
import { probeSchema, scenarios } from "../../shared/src/contracts.js";

export class ConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigurationError"; }
}
const number = (fallback: number, min: number, max: number, integer = false) => {
  const schema = z.coerce.number().finite().min(min).max(max);
  return (integer ? schema.int() : schema).default(fallback);
};
const envSchema = z.object({
  EXECUTION_MODE: z.enum(["simulation", "live"]).default("simulation"),
  SYNTHETIC_SCENARIO: z.enum(scenarios).default("healthy"),
  REPORT_TTL_SECONDS: number(900, 60, 3600, true),
  PROBE_TIMEOUT_MS: number(90000, 100, 120000, true),
  POLL_INTERVAL_MS: number(2000, 10, 10000, true),
  MIN_FRESH_SAMPLES: number(3, 1, 100, true),
  MIN_FRESH_COVERAGE: number(1, 0.01, 1),
  HEALTHY_SUCCESS_RATE: number(0.99, 0, 1),
  DEGRADED_SUCCESS_RATE: number(0.95, 0, 1),
  HEALTHY_LATENCY_MS: number(15000, 0, 120000),
  UNHEALTHY_LATENCY_MS: number(60000, 1, 120000),
  CONSECUTIVE_FAILURES: number(2, 1, 20, true),
  CONSECUTIVE_RECOVERIES: number(2, 1, 20, true),
  AHM_MODEL_ID: z.string().regex(/^\/subscriptions\/[a-fA-F0-9-]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CloudHealth\/healthmodels\/[a-zA-Z0-9-]+$/).optional(),
  AHM_API_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}(-preview)?$/).default("2026-05-01-preview"),
  STATE_STORAGE_URL: z.string().url().optional(),
  ENABLE_LIVE_M365: z.enum(["true", "false"]).default("false"),
  PROBES_JSON: z.string().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new ConfigurationError(`Invalid environment settings: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  const config = parsed.data;
  if (config.HEALTHY_SUCCESS_RATE < config.DEGRADED_SUCCESS_RATE ||
      config.HEALTHY_LATENCY_MS >= config.UNHEALTHY_LATENCY_MS) {
    throw new ConfigurationError("Invalid aggregation policy thresholds");
  }
  if (config.EXECUTION_MODE === "live" && config.ENABLE_LIVE_M365 !== "true") {
    throw new ConfigurationError("Live Graph mutations require ENABLE_LIVE_M365=true and approved dedicated resources");
  }
  let rawProbes: unknown;
  try {
    rawProbes = config.PROBES_JSON ? JSON.parse(config.PROBES_JSON) : [1, 2, 3].map(index => ({
      id: `exchange-probe-00${index}`, type: "exchange-mail-flow", cohort: "exchange-global",
    }));
  } catch { throw new ConfigurationError("PROBES_JSON must contain a valid JSON array"); }
  const parsedProbes = z.array(probeSchema).min(1).max(30).safeParse(rawProbes);
  if (!parsedProbes.success) throw new ConfigurationError(`Invalid PROBES_JSON fields: ${parsedProbes.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  const probes = parsedProbes.data;
  if (new Set(probes.map(probe => probe.id)).size !== probes.length) {
    throw new ConfigurationError("Probe IDs must be unique");
  }
  const cohorts = new Map<string, string>();
  const reservedEntities = new Set(["m365-tenant", "exchange-experience", "sharepoint-experience", "teams-experience", "monitoring-pipeline", "runner-heartbeat", "provider-context", "graph-availability"]);
  for (const probe of probes) {
    if (reservedEntities.has(probe.cohort)) throw new ConfigurationError(`Cohort ${probe.cohort} uses a reserved model entity name`);
    if (cohorts.has(probe.cohort) && cohorts.get(probe.cohort) !== probe.type) {
      throw new ConfigurationError("A cohort cannot mix test types");
    }
    cohorts.set(probe.cohort, probe.type);
    if (config.EXECUTION_MODE === "live" &&
        (probe.type === "exchange-mail-flow" ? !probe.mailbox : !(probe.siteId && probe.driveId && probe.folderId))) {
      throw new ConfigurationError(`Missing dedicated resources for probe ${probe.id}`);
    }
  }
  return { ...config, probes };
}
export type Config = ReturnType<typeof loadConfig>;
