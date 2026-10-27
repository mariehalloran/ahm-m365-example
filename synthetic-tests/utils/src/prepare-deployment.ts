import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationError } from "./config.js";
import { applyProjectConfig, readProjectConfig, type ProjectConfig } from "./project-config.js";
import { readServiceConfig, type ServiceConfig, type ServiceFileConfig } from "./service-config.js";

const certificateSecretUri = z.string().regex(
  /^https:\/\/[a-zA-Z0-9-]+\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9]+)?$/,
);
const applicationAccess = z.object({
  m365TenantId: z.string().uuid().optional(),
  m365ClientId: z.string().uuid().optional(),
  m365CertificateSource: z.enum(["key-vault", "container-app"]).optional(),
  m365CertificateSecretUri: certificateSecretUri.optional(),
  m365CertificateRevision: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  botPeerClientId: z.string().uuid().optional(),
  botPeerManagedIdentityResourceId: z.string().regex(
    /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[a-z0-9_().-]{1,90}\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[a-z0-9_-]{3,128}$/i,
  ).optional(),
}).strict();
const serviceAccessSchema = z.object({
  exchange: applicationAccess.optional(),
  teams: applicationAccess.optional(),
  onedrive: applicationAccess.optional(),
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
  const service: ServiceFileConfig = await readServiceConfig(resolve(dirname(projectFile), project.services[type].configFile));
  if (service.type !== type) throw new ConfigurationError(`Deployment requires a ${type} service config`);
  const effective = applyProjectConfig(project, service);
  return { ...service, serviceHealth: effective.serviceHealth, serviceActivity: effective.serviceActivity };
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
  const [exchange, teams, onedrive] = await Promise.all([
    readDeploymentService(project, "exchange", projectFile),
    readDeploymentService(project, "teams", projectFile),
    readDeploymentService(project, "onedrive", projectFile),
  ]);
  const serviceAccess = await readServiceAccess(accessFile);
  for (const service of [exchange, teams, onedrive]) {
    const teamsMessages = project.services.teams.scenarios["channel-conversation"];
    const access = serviceAccess[service.type];
    const live = service.type === "teams" && applyProjectConfig(project, service).enabled && service.mode === "live";
    const needsPeer = live && project.services.teams.scenarios["scheduled-meeting"];
    const hasPeer = access?.botPeerClientId || access?.botPeerManagedIdentityResourceId;
    if (hasPeer && (!needsPeer || !access?.botPeerClientId || !access.botPeerManagedIdentityResourceId)) {
      throw new ConfigurationError("Peer access requires both botPeerClientId and botPeerManagedIdentityResourceId for an enabled live Teams scenario that needs the peer bot");
    }
    if (needsPeer && service.botAuthentication !== "managed-identity") {
      throw new ConfigurationError("Hosted peer-bot scenarios require managed-identity bot authentication");
    }
    if (needsPeer && service.teamsCallingPort !== 8080) {
      throw new ConfigurationError("Hosted scheduled meetings require port 8080");
    }
    if (needsPeer && workerImage && !hasPeer) {
      throw new ConfigurationError("Hosted peer-bot scenarios require serviceAccess.teams botPeerClientId and botPeerManagedIdentityResourceId for the existing approved peer UAMI");
    }
    if (hasPeer && project.services.teams.callTargets.some(target =>
      target.peerBotClientId.toLowerCase() !== access!.botPeerClientId!.toLowerCase())) {
      throw new ConfigurationError("Root callTargets peerBotClientId must match serviceAccess.teams.botPeerClientId");
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
      if (hasM365 && service.graphAuthentication !== "certificate") {
        throw new ConfigurationError(`${service.type} M365 application settings require graphAuthentication: certificate`);
      }
      if (service.type === "teams" && access.m365TenantId &&
          project.services.teams.targets.some(target => target.tenantId?.toLowerCase() !== access.m365TenantId?.toLowerCase())) {
        throw new ConfigurationError("Teams target and M365 application tenants must match");
      }
    }
    if (workerImage && applyProjectConfig(project, service).enabled && service.mode === "live") {
      if (service.healthReportAuthentication !== "managed-identity") {
        throw new ConfigurationError("Hosted workers require healthReportAuthentication: managed-identity");
      }
      const needsApplicationGraph = service.type !== "teams" || teamsMessages ||
        service.serviceHealth || service.serviceActivity.enabled;
      if (needsApplicationGraph && service.graphAuthentication === "certificate" &&
          !(access?.m365CertificateSecretUri || access?.m365CertificateSource === "container-app")) {
        throw new ConfigurationError(`${service.type} hosted Graph certificate access requires --access-config with M365 application settings`);
      }
    }
  }
  if (workerImage && !enableLiveProbes && [exchange, teams, onedrive].some(service =>
    applyProjectConfig(project, service).enabled && service.mode === "live")) {
    throw new ConfigurationError("Deploying live worker profiles requires explicit --enable-live");
  }
  if (workerImage && !enableBetaServiceActivity && [exchange, teams, onedrive].some(service =>
    applyProjectConfig(project, service).enabled && service.serviceActivity.enabled)) {
    throw new ConfigurationError("Deploying beta provider collection requires explicit --enable-beta-service-activity");
  }
  return {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    contentVersion: "1.0.0.0",
    parameters: {
      projectConfig: { value: project },
      serviceConfigs: { value: { exchange, teams, onedrive } },
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
