import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "./config.js";
import { probeSchema } from "./contracts.js";
import { parseServiceConfig, readServiceConfig, type ServiceConfig, type ServiceFileConfig } from "./service-config.js";

const target = probeSchema.pick({ id: true, region: true, scenario: true });
const selection = {
  enabled: z.boolean().default(true),
  configFile: z.string().trim().min(1),
};
export const projectConfigSchema = z.object({
  schemaVersion: z.literal("1.0"),
  otel: z.object({
    enabled: z.boolean().default(true),
    destination: z.enum(["console", "azure-monitor"]).default("console"),
  }).strict(),
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
      scenarios: z.object({ "send-receive-mail": z.boolean().default(true) }).strict(),
      targets: z.array(target.extend({ mailbox: probeSchema.shape.mailbox }).strict()).max(30),
    }).strict(),
    teams: z.object({
      ...selection,
      scenarios: z.object({ "publish-channel-message": z.boolean().default(true) }).strict(),
      targets: z.array(target.extend({
        tenantId: probeSchema.shape.tenantId, teamId: probeSchema.shape.teamId,
        channelId: probeSchema.shape.channelId, serviceUrl: probeSchema.shape.serviceUrl,
      }).strict()).max(30),
    }).strict(),
    sharepoint: z.object({
      ...selection,
      scenarios: z.object({ "save-reopen-file": z.boolean().default(true) }).strict(),
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
  const policy = project.healthModel;
  if (policy.successUnhealthyPercent > policy.successDegradedPercent ||
      policy.latencyUnhealthyMilliseconds < policy.latencyDegradedMilliseconds) {
    throw new ConfigurationError("Health thresholds must order Degraded before Unhealthy");
  }
  for (const selected of Object.values(project.services)) {
    if (new Set(selected.targets.map(item => item.id)).size !== selected.targets.length) {
      throw new ConfigurationError("Project target IDs must be unique within each service");
    }
    if (selected.enabled && Object.values(selected.scenarios).some(Boolean) && selected.targets.length === 0) {
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
    if (project.healthModel.reportTtlMinutes * 60 <= service.intervalSeconds + 212) {
      throw new ConfigurationError("Health report TTL must exceed the service cadence plus the bounded cycle/report budget (212 seconds)");
    }
  }
  return parseServiceConfig({
    ...service, enabled, targets: selected.targets,
    telemetry: project.otel.enabled ? project.otel.destination : "none",
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
