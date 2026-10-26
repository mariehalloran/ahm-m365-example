import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationError } from "./config.js";
import { applyProjectConfig, readProjectConfig, type ProjectConfig } from "./project-config.js";
import { readServiceConfig, type ServiceConfig } from "./service-config.js";

const certificateSecretUri = z.string().regex(
  /^https:\/\/[a-zA-Z0-9-]+\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9]+)?$/,
);
const applicationAccess = z.object({
  m365TenantId: z.string().uuid().optional(),
  m365ClientId: z.string().uuid().optional(),
  m365CertificateSource: z.enum(["key-vault", "container-app"]).optional(),
  m365CertificateSecretUri: certificateSecretUri.optional(),
  m365CertificateRevision: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  botTenantId: z.string().uuid().optional(),
  botClientId: z.string().uuid().optional(),
  botCertificateSecretUri: certificateSecretUri.optional(),
  teamsPublicClientId: z.string().uuid().optional(),
}).strict();
const serviceAccessSchema = z.object({
  exchange: applicationAccess.optional(),
  teams: applicationAccess.optional(),
  sharepoint: applicationAccess.optional(),
}).strict();

async function readServiceAccess(file?: string): Promise<z.infer<typeof serviceAccessSchema>> {
  if (!file) return {};
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch { throw new ConfigurationError("Cannot read the service access config file"); }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new ConfigurationError("Service access config must contain valid JSON"); }
  const parsed = serviceAccessSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid service access config fields: ${parsed.error.issues.map(issue => issue.path.join(".") || "(root)").join(", ")}`);
  }
  return parsed.data;
}

async function readDeploymentService(project: ProjectConfig, type: ServiceConfig["type"], projectFile: string) {
  const service = await readServiceConfig(resolve(dirname(projectFile), project.services[type].configFile));
  if (service.type !== type) throw new ConfigurationError(`Deployment requires a ${type} service config`);
  applyProjectConfig(project, service);
  return service;
}

export async function prepareDeploymentParameters(
  projectFile: string, workerImage?: string, enableLiveProbes = false, accessFile?: string, enableBetaServiceActivity = false,
) {
  const project = await readProjectConfig(projectFile);
  if (project.healthModel.subscriptionId === "00000000-0000-0000-0000-000000000000") {
    throw new ConfigurationError("Deployment requires an approved healthModel.subscriptionId");
  }
  if (workerImage !== undefined && workerImage.trim().length === 0) {
    throw new ConfigurationError("workerImage must be a nonempty image reference");
  }
  const [exchange, teams, sharepoint] = await Promise.all([
    readDeploymentService(project, "exchange", projectFile),
    readDeploymentService(project, "teams", projectFile),
    readDeploymentService(project, "sharepoint", projectFile),
  ]);
  const serviceAccess = await readServiceAccess(accessFile);
  for (const service of [exchange, teams, sharepoint]) {
    const teamsMessages = project.services.teams.scenarios["publish-channel-message"] || project.services.teams.scenarios["reply-channel-message"];
    const access = serviceAccess[service.type];
    if (access?.teamsPublicClientId && (service.type !== "teams" || service.teamsAuthentication !== "user-delegated")) {
      throw new ConfigurationError("teamsPublicClientId requires Teams user-delegated authentication");
    }
    if (access && Object.values(access).some(value => value !== undefined)) {
      const hasM365 = access.m365TenantId || access.m365ClientId || access.m365CertificateSecretUri ||
        access.m365CertificateSource || access.m365CertificateRevision;
      const nativeCertificate = access.m365CertificateSource === "container-app";
      if (hasM365 && !(access.m365TenantId && access.m365ClientId &&
          (nativeCertificate ? access.m365CertificateRevision : access.m365CertificateSecretUri))) {
        throw new ConfigurationError(`${service.type} access requires all three M365 application settings`);
      }
      if (nativeCertificate && access.m365CertificateSecretUri) {
        throw new ConfigurationError(`${service.type} certificate storage must select only one source`);
      }
      if (!nativeCertificate && access.m365CertificateRevision) {
        throw new ConfigurationError(`${service.type} native certificate revision requires container-app storage`);
      }
      const hasBot = access.botTenantId || access.botClientId || access.botCertificateSecretUri;
      if (hasBot && (service.type !== "teams" || !(access.botTenantId && access.botClientId && access.botCertificateSecretUri))) {
        throw new ConfigurationError("Bot access requires all three bot settings and is supported only for teams");
      }
      if (hasBot && service.teamsAuthentication !== "bot" && !project.services.teams.scenarios["call-test-user"]) {
        throw new ConfigurationError("Bot access requires explicit teamsAuthentication: bot");
      }
      if (hasBot && service.botAuthentication !== "certificate") {
        throw new ConfigurationError("Bot certificate access requires explicit botAuthentication: certificate; managed identity metadata is supplied by infrastructure");
      }
      if (hasM365 && service.graphAuthentication !== "certificate") {
        throw new ConfigurationError(`${service.type} M365 application settings require graphAuthentication: certificate`);
      }
      if (hasBot && access.m365TenantId && access.botTenantId?.toLowerCase() !== access.m365TenantId.toLowerCase()) {
        throw new ConfigurationError("Teams bot and M365 application tenants must match");
      }
      if (service.type === "teams" && access.m365TenantId &&
          project.services.teams.targets.some(target => target.tenantId?.toLowerCase() !== access.m365TenantId?.toLowerCase())) {
        throw new ConfigurationError("Teams target and M365 application tenants must match");
      }
      if (hasBot && [...project.services.teams.targets, ...project.services.teams.callTargets].some(target =>
        target.tenantId?.toLowerCase() !== access.botTenantId?.toLowerCase())) {
        throw new ConfigurationError("Teams target and bot tenants must match");
      }
    }
    if (workerImage && applyProjectConfig(project, service).enabled && service.mode === "live") {
      if (service.healthReportAuthentication !== "managed-identity") {
        throw new ConfigurationError("Hosted workers require healthReportAuthentication: managed-identity");
      }
      const needsApplicationGraph = service.type !== "teams" || (service.teamsAuthentication === "bot" && teamsMessages) ||
        service.serviceHealth || service.serviceActivity.enabled;
      if (needsApplicationGraph && service.graphAuthentication === "certificate" &&
          !(access?.m365CertificateSecretUri || access?.m365CertificateSource === "container-app")) {
        throw new ConfigurationError(`${service.type} hosted Graph certificate access requires --access-config with M365 application settings`);
      }
      if (service.type === "teams" && teamsMessages && service.teamsAuthentication === "user-delegated" && !access?.teamsPublicClientId) {
        throw new ConfigurationError("Hosted delegated Teams requires --access-config with teamsPublicClientId");
      }
      if (service.type === "teams" && (service.teamsAuthentication === "bot" || project.services.teams.scenarios["call-test-user"]) &&
          service.botAuthentication === "certificate" && !access?.botCertificateSecretUri) {
        throw new ConfigurationError("Hosted bot certificate access requires --access-config with bot certificate settings");
      }
    }
  }
  if (workerImage && !enableLiveProbes && [exchange, teams, sharepoint].some(service =>
    applyProjectConfig(project, service).enabled && service.mode === "live")) {
    throw new ConfigurationError("Deploying live worker profiles requires explicit --enable-live");
  }
  if (workerImage && !enableBetaServiceActivity && [exchange, teams, sharepoint].some(service =>
    applyProjectConfig(project, service).enabled && service.serviceActivity.enabled)) {
    throw new ConfigurationError("Deploying beta provider collection requires explicit --enable-beta-service-activity");
  }
  return {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    contentVersion: "1.0.0.0",
    parameters: {
      projectConfig: { value: project },
      serviceConfigs: { value: { exchange, teams, sharepoint } },
      serviceAccess: { value: serviceAccess },
      deployWorkers: { value: workerImage !== undefined },
      workerImage: { value: workerImage ?? "" },
      enableLiveProbes: { value: enableLiveProbes },
      enableBetaServiceActivity: { value: enableBetaServiceActivity },
    },
  };
}

async function main(args: string[]): Promise<void> {
  const { projectFile, outputFile, workerImage, enableLiveProbes, accessFile, enableBetaServiceActivity } = parseDeploymentArguments(args);
  if (resolve(projectFile) === resolve(outputFile)) {
    throw new ConfigurationError("Deployment output must not overwrite the project config");
  }
  const parameters = await prepareDeploymentParameters(resolve(projectFile), workerImage, enableLiveProbes, accessFile && resolve(accessFile), enableBetaServiceActivity);
  await writeFile(outputFile, `${JSON.stringify(parameters, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ event: "deployment-parameters-prepared", deployWorkers: workerImage !== undefined }));
}

