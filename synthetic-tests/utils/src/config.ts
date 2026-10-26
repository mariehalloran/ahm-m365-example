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
  TEAMS_AUTHENTICATION: z.literal("bot").default("bot"),
  BOT_AUTHENTICATION: z.literal("managed-identity").default("managed-identity"),
  BOT_CLIENT_ID: z.string().uuid().optional(),
  TEAMS_CALLING_PEER_CLIENT_ID: z.string().uuid().optional(),
  TEAMS_CALLING_CALLBACK_URL: teamsCallingCallbackUrlSchema.optional(),
  TEAMS_CALLING_PORT: number(8080, 1024, 65535, true),
  TEAMS_CALLING_PLAYBACK_ENABLED: z.enum(["true", "false"]).default("false"),
  TEAMS_CALLING_ANSWER_TIMEOUT_SECONDS: number(20, 1, 30, true),
  TEAMS_CALLING_PLAYBACK_TIMEOUT_SECONDS: number(10, 2, 30, true),
  TEAMS_CLEANUP_ENABLED: z.enum(["true", "false"]).default("true"),
  EXCHANGE_CLEANUP_ENABLED: z.enum(["true", "false"]).default("true"),
  PROBES_JSON: z.string().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.TEAMS_CALLING_WAIT_SECONDS !== undefined || env.TEAMS_CALLING_RING_SECONDS !== undefined) {
    throw new ConfigurationError("Obsolete calling wait/ring settings; explicitly configure two-bot meeting audio playback");
  }
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
  if (Array.isArray(rawProbes) && rawProbes.some(probe => probe && typeof probe === "object" && "callUserId" in probe)) {
    throw new ConfigurationError("Obsolete callUserId: calling requires a dedicated meetingThreadId, organizerUserId metadata and peerBotClientId; human calling is unsupported");
  }
  // Exchange supports six journeys for each of 30 explicit target sets.
  const parsedProbes = z.array(probeSchema).min(1).max(180).safeParse(rawProbes);
  if (!parsedProbes.success) throw new ConfigurationError(`Invalid PROBES_JSON fields: ${parsedProbes.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  const probes = parsedProbes.data;
  if (["exchange", "teams", "onedrive"].some(service =>
    probes.filter(probe => probeServices[probe.type].service === service).length >
      (service === "exchange" ? 180 : service === "teams" ? 60 : 90))) {
    throw new ConfigurationError("Invalid PROBES_JSON: service probe inventory exceeded");
  }
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
        : service === "onedrive"
          ? Boolean(probe.userId && probe.userPrincipalName && probe.folderName)
          : probe.type === "teams-call"
            ? Boolean(probe.tenantId && probe.meetingThreadId && probe.organizerUserId && probe.peerBotClientId &&
              config.TEAMS_CALLING_CALLBACK_URL)
            : Boolean(probe.tenantId && probe.teamId && probe.channelId && probe.serviceUrl);
      if (!hasDedicatedResources) {
        throw new ConfigurationError(`Missing dedicated resources for probe ${probe.id}`);
      }
      if (probe.type === "teams-call" && config.TEAMS_CALLING_PLAYBACK_ENABLED !== "true") {
        throw new ConfigurationError("Meeting playback requires explicit TEAMS_CALLING_PLAYBACK_ENABLED=true approval");
      }
      if (probe.type === "teams-call" && (
          !config.BOT_CLIENT_ID || !config.TEAMS_CALLING_PEER_CLIENT_ID ||
          config.BOT_CLIENT_ID.toLowerCase() === config.TEAMS_CALLING_PEER_CLIENT_ID.toLowerCase() ||
          config.TEAMS_CALLING_PEER_CLIENT_ID.toLowerCase() !== probe.peerBotClientId?.toLowerCase())) {
        throw new ConfigurationError("Teams peer journeys require two distinct explicit managed identities: BOT_CLIENT_ID and TEAMS_CALLING_PEER_CLIENT_ID matching root peerBotClientId");
      }
      if (probe.type === "teams-call" && config.PROBE_TIMEOUT_MS <
          (config.TEAMS_CALLING_ANSWER_TIMEOUT_SECONDS + config.TEAMS_CALLING_PLAYBACK_TIMEOUT_SECONDS) * 1000 + 5000) {
        throw new ConfigurationError("Calling timeout must allow answer and playback budgets plus five seconds for requests");
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
