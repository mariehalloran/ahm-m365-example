import { z } from "zod";
import { exchangePollIntervalMilliseconds, maxServiceTargets, probeSchema, probeServices, scenarios, testTypes, type Probe } from "./contracts.js";
import { ConfigurationError, createRuntimeConfig, teamsCallingCallbackUrlSchema, type Config } from "./config.js";
import { activityFunctionNames, activityFunctions, isPercentageActivity } from "./provider-catalog.js";
import { teamsBotPairSchema } from "./deployment-config.js";
export { activityFunctions } from "./provider-catalog.js";

export const serviceActivitySchema = z.object({
  enabled: z.boolean().default(false),
  aggregationIntervalMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30)]).default(15),
  lookbackMinutes: z.number().int().min(5).max(1440).default(30),
  functions: z.array(z.enum(activityFunctionNames)).min(1).max(5).optional(),
  maxAgeMinutes: z.number().int().min(5).max(1440).default(60),
  thresholds: z.record(z.enum(activityFunctionNames), z.object({
    degradedBelow: z.number().finite().nonnegative(),
    unhealthyBelow: z.number().finite().nonnegative(),
  }).strict()).default({}),
}).strict();
const serviceFields = {
  intervalSeconds: z.number().int().min(1).max(86400),
  timeoutSeconds: z.number().int().min(1).max(120),
  maxConcurrentProbes: z.number().int().min(1).max(20).default(3),
  maxConcurrentRequests: z.number().int().min(1).max(1000).default(32),
  maxConcurrentRequestsPerMailbox: z.number().int().min(1).max(20).default(2),
  cycleTimeoutSeconds: z.number().int().min(1).max(86400).default(170),
  mode: z.enum(["simulation", "live"]),
  scenario: z.enum(scenarios).default("healthy"),
  cohort: probeSchema.shape.cohort,
  graphAuthentication: z.enum(["managed-identity", "certificate"]).default("managed-identity"),
  teamsAuthentication: z.literal("bot").default("bot"),
  botAuthentication: z.literal("managed-identity").default("managed-identity"),
  teamsReadbackClientId: z.string().uuid().optional(),
  providerClientId: z.string().uuid().optional(),
  teamsCallingCallbackUrl: teamsCallingCallbackUrlSchema.optional(),
  teamsCallingPort: z.number().int().min(1024).max(65535).default(8080),
  teamsCallingAnswerTimeoutSeconds: z.number().int().min(1).max(30).default(20),
  teamsCleanupEnabled: z.boolean().default(true),
  exchangeCleanupEnabled: z.boolean().default(true),
  executionLanes: z.array(z.object({
    name: z.string().regex(/^[a-zA-Z0-9-]{1,40}$/),
    intervalSeconds: z.number().int().min(1).max(86400),
    timeoutSeconds: z.number().int().min(1).max(120),
    journeys: z.array(z.string().min(1)).min(1),
  }).strict()).min(1).max(12).optional(),
  healthReportAuthentication: z.enum(["managed-identity", "certificate"]).default("managed-identity"),
  serviceHealth: z.boolean().default(false),
  providerIntervalSeconds: z.number().int().min(1).max(86400).default(300),
  serviceActivity: serviceActivitySchema.default({}),
};
export const serviceExecutionSchema = z.object(serviceFields).strict();
const typedExecutionSchema = serviceExecutionSchema.extend({ type: z.enum(["exchange", "teams", "onedrive"]) });
export type ServiceExecution = z.infer<typeof typedExecutionSchema>;
const common = {
  ...serviceFields,
  enabled: z.boolean(),
};
const target = probeSchema.pick({ id: true, region: true, scenario: true });
const accountTarget = target.omit({ id: true });
export const serviceTargetSchemas = {
  exchange: z.array(accountTarget.extend({
    mailbox: probeSchema.shape.mailbox.unwrap().toLowerCase(),
    replySeed: probeSchema.shape.replySeed,
  }).strict()).max(maxServiceTargets),
  onedrive: z.array(accountTarget.extend({
    userId: probeSchema.shape.userId, userPrincipalName: probeSchema.shape.userPrincipalName.unwrap().toLowerCase(),
    driveId: probeSchema.shape.driveId, folderId: probeSchema.shape.folderId,
    folderName: probeSchema.shape.folderName, restoreVersion: probeSchema.shape.restoreVersion,
  }).strict()).max(maxServiceTargets),
  teams: z.array(target.extend({
    tenantId: probeSchema.shape.tenantId,
    teamId: probeSchema.shape.teamId,
    channelId: probeSchema.shape.channelId,
    // Read only by the one-time setup tooling, which finds or creates this channel and writes `channelId` to the adjacent .env.
    channelName: z.string().trim().min(1).max(50).optional(),
    serviceUrl: probeSchema.shape.serviceUrl,
  }).strict()).max(maxServiceTargets),
};
export const teamsCallTargetsSchema = z.array(target.extend({
  tenantId: z.string().uuid(),
  meetingThreadId: probeSchema.shape.meetingThreadId.unwrap(),
  organizerUserId: z.string().uuid(),
}).strict()).max(maxServiceTargets).default([]);
const serviceSchema = z.discriminatedUnion("type", [
  z.object({
    ...common, type: z.literal("exchange"),
    targets: z.array(serviceTargetSchemas.exchange.element.extend({ id: probeSchema.shape.id })).max(maxServiceTargets),
  }).strict(),
  z.object({
    ...common, type: z.literal("onedrive"),
    targets: z.array(serviceTargetSchemas.onedrive.element.extend({ id: probeSchema.shape.id })).max(maxServiceTargets),
  }).strict(),
  z.object({
    ...common, type: z.literal("teams"),
    botPairs: z.array(teamsBotPairSchema).max(maxServiceTargets).default([]),
    targets: serviceTargetSchemas.teams,
    callTargets: teamsCallTargetsSchema,
  }).strict(),
]);
export type ServiceConfig = z.infer<typeof serviceSchema>;

