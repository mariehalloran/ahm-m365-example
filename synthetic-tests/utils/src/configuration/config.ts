import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ManagedIdentityCredential } from "@azure/identity";
import { BlobClient } from "@azure/storage-blob";
import { z } from "zod";
import { probeSchema, probeServices, scenarios, serviceProbeLimits, type Probe } from "../contracts.js";
import { liveProbeSchema, type LiveProbe } from "./resolved-probes.js";
import { validateTeamsServiceUrl } from "../integrations/teams.js";
import { canonicalProjectFile } from "../paths.js";

export class ConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigurationError"; }
}
export async function readConfigJson(file: string): Promise<unknown> {
  let text: string;
  const blobUrl = process.env.MONITORING_CONFIG_BLOB_URL;
  if (blobUrl !== undefined) {
    if (file !== canonicalProjectFile) throw new ConfigurationError("Hosted workers cannot override the root configuration snapshot");
    const identity = z.string().uuid().safeParse(process.env.AZURE_CLIENT_ID);
    const expectedHash = process.env.MONITORING_CONFIG_SHA256;
    let url: URL;
    try { url = new URL(blobUrl); }
    catch { throw new ConfigurationError("Hosted configuration snapshot URL is invalid"); }
    if (!identity.success || !expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash) ||
        url.protocol !== "https:" || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) ||
        url.pathname !== `/worker-config/${expectedHash}.json` || url.search || url.hash || url.username || url.password) {
      throw new ConfigurationError("Hosted configuration requires a private Azure Blob snapshot, its hash and an explicit identity");
    }
    const client = new BlobClient(blobUrl, new ManagedIdentityCredential({ clientId: identity.data }));
    let bytes: Buffer;
    try { bytes = await client.downloadToBuffer(0, undefined, { abortSignal: AbortSignal.timeout(15000) }); }
    catch { throw new ConfigurationError("Cannot download the root configuration snapshot with the selected managed identity"); }
    if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
      throw new ConfigurationError("Hosted configuration snapshot hash mismatch");
    }
    text = bytes.toString("utf8");
  } else {
    try { text = await readFile(file, "utf8"); }
    catch { throw new ConfigurationError("Cannot read the project config file"); }
  }
  try { return JSON.parse(text); }
  catch { throw new ConfigurationError("Project config must contain a valid JSON object"); }
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
const runtimeSettingsSchema = z.object({
  EXECUTION_MODE: z.enum(["simulation", "live"]).default("simulation"),
  SYNTHETIC_SCENARIO: z.enum(scenarios).default("healthy"),
  PROBE_TIMEOUT_MS: number(90000, 100, 120000, true),
  MAX_CONCURRENT_PROBES: number(3, 1, 20, true),
  EXCHANGE_MAX_CONCURRENT_REQUESTS: number(32, 1, 1000, true),
  EXCHANGE_MAX_CONCURRENT_REQUESTS_PER_MAILBOX: number(2, 1, 20, true),
  CYCLE_TIMEOUT_MS: number(170000, 100, 86400000, true),
  POLL_INTERVAL_MS: number(2000, 10, 10000, true),
  ENABLE_LIVE_M365: z.enum(["true", "false"]).default("false"),
  TEAMS_AUTHENTICATION: z.literal("bot").default("bot"),
  BOT_AUTHENTICATION: z.literal("managed-identity").default("managed-identity"),
  TEAMS_CALLING_CALLBACK_URL: teamsCallingCallbackUrlSchema.optional(),
  TEAMS_CALLING_PORT: number(8080, 1024, 65535, true),
  TEAMS_CALLING_ANSWER_TIMEOUT_SECONDS: number(20, 1, 30, true),
  TEAMS_CLEANUP_ENABLED: z.enum(["true", "false"]).default("true"),
  EXCHANGE_CLEANUP_ENABLED: z.enum(["true", "false"]).default("true"),
});
type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export type Config = Omit<RuntimeSettings, "EXECUTION_MODE"> & (
  | { EXECUTION_MODE: "simulation"; probes: Probe[] }
  | { EXECUTION_MODE: "live"; probes: LiveProbe[] }
);

