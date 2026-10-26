import { ConfigurationError, type Config } from "./config.js";
import { probeServices, type Telemetry } from "./contracts.js";
import type { RunnerDependencies } from "./runner.js";
import type { ServiceConfig } from "./service-config.js";
import { createFederatedGraphClient, createLiveGraphClient, createLiveTeamsBot, createTeamsCallingGraph, createTeamsReadbackGraph } from "./auth.js";
import { createTeamsCallingVerifier } from "./teams-calling-auth.js";
import { startTeamsCallingCallback } from "./teams-calling-callback.js";
import { TeamsCallOperations } from "./teams-call-operations.js";
import { GraphClient } from "./graph.js";
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
    const operations = new TeamsCallOperations();
    const server = await startTeamsCallingCallback({
      port: config.TEAMS_CALLING_PORT, verify,
      onNotification: (notification, identity) => operations.accept(notification, identity),
      onMediaServed: () => telemetry.emit("teams-call-tone-served", { bytes: 32044, sampleRateHz: 16000 }),
      onAccepted: () => telemetry.emit("teams-calling-callback-accepted", { authentication: "verified", tenantMatched: true }),
      onRejected: (httpStatus, stage, diagnostic) => telemetry.emit("teams-calling-callback-rejected", { httpStatus, stage, ...diagnostic }),
    });
    dependencies.teamsCallOperations = operations;
    dependencies.shutdown = async () => { operations.shutdown(); await server.shutdown(); };
  }
  return dependencies;
}