export function validateTeamsBotPairs(service: Pick<Extract<ServiceConfig, { type: "teams" }>,
  "enabled" | "botPairs" | "targets" | "callTargets">): void {
  const { botPairs, targets, callTargets } = service;
  if (service.enabled && botPairs.length === 0) throw new ConfigurationError("Enabled Teams requires at least one named botPairs entry");
  const unique = (values: string[]) => new Set(values.map(value => value.toLowerCase())).size === values.length;
  if (!unique(botPairs.map(pair => pair.id)) ||
      !unique(botPairs.flatMap(pair => [pair.botResourceId, pair.botPeerResourceId])) ||
      !unique(botPairs.flatMap(pair => [pair.identityResourceId, pair.botPeerManagedIdentityResourceId])) ||
      !unique(botPairs.flatMap(pair => [pair.botClientId, pair.botPeerClientId].filter((id): id is string => id !== undefined)))) {
    throw new ConfigurationError("Teams bot pair IDs, bot registrations and primary/peer identities must be distinct across all pairs");
  }
  if (Math.max(targets.length, callTargets.length) * botPairs.length > maxServiceTargets) {
    throw new ConfigurationError(`Teams pair x target inventory must not exceed ${maxServiceTargets} attempts per journey`);
  }
  if (botPairs.some(pair => [...targets, ...callTargets].some(target => `${pair.id}--${target.id}`.length > 80))) {
    throw new ConfigurationError("Teams pair and target IDs joined with -- must fit within 80 characters");
  }
}

function validateProviderSettings(service: ServiceExecution): void {
  if (service.type === "exchange" && (service.intervalSeconds !== 60 ||
      service.executionLanes && (service.executionLanes.length !== 1 || service.executionLanes[0]!.intervalSeconds !== 60))) {
    throw new ConfigurationError("Exchange requires one aligned 60-second lane for every supported journey");
  }
  if (service.type === "onedrive" && (service.serviceActivity.enabled ||
      service.serviceActivity.functions !== undefined || Object.keys(service.serviceActivity.thresholds).length > 0)) {
    throw new ConfigurationError("OneDrive has no approved beta service activity functions");
  }
  if (service.executionLanes) {
    const names = service.executionLanes.map(lane => lane.name);
    const journeys = service.executionLanes.flatMap(lane => lane.journeys);
    const supported = testTypes.filter(type => probeServices[type].service === service.type).map(type => probeServices[type].journey);
    if (names.includes("provider-context") || new Set(names).size !== names.length || new Set(journeys).size !== journeys.length ||
        journeys.some(journey => !(supported as readonly string[]).includes(journey))) {
      throw new ConfigurationError("Execution lane names and journey assignments must be unique and service-supported");
    }
    if (supported.some(journey => !journeys.includes(journey))) {
      throw new ConfigurationError("Execution lanes must assign every supported service journey exactly once");
    }
  }
  if (service.providerClientId !== undefined && service.graphAuthentication !== "managed-identity") {
    throw new ConfigurationError("providerClientId requires managed-identity Graph authentication");
  }
  if (service.teamsReadbackClientId !== undefined &&
      (service.type !== "teams" || service.graphAuthentication !== "managed-identity")) {
    throw new ConfigurationError("teamsReadbackClientId requires Teams bot mode with managed-identity Graph authentication");
  }
  const activity = service.serviceActivity;
  if (activity.lookbackMinutes < activity.aggregationIntervalMinutes ||
      activity.lookbackMinutes % activity.aggregationIntervalMinutes !== 0) {
    throw new ConfigurationError("serviceActivity.lookbackMinutes must be a multiple of aggregationIntervalMinutes, between that interval and 1440");
  }
  const allowed: readonly string[] = activityFunctions[service.type];
  const configuredFunctions = activity.functions ?? allowed;
  if (new Set(configuredFunctions).size !== configuredFunctions.length ||
      configuredFunctions.some(name => !allowed.includes(name)) ||
      Object.entries(activity.thresholds).some(([name, rules]) =>
        !configuredFunctions.includes(name) || !rules || rules.unhealthyBelow > rules.degradedBelow ||
        (isPercentageActivity(name as (typeof activityFunctionNames)[number]) && rules.degradedBelow > 100))) {
    throw new ConfigurationError("Unsupported serviceActivity function or threshold for this service");
  }
}