export function parseDeploymentArguments(args: string[]) {
  const [projectFile, outputFile, ...remaining] = args;
  const usage = "Usage: npm run deployment:prepare -- <project-config> <output-parameters.json> [worker-image] [--enable-live] [--enable-beta-service-activity] [--access-config <file>]";
  if (!projectFile || !outputFile || projectFile.startsWith("--") || outputFile.startsWith("--")) {
    throw new ConfigurationError(usage);
  }
  let workerImage: string | undefined;
  let accessFile: string | undefined;
  let enableLiveProbes = false;
  let enableBetaServiceActivity = false;
  for (let index = 0; index < remaining.length; index++) {
    const argument = remaining[index]!;
    if (argument === "--enable-live" && !enableLiveProbes) enableLiveProbes = true;
    else if (argument === "--enable-beta-service-activity" && !enableBetaServiceActivity) enableBetaServiceActivity = true;
    else if (argument === "--access-config" && !accessFile) {
      accessFile = remaining[++index];
      if (!accessFile || accessFile.startsWith("--")) throw new ConfigurationError(usage);
    } else if (!argument.startsWith("--") && workerImage === undefined) workerImage = argument;
    else throw new ConfigurationError(usage);
  }
  return { projectFile, outputFile, workerImage, enableLiveProbes, accessFile, enableBetaServiceActivity };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({
      event: "deployment-parameters-failed", errorType: error instanceof Error ? error.name : "unknown",
      ...(error instanceof ConfigurationError ? { message: error.message } : {}),
    }));
    process.exitCode = 1;
  });
}
