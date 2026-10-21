import { ConfigurationError, type Config } from "./config.js";
import type { Telemetry } from "./contracts.js";
import type { RunnerDependencies } from "./runner.js";
import type { ServiceConfig } from "./service-config.js";
import { createLiveGraphClient, createLiveTeamsBot } from "./auth.js";
import type { GraphClient } from "./graph.js";
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
  if (!service.serviceHealth && !service.serviceActivity.enabled) return undefined;
  validateRuntimeConsent(service, env);
  if (service.mode === "simulation") return undefined;
  return createLiveGraphClient(env, service.graphAuthentication);
}

export async function serviceRuntime(
  service: ServiceConfig, config: Config, telemetry: Telemetry, env: NodeJS.ProcessEnv = process.env,
  suppliedResults?: ResultOutput,
): Promise<RunnerDependencies> {
  if (!service.enabled) throw new ConfigurationError("Service runtime requires an enabled probe type");
  return {
    telemetry, results: suppliedResults ?? createResultOutput(telemetry),
    ...(config.EXECUTION_MODE === "live" ? { graph: createLiveGraphClient(env, service.graphAuthentication) } : {}),
    ...(config.EXECUTION_MODE === "live" && service.type === "teams" ? {
      teamsBot: createLiveTeamsBot(config, env),
    } : {}),
  };
}