export function parseServiceExecution(raw: unknown): ServiceExecution {
  const parsed = typedExecutionSchema.safeParse(raw);
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
  validateProviderSettings(service);
  if (service.type === "teams") validateTeamsBotPairs(service);
  if (service.enabled && service.targets.length === 0 && (service.type !== "teams" || service.callTargets.length === 0)) {
    throw new ConfigurationError("Enabled service config requires at least one target");
  }
  if (new Set(service.targets.map(item => item.id)).size !== service.targets.length) {
    throw new ConfigurationError("Probe IDs must be unique");
  }
  if (service.type === "exchange" && new Set(service.targets.map(item => item.mailbox.toLowerCase())).size !== service.targets.length) {
    throw new ConfigurationError("Exchange targets must identify unique independent mailboxes");
  }
  return service;
}

export function serviceProbes(service: ServiceConfig, selectedScenarios?: Readonly<Record<string, boolean>>): Probe[] {
  const supported = testTypes.filter(type => probeServices[type].service === service.type);
  const selected = selectedScenarios
    ? supported.filter(type => selectedScenarios[probeServices[type].journey])
    : supported.slice(0, 1);
  return selected.flatMap(type => {
    const targets = type === "teams-call" && service.type === "teams" ? service.callTargets : service.targets;
    const probes = targets.map(item => {
      // Teams `channelName` is read only by the setup tooling; the strict probe schema must never receive it.
      const { channelName: _setupOnly, ...target } = item as typeof item & { channelName?: string };
      return { ...target, cohort: service.cohort, type };
    });
    return service.type === "teams" ? service.botPairs.flatMap(pair => probes.map(probe => ({
      ...probe, id: `${pair.id}--${probe.id}`, botPairId: pair.id, botClientId: pair.botClientId,
      ...(type === "teams-call" ? { peerBotClientId: pair.botPeerClientId } : {}),
    }))) : probes;
  });
}

export function serviceSettings(
  service: ServiceConfig, env: NodeJS.ProcessEnv = process.env, selectedScenarios?: Readonly<Record<string, boolean>>,
): Config {
  if (!service.enabled) throw new ConfigurationError("Disabled configs do not create a runtime");
  if (service.serviceActivity.enabled && env.ENABLE_BETA_SERVICE_ACTIVITY !== "true") {
    throw new ConfigurationError("serviceActivity.enabled requires ENABLE_BETA_SERVICE_ACTIVITY=true (experimental diagnostics only)");
  }
  return createRuntimeConfig({
    EXECUTION_MODE: service.mode,
    TEAMS_AUTHENTICATION: service.teamsAuthentication,
    BOT_AUTHENTICATION: service.botAuthentication,
    TEAMS_CALLING_CALLBACK_URL: service.teamsCallingCallbackUrl,
    TEAMS_CALLING_PORT: service.teamsCallingPort,
    TEAMS_CALLING_ANSWER_TIMEOUT_SECONDS: service.teamsCallingAnswerTimeoutSeconds,
    TEAMS_CLEANUP_ENABLED: service.teamsCleanupEnabled ? "true" : "false",
    EXCHANGE_CLEANUP_ENABLED: service.exchangeCleanupEnabled ? "true" : "false",
    SYNTHETIC_SCENARIO: service.scenario,
    PROBE_TIMEOUT_MS: service.timeoutSeconds * 1000,
    ...(service.type === "exchange" ? { POLL_INTERVAL_MS: exchangePollIntervalMilliseconds } : {}),
    MAX_CONCURRENT_PROBES: service.maxConcurrentProbes,
    EXCHANGE_MAX_CONCURRENT_REQUESTS: service.maxConcurrentRequests,
    EXCHANGE_MAX_CONCURRENT_REQUESTS_PER_MAILBOX: service.maxConcurrentRequestsPerMailbox,
    CYCLE_TIMEOUT_MS: service.type === "exchange" ? 30000 : service.cycleTimeoutSeconds * 1000,
    probes: serviceProbes(service, selectedScenarios),
  }, env);
}
