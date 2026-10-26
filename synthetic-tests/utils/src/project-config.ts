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
  }).strict(),
  services: z.object({
    exchange: z.object({
      ...selection,
      scenarios: z.object({
        "send-receive-mail": z.boolean().default(true), "edit-reopen-draft": z.boolean().default(true),
        "attachment-reply-mail": z.boolean().default(false), "distribution-list-mail": z.boolean().default(false),
        "recurring-calendar": z.boolean().default(false), "meeting-invitation": z.boolean().default(false),
      }).strict(),
      targets: z.array(target.extend({
        mailbox: probeSchema.shape.mailbox, recipientMailbox: probeSchema.shape.recipientMailbox,
        distributionList: probeSchema.shape.distributionList,
      }).strict()).max(30),
    }).strict(),
    teams: z.object({
      ...selection,
      scenarios: z.object({
        "publish-channel-message": z.boolean().default(true), "reply-channel-message": z.boolean().default(true),
        "call-test-user": z.boolean().default(true),
      }).strict(),
      targets: z.array(target.extend({
        tenantId: probeSchema.shape.tenantId, teamId: probeSchema.shape.teamId,
        userPrincipalName: probeSchema.shape.userPrincipalName,
        channelId: probeSchema.shape.channelId, serviceUrl: probeSchema.shape.serviceUrl,
      }).strict()).max(30),
      callTargets: z.array(target.extend({
        tenantId: z.string().uuid(), callUserId: z.string().uuid(),
      }).strict()).max(30).default([]),
    }).strict(),
    sharepoint: z.object({
      ...selection,
      scenarios: z.object({
        "save-reopen-file": z.boolean().default(true), "rename-reopen-file": z.boolean().default(true),
      }).strict(),
      targets: z.array(target.extend({
        siteId: probeSchema.shape.siteId, driveId: probeSchema.shape.driveId, folderId: probeSchema.shape.folderId,
      }).strict()).max(30),
    }).strict(),
  }).strict(),
}).strict();
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export function parseProjectConfig(raw: unknown): ProjectConfig {
  const parsed = projectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid project config fields: ${parsed.error.issues.map(issue => issue.path.join(".") || "(root)").join(", ")}`);
  }
  const project = parsed.data;
  const teams = project.services.teams;
  if (teams.enabled && teams.scenarios["call-test-user"] && teams.callTargets.length === 0) {
    throw new ConfigurationError("Enabled call-test-user requires root-configured callTargets");
  }
  if (new Set(teams.callTargets.map(item => item.id)).size !== teams.callTargets.length ||
      new Set(teams.callTargets.map(item => `${item.tenantId.toLowerCase()}:${item.callUserId.toLowerCase()}`)).size !== teams.callTargets.length) {
    throw new ConfigurationError("Call target IDs and individual users must be unique");
  }
  const policy = project.healthModel;
  if (policy.successUnhealthyPercent > policy.successDegradedPercent ||
      policy.latencyUnhealthyMilliseconds < policy.latencyDegradedMilliseconds) {
    throw new ConfigurationError("Health thresholds must order Degraded before Unhealthy");
  }
  for (const selected of Object.values(project.services)) {
    if (new Set(selected.targets.map(item => item.id)).size !== selected.targets.length) {
      throw new ConfigurationError("Project target IDs must be unique within each service");
    }
    const needsMessageTargets = selected !== teams || teams.scenarios["publish-channel-message"] || teams.scenarios["reply-channel-message"];
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
