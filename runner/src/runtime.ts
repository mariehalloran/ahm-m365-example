import { ClientCertificateCredential } from "@azure/identity";
import { z } from "zod";
import { ConfigurationError, type Config } from "./config.js";
import type { Telemetry } from "../../shared/src/contracts.js";
import { GraphClient } from "../../shared/src/graph.js";
import { AuthenticatedHttp } from "../../shared/src/http.js";
import type { RunnerDependencies } from "./runner.js";
import type { ServiceConfig } from "./service-config.js";
import { createProbeTelemetry } from "../../telemetry/src/azure-monitor.js";

export function createLiveGraphClient(env: NodeJS.ProcessEnv = process.env): GraphClient {
  const parsed = z.object({
    AZURE_TENANT_ID: z.string().uuid(),
    AZURE_CLIENT_ID: z.string().uuid(),
    AZURE_CLIENT_CERTIFICATE_PATH: z.string().trim().min(1),
  }).safeParse(env);
  if (!parsed.success) {
    throw new ConfigurationError(`Local live Graph access requires app-only certificate settings: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  }
  const credential = new ClientCertificateCredential(
    parsed.data.AZURE_TENANT_ID, parsed.data.AZURE_CLIENT_ID, parsed.data.AZURE_CLIENT_CERTIFICATE_PATH,
  );
  return new GraphClient(new AuthenticatedHttp(credential, "https://graph.microsoft.com/.default"));
}

export async function serviceRuntime(service: ServiceConfig, config: Config, telemetry: Telemetry, env: NodeJS.ProcessEnv = process.env): Promise<RunnerDependencies> {
  if (!service.enabled || service.type === "teams") throw new ConfigurationError("Service runtime requires an enabled, implemented probe type");
  const results = await createProbeTelemetry(service.telemetry, telemetry, env);
  try {
    return {
      telemetry, results,
      ...(config.EXECUTION_MODE === "live" ? { graph: createLiveGraphClient(env) } : {}),
    };
  } catch (error) {
    await results.shutdown();
    throw error;
  }
}