export function createRuntimeConfig(
  settings: Partial<RuntimeSettings> & { probes: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Config {
  if (env.TEAMS_CALLING_WAIT_SECONDS !== undefined || env.TEAMS_CALLING_RING_SECONDS !== undefined ||
      env.TEAMS_CALLING_PLAYBACK_ENABLED !== undefined || env.TEAMS_CALLING_PLAYBACK_TIMEOUT_SECONDS !== undefined) {
    throw new ConfigurationError("Obsolete calling wait/ring/playback settings; remove them and configure meeting establishment without audio testing");
  }
  const parsed = runtimeSettingsSchema.safeParse({ ...env, ...settings });
  if (!parsed.success) throw new ConfigurationError(`Invalid environment settings: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  const config = parsed.data;
  if (config.EXECUTION_MODE === "live" && config.ENABLE_LIVE_M365 !== "true") {
    throw new ConfigurationError("Live Graph mutations require ENABLE_LIVE_M365=true and approved dedicated resources");
  }
  const rawProbes = settings.probes;
  if (Array.isArray(rawProbes) && rawProbes.some(probe => probe && typeof probe === "object" && "callUserId" in probe)) {
    throw new ConfigurationError("Obsolete callUserId: calling requires a dedicated meetingThreadId, organizerUserId metadata and peerBotClientId; human calling is unsupported");
  }
  const parsedProbes = z.array(probeSchema).min(1).max(Object.values(serviceProbeLimits).reduce((sum, limit) => sum + limit, 0)).safeParse(rawProbes);
  if (!parsedProbes.success) throw new ConfigurationError(`Invalid PROBES_JSON fields: ${parsedProbes.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  const probes = parsedProbes.data;
  if (["exchange", "teams", "onedrive"].some(service =>
    probes.filter(probe => probeServices[probe.type].service === service).length >
      serviceProbeLimits[service as keyof typeof serviceProbeLimits])) {
    throw new ConfigurationError("Invalid PROBES_JSON: service probe inventory exceeded");
  }
  if (new Set(probes.map(probe => `${probe.type}:${probe.id}`)).size !== probes.length) {
    throw new ConfigurationError("Probe IDs must be unique within each journey type");
  }
  const cohorts = new Map<string, string>();
  const liveProbes: LiveProbe[] = [];
  for (const probe of probes) {
    const service = probeServices[probe.type].service;
    if (cohorts.has(probe.cohort) && cohorts.get(probe.cohort) !== service) {
      throw new ConfigurationError("A cohort cannot mix services");
    }
    cohorts.set(probe.cohort, service);
    if (config.EXECUTION_MODE === "live") {
      if (probe.type === "teams-call" && !config.TEAMS_CALLING_CALLBACK_URL) {
        throw new ConfigurationError(`Missing dedicated resources for probe ${probe.id}`);
      }
      const resolved = liveProbeSchema.safeParse(probe);
      if (!resolved.success) {
        const missingBotIdentity = resolved.error.issues.every(issue =>
          issue.path[0] === "botPairId" || issue.path[0] === "botClientId");
        if (missingBotIdentity) {
          throw new ConfigurationError("Live Teams journeys require a named bot pair with explicit distinct managed-identity client IDs; run npm run setup:ids");
        }
        throw new ConfigurationError(`Missing dedicated resources for probe ${probe.id}`);
      }
      const live = resolved.data;
      if (live.type === "teams-call" && live.botClientId.toLowerCase() === live.peerBotClientId.toLowerCase()) {
        throw new ConfigurationError("Live Teams journeys require a named bot pair with explicit distinct managed-identity client IDs; run npm run setup:ids");
      }
      if (probe.type === "teams-call" && config.PROBE_TIMEOUT_MS <
          config.TEAMS_CALLING_ANSWER_TIMEOUT_SECONDS * 1000 + 5000) {
        throw new ConfigurationError("Calling timeout must allow the answer budget plus five seconds for requests");
      }
      if (service === "teams" && probe.serviceUrl) {
        try {
          validateTeamsServiceUrl(probe.serviceUrl);
        } catch {
          throw new ConfigurationError(`Unapproved Teams Bot Connector service URL for probe ${probe.id}`);
        }
      }
      liveProbes.push(live);
    }
  }
  return config.EXECUTION_MODE === "live"
    ? { ...config, EXECUTION_MODE: "live", probes: liveProbes }
    : { ...config, EXECUTION_MODE: "simulation", probes };
}

export function filterRuntimeProbes(config: Config, include: (probe: Probe) => boolean): Config {
  return config.EXECUTION_MODE === "live"
    ? { ...config, probes: config.probes.filter(include) }
    : { ...config, probes: config.probes.filter(include) };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.PROBES_JSON !== undefined && typeof env.PROBES_JSON !== "string") {
    throw new ConfigurationError("Invalid environment settings: PROBES_JSON");
  }
  let probes: unknown;
  try {
    probes = env.PROBES_JSON ? JSON.parse(env.PROBES_JSON) : [{
      id: "exchange-probe-001", type: "exchange-mail-flow", cohort: "exchange-global",
    }];
  } catch { throw new ConfigurationError("PROBES_JSON must contain a valid JSON array"); }
  return createRuntimeConfig({ probes }, env);
}
