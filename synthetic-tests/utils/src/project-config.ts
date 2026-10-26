import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "./config.js";
import { probeSchema } from "./contracts.js";
import { executionLanes } from "./execution-lanes.js";
import { parseServiceConfig, readServiceConfig, type ServiceConfig, type ServiceFileConfig } from "./service-config.js";

const target = probeSchema.pick({ id: true, region: true, scenario: true });
const selection = {
  enabled: z.boolean().default(true),
  configFile: z.string().trim().min(1),
};
export const projectConfigSchema = z.object({
  schemaVersion: z.literal("1.0"),
  otel: z.object({
    enabled: z.boolean().default(false),
    destination: z.enum(["console", "azure-monitor"]).default("console"),
  }).strict().default({}),
  healthModel: z.object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{1,31}[a-zA-Z0-9]$/),
    subscriptionId: z.string().uuid(),
    resourceGroup: z.string().regex(/^[a-zA-Z0-9_().-]{1,90}$/).refine(value => !value.endsWith(".")),
    reportTtlMinutes: z.number().int().min(1).max(10080),
    successDegradedPercent: z.number().min(0).max(100),
    successUnhealthyPercent: z.number().min(0).max(100),
    latencyDegradedMilliseconds: z.number().int().nonnegative(),
    latencyUnhealthyMilliseconds: z.number().int().nonnegative(),
    callQualityThresholds: z.record(z.enum([
      "packetLossPercent", "maxPacketLossPercent", "jitterMs", "maxJitterMs",
      "roundTripTimeMs", "maxRoundTripTimeMs", "audioDegradation",
      "concealedSamplesPercent", "maxConcealedSamplesPercent",
    ]), z.object({
      degradedAbove: z.number().finite().nonnegative(),
      unhealthyAbove: z.number().finite().nonnegative(),
    }).strict()).default({}),
  }).strict(),
  services: z.object({
    exchange: z.object({
      ...selection,
      scenarios: z.object({
        "send-receive-mail": z.boolean().default(true), "edit-reopen-draft": z.boolean().default(true),
        "attachment-reply-mail": z.boolean().default(true), "distribution-list-mail": z.boolean().default(true),
        "recurring-calendar": z.boolean().default(true), "meeting-invitation": z.boolean().default(true),
      }).strict(),
      targets: z.array(target.extend({
        mailbox: probeSchema.shape.mailbox, recipientMailbox: probeSchema.shape.recipientMailbox,
        distributionList: probeSchema.shape.distributionList,
      }).strict()).max(30),
    }).strict(),
    teams: z.object({
      ...selection,
      scenarios: z.object({
        "channel-conversation": z.boolean().default(true),
        "scheduled-meeting": z.boolean().default(true),
      }).strict(),
      targets: z.array(target.extend({
        tenantId: probeSchema.shape.tenantId, teamId: probeSchema.shape.teamId,
        channelId: probeSchema.shape.channelId, serviceUrl: probeSchema.shape.serviceUrl,
      }).strict()).max(30),
      callTargets: z.array(target.extend({
        tenantId: z.string().uuid(),
        meetingThreadId: probeSchema.shape.meetingThreadId.unwrap(),
        organizerUserId: z.string().uuid(), peerBotClientId: z.string().uuid(),
      }).strict()).max(30).default([]),
    }).strict(),
    onedrive: z.object({
      ...selection,
      scenarios: z.object({
        "user-drive-roundtrip": z.boolean().default(true),
        "app-folder-lifecycle": z.boolean().default(true),
        "document-versions": z.boolean().default(true),
      }).strict(),
      targets: z.array(target.extend({
        userId: probeSchema.shape.userId, userPrincipalName: probeSchema.shape.userPrincipalName,
        driveId: probeSchema.shape.driveId, folderId: probeSchema.shape.folderId,
        folderName: probeSchema.shape.folderName, restoreVersion: probeSchema.shape.restoreVersion,
      }).strict()).max(30),
    }).strict(),
  }).strict(),
}).strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export function parseProjectConfig(raw: unknown): ProjectConfig {
  const parsed = projectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    if (parsed.error.issues.some(issue => issue.code === "unrecognized_keys" && issue.keys.includes("callUserId"))) {
      throw new ConfigurationError("Obsolete callUserId: use dedicated meetingThreadId, organizerUserId owner metadata and peerBotClientId; no human-calling compatibility path");
    }
    throw new ConfigurationError(`Invalid project config fields: ${parsed.error.issues.map(issue => issue.path.join(".") || "(root)").join(", ")}`);
  }
  const project = parsed.data;
  const teams = project.services.teams;
  const onedrive = project.services.onedrive;
  for (const field of ["userId", "userPrincipalName", "driveId"] as const) {
    const values = onedrive.targets.flatMap(item => item[field] ? [item[field]!.toLowerCase()] : []);
    if (new Set(values).size !== values.length) throw new ConfigurationError("OneDrive accounts and drives must be unique");
  }
  if (teams.enabled && teams.scenarios["scheduled-meeting"] && teams.callTargets.length === 0) {
    throw new ConfigurationError("Enabled scheduled-meeting requires root-configured callTargets");
  }
  if (new Set(teams.callTargets.map(item => item.id)).size !== teams.callTargets.length ||
      new Set(teams.callTargets.map(item => `${item.tenantId.toLowerCase()}:${item.meetingThreadId}`)).size !== teams.callTargets.length) {
    throw new ConfigurationError("Call target IDs and dedicated meetings must be unique");
  }
  const policy = project.healthModel;
  for (const [metric, thresholds] of Object.entries(policy.callQualityThresholds)) {
    if (!thresholds || thresholds.unhealthyAbove < thresholds.degradedAbove ||
        (metric.endsWith("Percent") && thresholds.unhealthyAbove > 100)) {
      throw new ConfigurationError("Call-quality thresholds must order Degraded before Unhealthy and percentages must not exceed 100");
    }
  }
  if (policy.successUnhealthyPercent > policy.successDegradedPercent ||
      policy.latencyUnhealthyMilliseconds < policy.latencyDegradedMilliseconds) {
    throw new ConfigurationError("Health thresholds must order Degraded before Unhealthy");
  }
  for (const selected of Object.values(project.services)) {
    if (new Set(selected.targets.map(item => item.id)).size !== selected.targets.length) {
      throw new ConfigurationError("Project target IDs must be unique within each service");
    }
    const needsMessageTargets = selected !== teams || teams.scenarios["channel-conversation"];
    if (selected.enabled && Object.values(selected.scenarios).some(Boolean) && needsMessageTargets && selected.targets.length === 0) {
      throw new ConfigurationError("Enabled project scenarios require at least one target");
    }
  }
  return project;
}

