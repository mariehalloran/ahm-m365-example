import { ConfigurationError, type Config } from "../configuration/config.js";
import { probeServices, type Telemetry } from "../contracts.js";
import type { RunnerDependencies, TeamsBotPairClients } from "./runner.js";
import { hasProviderSources, serviceProbes, type ServiceConfig } from "../configuration/service-config.js";
import { createFederatedGraphClient, createLiveGraphClient, createLiveTeamsBot, createTeamsCallingGraph, createTeamsReadbackGraph } from "../integrations/auth.js";
import { createTeamsCallingVerifier, type CallingIdentity } from "../integrations/teams-calling-auth.js";
import { startTeamsCallingCallback } from "../integrations/teams-calling-callback.js";
import { GraphClient } from "../integrations/graph.js";
import { GraphRequestPermits } from "./graph-request-permits.js";
import { createResultOutput, type ResultOutput } from "../reporting/results.js";
import type { ProjectConfig } from "../configuration/project-config.js";
import { dirname, resolve } from "node:path";
import { canonicalProjectFile } from "../paths.js";

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
  if (service.providerClientId && hasProviderSources(service) && !matches("AZURE_TENANT_ID")) {
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
  if (!service.enabled || !hasProviderSources(service)) return undefined;
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
  if (service.type === "exchange" && config.probes.some(probe =>
    probeServices[probe.type].service !== "exchange" || !service.targets.some(target =>
      target.id === probe.id && target.mailbox.toLowerCase() === probe.mailbox?.toLowerCase() &&
      target.replySeed?.messageId === probe.replySeed?.messageId &&
      target.replySeed?.correlationId === probe.replySeed?.correlationId))) {
    throw new ConfigurationError("Exchange journeys may access only their selected root-configured mailbox and retained self-reply fixture");
  }
  if (service.type === "onedrive" && config.probes.some(probe =>
    probeServices[probe.type].service !== "onedrive" || !service.targets.some(target => target.id === probe.id &&
      target.userId === probe.userId && target.userPrincipalName?.toLowerCase() === probe.userPrincipalName?.toLowerCase() &&
      target.driveId === probe.driveId && target.folderId === probe.folderId && target.folderName === probe.folderName &&
      target.restoreVersion === probe.restoreVersion))) {
    throw new ConfigurationError("OneDrive may access only the selected root-configured accounts, drives and folders");
  }
  if (service.type === "teams") {
    const allowed = new Map(serviceProbes(service, { "channel-conversation": true, "scheduled-meeting": true })
      .map(probe => [`${probe.type}:${probe.id}`, probe]));
    const fields = ["tenantId", "teamId", "channelId", "serviceUrl", "meetingThreadId", "organizerUserId", "botPairId", "botClientId", "peerBotClientId"] as const;
    if (config.probes.some(probe => {
      const target = allowed.get(`${probe.type}:${probe.id}`);
      return !target || fields.some(field => target[field] !== probe[field]);
    })) {
      throw new ConfigurationError("Teams journeys may use only the selected root-configured bot pairs, channels and dedicated meetings");
    }
  }
  const messages = config.probes.some(probe => probe.type === "teams-channel-message");
  const dependencies: RunnerDependencies = {
    telemetry, results: suppliedResults ?? createResultOutput(telemetry),
    ...(service.type === "exchange" ? {
      exchangeRequests: new GraphRequestPermits(service.maxConcurrentRequests, service.maxConcurrentRequestsPerMailbox),
    } : {}),
    ...(live && (service.type !== "teams" || messages) ? {
      graph: service.type === "teams" && service.teamsReadbackClientId
        ? createTeamsReadbackGraph(env, service.teamsReadbackClientId)
        : createLiveGraphClient(env, service.graphAuthentication),
    } : {}),
  };
  const needsCalling = config.probes.some(probe => probe.type === "teams-call");
  if (live && service.type === "teams") {
    const clients = new Map<string, TeamsBotPairClients>();
    for (const pair of service.botPairs) {
      const sendsMessages = config.probes.some(probe => probe.botPairId === pair.id && probe.type === "teams-channel-message");
      const joinsMeetings = config.probes.some(probe => probe.botPairId === pair.id && probe.type === "teams-call");
      if (!sendsMessages && !joinsMeetings) continue;
      if (!pair.botClientId || (joinsMeetings && !pair.botPeerClientId)) {
        throw new ConfigurationError(`Teams pair ${pair.id} is missing its generated client IDs; run npm run setup:ids`);
      }
      clients.set(pair.id, {
        ...(sendsMessages ? { teamsBot: createLiveTeamsBot(config, env, pair.botClientId, service.graphAuthentication) } : {}),
        ...(joinsMeetings ? {
          teamsCalling: createTeamsCallingGraph(config, env, pair.botClientId),
          teamsCallingPeer: createTeamsCallingGraph(config, env, pair.botPeerClientId!),
        } : {}),
      });
    }
    dependencies.teamsBotPairs = clients;
  }
  if (live && service.type === "teams" && needsCalling) {
    const audiences = service.botPairs.filter(pair => config.probes.some(probe => probe.botPairId === pair.id && probe.type === "teams-call"))
      .flatMap(pair => [pair.botClientId!, pair.botPeerClientId!]);
    const verify = await createTeamsCallingVerifier(env, audiences);
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
