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
  PROBE_TIMEOUT_MS: number(90000, 100, 120000, true),
  POLL_INTERVAL_MS: number(2000, 10, 10000, true),
  ENABLE_LIVE_M365: z.enum(["true", "false"]).default("false"),
  PROBES_JSON: z.string().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new ConfigurationError(`Invalid environment settings: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  const config = parsed.data;
  if (config.EXECUTION_MODE === "live" && config.ENABLE_LIVE_M365 !== "true") {
    throw new ConfigurationError("Live Graph mutations require ENABLE_LIVE_M365=true and approved dedicated resources");
  }
  let rawProbes: unknown;
  try {
    rawProbes = config.PROBES_JSON ? JSON.parse(config.PROBES_JSON) : [1].map(index => ({
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
  for (const probe of probes) {
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
