import { z } from "zod";
import { probeSchema, probeServices, scenarios } from "./contracts.js";
import { validateTeamsServiceUrl } from "./teams.js";

export class ConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigurationError"; }
}
const number = (fallback: number, min: number, max: number, integer = false) => {
  const schema = z.coerce.number().finite().min(min).max(max);
  return (integer ? schema.int() : schema).default(fallback);
};
export const teamsCallingCallbackUrlSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
    url.pathname === "/api/calls";
});
const envSchema = z.object({
  EXECUTION_MODE: z.enum(["simulation", "live"]).default("simulation"),
  SYNTHETIC_SCENARIO: z.enum(scenarios).default("healthy"),
  PROBE_TIMEOUT_MS: number(90000, 100, 120000, true),
  POLL_INTERVAL_MS: number(2000, 10, 10000, true),
  ENABLE_LIVE_M365: z.enum(["true", "false"]).default("false"),
  TEAMS_AUTHENTICATION: z.enum(["user-delegated", "bot"]).default("bot"),
  BOT_AUTHENTICATION: z.enum(["managed-identity", "certificate"]).default("managed-identity"),
  TEAMS_CALLING_CALLBACK_URL: teamsCallingCallbackUrlSchema.optional(),
  TEAMS_CALLING_PORT: number(8080, 1024, 65535, true),
  TEAMS_CALLING_WAIT_SECONDS: number(10, 1, 30, true),
  TEAMS_CLEANUP_ENABLED: z.enum(["true", "false"]).default("true"),
  EXCHANGE_CLEANUP_ENABLED: z.enum(["true", "false"]).default("true"),
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
    rawProbes = config.PROBES_JSON ? JSON.parse(config.PROBES_JSON) : [{
      id: "exchange-probe-001", type: "exchange-mail-flow", cohort: "exchange-global",
    }];
  } catch { throw new ConfigurationError("PROBES_JSON must contain a valid JSON array"); }
  // Teams supports two message journeys for 30 targets plus 30 individual calls.
  const parsedProbes = z.array(probeSchema).min(1).max(90).safeParse(rawProbes);
  if (!parsedProbes.success) throw new ConfigurationError(`Invalid PROBES_JSON fields: ${parsedProbes.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  const probes = parsedProbes.data;
  if (new Set(probes.map(probe => `${probe.type}:${probe.id}`)).size !== probes.length) {
    throw new ConfigurationError("Probe IDs must be unique within each journey type");
  }
  const cohorts = new Map<string, string>();
  for (const probe of probes) {
    const service = probeServices[probe.type].service;
    if (cohorts.has(probe.cohort) && cohorts.get(probe.cohort) !== service) {
      throw new ConfigurationError("A cohort cannot mix services");
    }
    cohorts.set(probe.cohort, service);
    if (config.EXECUTION_MODE === "live") {
      const hasDedicatedResources = service === "exchange"
        ? Boolean(probe.mailbox)
        : service === "sharepoint"
          ? Boolean(probe.siteId && probe.driveId && probe.folderId)
          : probe.type === "teams-call"
            ? Boolean(probe.tenantId && probe.callUserId && config.TEAMS_CALLING_CALLBACK_URL)
            : Boolean(probe.tenantId && probe.teamId && probe.channelId &&
            (config.TEAMS_AUTHENTICATION !== "bot" || probe.serviceUrl));
      if (!hasDedicatedResources) {
        throw new ConfigurationError(`Missing dedicated resources for probe ${probe.id}`);
      }
      if (probe.type === "teams-call" && config.PROBE_TIMEOUT_MS <= config.TEAMS_CALLING_WAIT_SECONDS * 1000 + 1000) {
        throw new ConfigurationError("Calling timeout must allow the configured wait plus execution time");
      }
      if (service === "teams" && probe.serviceUrl) {
        try {
          validateTeamsServiceUrl(probe.serviceUrl);
        } catch {
          throw new ConfigurationError(`Unapproved Teams Bot Connector service URL for probe ${probe.id}`);
        }
      }
    }
  }
  return { ...config, probes };
}
export type Config = ReturnType<typeof loadConfig>;
