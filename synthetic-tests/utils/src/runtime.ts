import { ConfigurationError, type Config } from "./config.js";
import { probeServices, type Telemetry } from "./contracts.js";
import type { RunnerDependencies } from "./runner.js";
import type { ServiceConfig } from "./service-config.js";
import { createFederatedGraphClient, createLiveGraphClient, createLiveTeamsBot, createTeamsCallingGraph, createTeamsReadbackGraph } from "./auth.js";
import { createTeamsCallingVerifier, type CallingIdentity } from "./teams-calling-auth.js";
import { startTeamsCallingCallback } from "./teams-calling-callback.js";
import { GraphClient } from "./graph.js";
import { createResultOutput, type ResultOutput } from "./results.js";
import type { ProjectConfig } from "./project-config.js";
import { dirname, resolve } from "node:path";
import { canonicalProjectFile } from "./paths.js";

export function serviceEnvironment(
  project: ProjectConfig, service: ServiceConfig, env: NodeJS.ProcessEnv, file = canonicalProjectFile,
): NodeJS.ProcessEnv {
  const selected = project.services[service.type];
  const access = selected.access;
  const bind = (name: string, value: string | undefined) => {
    if (value !== undefined && env[name] !== undefined && env[name]?.toLowerCase() !== value.toLowerCase()) {
      throw new ConfigurationError(`Configured ${name} conflicts with the selected execution environment`);
    }
    return value ?? env[name];
  };
  const azureTenant = env.AZURE_TENANT_ID ?? project.deployment?.azureTenantId;
  const azureClient = bind("AZURE_CLIENT_ID", selected.worker?.identityClientId);
  return {
    ...env, AZURE_TENANT_ID: azureTenant, AZURE_CLIENT_ID: azureClient,
    ...(access.m365TenantId ? { M365_TENANT_ID: bind("M365_TENANT_ID", access.m365TenantId) } : {}),
    ...(access.m365ClientId ? { M365_CLIENT_ID: bind("M365_CLIENT_ID", access.m365ClientId) } : {}),
    ...(access.m365CertificatePath ? { M365_CLIENT_CERTIFICATE_PATH: resolve(dirname(file), access.m365CertificatePath) } : {}),
    ...(service.type === "teams" ? {
      BOT_TENANT_ID: env.BOT_TENANT_ID ?? azureTenant,
      BOT_CLIENT_ID: env.BOT_CLIENT_ID ?? azureClient,
      TEAMS_CALLING_PEER_CLIENT_ID: bind("TEAMS_CALLING_PEER_CLIENT_ID", access.botPeerClientId),
    } : {}),
  };
}

export function validateProjectTenantBinding(tenant: Pick<ProjectConfig["tenant"], "tenantId"> | undefined, service: ServiceConfig, env: NodeJS.ProcessEnv): void {
  if (!tenant || !service.enabled || service.mode !== "live") return;
  const expected = tenant.tenantId.toLowerCase();
  const matches = (name: string) => env[name]?.toLowerCase() === expected;
  if (service.graphAuthentication === "certificate" ? !matches("M365_TENANT_ID") : !matches("AZURE_TENANT_ID")) {
    throw new ConfigurationError("Selected tenant requires its own explicit Graph credential binding; direct managed identity/federation must use the actual Azure identity tenant");
  }
  if (service.providerClientId && (service.serviceHealth || service.serviceActivity.enabled) && !matches("AZURE_TENANT_ID")) {
    throw new ConfigurationError("The selected tenant's providerClientId must use its actual Azure identity tenant; certificate Graph access does not rebind federated provider credentials");
  }
  if (service.type === "teams" && (!matches("AZURE_TENANT_ID") || !matches("BOT_TENANT_ID") ||
      (env.M365_TENANT_ID !== undefined && !matches("M365_TENANT_ID")))) {
    throw new ConfigurationError("This runner's Teams managed-identity guards require the selected tenant, Azure identity tenant, bot tenant and Graph observer tenant to match; use an approved tenant-local binding");
  }
}

export function validateRuntimeConsent(service: ServiceConfig, env: NodeJS.ProcessEnv): void {
  if (service.serviceActivity.enabled && env.ENABLE_BETA_SERVICE_ACTIVITY !== "true") {
    throw new ConfigurationError("serviceActivity.enabled requires ENABLE_BETA_SERVICE_ACTIVITY=true (experimental diagnostics only)");
  }
  if (service.mode === "live" && env.ENABLE_LIVE_M365 !== "true") {
    throw new ConfigurationError("Live Graph access requires ENABLE_LIVE_M365=true and approved dedicated resources");
  }
}

