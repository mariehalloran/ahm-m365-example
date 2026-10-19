import { ConfigurationError, type Config } from "./config.js";
import type { Telemetry } from "./contracts.js";
import type { RunnerDependencies } from "./runner.js";
import type { ServiceConfig } from "./service-config.js";
import { createProbeTelemetry } from "./azure-monitor.js";
import { createLiveGraphClient, createLiveTeamsBot } from "./auth.js";

export async function serviceRuntime(
  service: ServiceConfig, config: Config, telemetry: Telemetry, env: NodeJS.ProcessEnv = process.env,
): Promise<RunnerDependencies> {
  if (!service.enabled) throw new ConfigurationError("Service runtime requires an enabled probe type");
  const results = await createProbeTelemetry(service.telemetry, telemetry, env);
  try {
    return {
      telemetry, results,
      ...(config.EXECUTION_MODE === "live" ? { graph: createLiveGraphClient(env, service.graphAuthentication) } : {}),
      ...(config.EXECUTION_MODE === "live" && service.type === "teams" ? {
        teamsBot: createLiveTeamsBot(config, env),
      } : {}),
    };
  } catch (error) {
    await results.shutdown();
    throw error;
  }
}
