import { ConfigurationError, type Config } from "./config.js";
import { probeServices, type Telemetry } from "./contracts.js";
import type { RunnerDependencies } from "./runner.js";
import type { ServiceConfig } from "./service-config.js";
import { createFederatedGraphClient, createLiveGraphClient, createLiveTeamsBot, createTeamsCallingGraph, createTeamsReadbackGraph } from "./auth.js";
import { createTeamsCallingVerifier } from "./teams-calling-auth.js";
import { startTeamsCallingCallback } from "./teams-calling-callback.js";
import { TeamsCallOperations } from "./teams-call-operations.js";
import { GraphClient } from "./graph.js";
import { AuthenticatedHttp, IntegrationError } from "./http.js";
import { createTeamsUserCredentials } from "./teams-user-auth.js";
import { TeamsUserClient } from "./teams-user.js";
import { createResultOutput, type ResultOutput } from "./results.js";

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
  const messages = config.probes.some(probe => probe.type === "teams-channel-message" || probe.type === "teams-channel-reply");
  let dependencies: RunnerDependencies;
  if (live && service.type === "teams" && messages && service.teamsAuthentication === "user-delegated") {
    const users = createTeamsUserCredentials(service, env);
    const clients = new Map([...users].map(([username, credential]) => {
      const graph = new GraphClient(new AuthenticatedHttp(credential, "https://graph.microsoft.com/.default"));
      return [username, { graph, teamsBot: new TeamsUserClient(graph, credential) }] as const;
    }));
    dependencies = {
      telemetry, results: suppliedResults ?? createResultOutput(telemetry),
      clientsForProbe(probe) {
        const target = service.targets.find(target => target.id === probe.id);
        const selected = clients.get(target?.userPrincipalName?.toLowerCase() ?? "");
        if (!target || !selected || probe.userPrincipalName?.toLowerCase() !== target.userPrincipalName?.toLowerCase() ||
            probe.tenantId?.toLowerCase() !== target.tenantId?.toLowerCase()) {
          throw new IntegrationError("configuration-failure");
        }
        return selected;
      },
    };
  } else dependencies = {
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
  if (live && service.type === "teams" && config.probes.some(probe => probe.type === "teams-call")) {
    const graph = createTeamsCallingGraph(config, env);
    const peerGraph = createTeamsCallingGraph(config, env, true);
    const verify = await createTeamsCallingVerifier(env);
    const operations = new TeamsCallOperations();
    const server = await startTeamsCallingCallback({
      port: config.TEAMS_CALLING_PORT, verify,
      onNotification: notification => operations.accept(notification),
      onMediaServed: () => telemetry.emit("teams-call-tone-served", { bytes: 32044, sampleRateHz: 16000 }),
      onAccepted: () => telemetry.emit("teams-calling-callback-accepted", { authentication: "verified", tenantMatched: true }),
      onRejected: (httpStatus, stage, diagnostic) => telemetry.emit("teams-calling-callback-rejected", { httpStatus, stage, ...diagnostic }),
    });
    dependencies.teamsCalling = graph;
    dependencies.teamsCallingPeer = peerGraph;
    dependencies.teamsCallOperations = operations;
    dependencies.shutdown = async () => { operations.shutdown(); await server.shutdown(); };
  }
  return dependencies;
}
