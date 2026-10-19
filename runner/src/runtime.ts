import { ClientCertificateCredential, DefaultAzureCredential } from "@azure/identity";
import { z } from "zod";
import { AhmSink, RecordingSink } from "../../health-model/src/ahm.js";
import { ConfigurationError, type Config } from "./config.js";
import type { Telemetry } from "../../shared/src/contracts.js";
import { GraphClient } from "../../shared/src/graph.js";
import { AuthenticatedHttp } from "../../shared/src/http.js";
import { BlobStateStore, FileStateStore } from "./state.js";
import type { RunnerDependencies } from "./runner.js";
import { serviceStateLocation, type ServiceConfig } from "./service-config.js";

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

export function serviceRuntime(service: ServiceConfig, config: Config, telemetry: Telemetry, env: NodeJS.ProcessEnv = process.env): RunnerDependencies {
  if (!service.enabled || service.type === "teams") throw new ConfigurationError("Service runtime requires an enabled, implemented probe type");
  const location = serviceStateLocation(service, config);
  if (service.reportToHealthModel && !config.AHM_MODEL_ID) {
    throw new ConfigurationError("Service reporting requires AHM_MODEL_ID");
  }
  // Offline reporting never constructs Azure credentials, including when legacy storage env is present.
  const credential = service.reportToHealthModel
    ? new DefaultAzureCredential()
    : undefined;
  return {
    telemetry,
    sink: credential && config.AHM_MODEL_ID
      ? new AhmSink(config.AHM_MODEL_ID, config.AHM_API_VERSION, new AuthenticatedHttp(credential, "https://management.azure.com/.default"))
      : new RecordingSink(),
    state: credential && config.STATE_STORAGE_URL
      ? new BlobStateStore(config.STATE_STORAGE_URL, credential, location.blob)
      : new FileStateStore(location.file),
    ...(config.EXECUTION_MODE === "live" ? { graph: createLiveGraphClient(env) } : {}),
  };
}