export async function readProjectConfig(file: string): Promise<ProjectConfig> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch { throw new ConfigurationError("Cannot read the project config file"); }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new ConfigurationError("Project config must contain a valid JSON object"); }
  return parseProjectConfig(raw);
}

export function applyProjectConfig(project: ProjectConfig, service: ServiceFileConfig): ServiceConfig {
  const selected = project.services[service.type];
  const enabled = selected.enabled && Object.values(selected.scenarios).some(Boolean);
  if (enabled && service.mode === "live") {
    if (project.healthModel.subscriptionId === "00000000-0000-0000-0000-000000000000") {
      throw new ConfigurationError("Live health reports require an approved healthModel.subscriptionId");
    }
    const cycleBudgetSeconds = project.otel.enabled ? 224 : 212;
    const longestInterval = Math.max(...executionLanes(service)
      .filter(lane => lane.journeys.some(journey => (selected.scenarios as Record<string, boolean>)[journey]))
      .map(lane => lane.intervalSeconds));
    const providerBudget = service.serviceHealth || service.serviceActivity.enabled
      ? service.providerIntervalSeconds + (project.otel.enabled ? 72 : 60) : 0;
    if (project.healthModel.reportTtlMinutes * 60 <= Math.max(longestInterval + cycleBudgetSeconds, providerBudget)) {
      throw new ConfigurationError(`Health report TTL must exceed the service cadence plus the bounded cycle/report budget (${cycleBudgetSeconds} seconds)`);
    }
  }
  return parseServiceConfig({
    ...service, enabled, targets: selected.targets,
    ...(service.type === "teams" ? { callTargets: project.services.teams.callTargets } : {}),
  });
}

export async function readProjectService(
  type: ServiceConfig["type"], projectFile: string, serviceFile?: string,
): Promise<{ project: ProjectConfig; service: ServiceConfig }> {
  const project = await readProjectConfig(projectFile);
  const selected = project.services[type];
  const file = serviceFile ?? resolve(dirname(projectFile), selected.configFile);
  const service = await readServiceConfig(file);
  if (service.type !== type) throw new ConfigurationError(`This worker only accepts ${type} configs`);
  return { project, service: applyProjectConfig(project, service) };
}