export function providerGraphClient(service: ServiceConfig, env: NodeJS.ProcessEnv): GraphClient | undefined {
  if (!service.enabled || (!service.serviceHealth && !service.serviceActivity.enabled)) return undefined;
  validateRuntimeConsent(service, env);
  if (service.mode === "simulation") return undefined;
  return service.providerClientId
    ? createFederatedGraphClient(env, service.providerClientId)
    : createLiveGraphClient(env, service.graphAuthentication);
}

export async function serviceRuntime(
  service: ServiceConfig, config: Config, telemetry: Telemetry, env: NodeJS.ProcessEnv = process.env,
  suppliedResults?: ResultOutput,
  options: { onTeamsCallingNotification?: (notification: unknown, identity: CallingIdentity) => void } = {},
): Promise<RunnerDependencies> {
  if (!service.enabled) throw new ConfigurationError("Service runtime requires an enabled probe type");
  const live = config.EXECUTION_MODE === "live";
  if (service.type === "onedrive" && config.probes.some(probe =>
    probeServices[probe.type].service !== "onedrive" || !service.targets.some(target => target.id === probe.id &&
      target.userId === probe.userId && target.userPrincipalName?.toLowerCase() === probe.userPrincipalName?.toLowerCase() &&
      target.driveId === probe.driveId && target.folderId === probe.folderId && target.folderName === probe.folderName &&
      target.restoreVersion === probe.restoreVersion))) {
    throw new ConfigurationError("OneDrive may access only the selected root-configured accounts, drives and folders");
  }
  if (service.type === "teams" && config.probes.some(probe => probe.type === "teams-call" &&
      !service.callTargets.some(target => target.id === probe.id &&
        target.tenantId.toLowerCase() === probe.tenantId?.toLowerCase() &&
        target.meetingThreadId === probe.meetingThreadId &&
        target.organizerUserId.toLowerCase() === probe.organizerUserId?.toLowerCase() &&
        target.peerBotClientId.toLowerCase() === probe.peerBotClientId?.toLowerCase()))) {
    throw new ConfigurationError("Calls may join only the selected root-configured dedicated meetings and peer bots");
  }
  if (service.type === "teams" && config.probes.some(probe => probe.type === "teams-channel-message" &&
      !service.targets.some(target => target.id === probe.id &&
        target.tenantId?.toLowerCase() === probe.tenantId?.toLowerCase() &&
        target.teamId === probe.teamId && target.channelId === probe.channelId && target.serviceUrl === probe.serviceUrl))) {
    throw new ConfigurationError("Teams messages may access only the selected root-configured tenants, teams and channels");
  }
  const messages = config.probes.some(probe => probe.type === "teams-channel-message");
  const dependencies: RunnerDependencies = {
    telemetry, results: suppliedResults ?? createResultOutput(telemetry),
    ...(live && (service.type !== "teams" || messages) ? {
      graph: service.type === "teams" && service.teamsReadbackClientId
        ? createTeamsReadbackGraph(env, service.teamsReadbackClientId)
        : createLiveGraphClient(env, service.graphAuthentication),
    } : {}),
    ...(live && service.type === "teams" && messages ? {
      teamsBot: createLiveTeamsBot(config, env, service.graphAuthentication),
    } : {}),
  };
  const needsCalling = config.probes.some(probe => probe.type === "teams-call");
  if (live && service.type === "teams" && needsCalling) {
    const graph = createTeamsCallingGraph(config, env);
    const peerGraph = createTeamsCallingGraph(config, env, true);
    dependencies.teamsCalling = graph;
    dependencies.teamsCallingPeer = peerGraph;
    const verify = await createTeamsCallingVerifier(env);
    const server = await startTeamsCallingCallback({
      port: config.TEAMS_CALLING_PORT, verify,
      ...(options.onTeamsCallingNotification ? { onNotification: options.onTeamsCallingNotification } : {}),
      onAccepted: () => telemetry.emit("teams-calling-callback-accepted", { authentication: "verified", tenantMatched: true }),
      onRejected: (httpStatus, stage, diagnostic) => telemetry.emit("teams-calling-callback-rejected", { httpStatus, stage, ...diagnostic }),
    });
    dependencies.shutdown = () => server.shutdown();
  }
  return dependencies;
}
