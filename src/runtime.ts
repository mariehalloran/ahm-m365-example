import { DefaultAzureCredential, ManagedIdentityCredential } from "@azure/identity";
import { AhmSink } from "./ahm.js";
import { ConfigurationError, type Config } from "./config.js";
import type { Telemetry } from "./contracts.js";
import { GraphClient } from "./graph.js";
import { AuthenticatedHttp } from "./http.js";
import { BlobStateStore, FileStateStore } from "./state.js";
import type { RunnerDependencies } from "./runner.js";

export function runtime(config: Config, telemetry: Telemetry): RunnerDependencies {
  if (!config.AHM_MODEL_ID) throw new ConfigurationError("AHM_MODEL_ID is required for real report ingestion. Use npm run demo for an offline demonstration.");
  const credential = process.env.WEBSITE_INSTANCE_ID ? new ManagedIdentityCredential() : new DefaultAzureCredential();
  return {
    telemetry,
    sink: new AhmSink(config.AHM_MODEL_ID, config.AHM_API_VERSION, new AuthenticatedHttp(credential, "https://management.azure.com/.default")),
    state: config.STATE_STORAGE_URL ? new BlobStateStore(config.STATE_STORAGE_URL, credential) : new FileStateStore(config.STATE_FILE),
    ...(config.EXECUTION_MODE === "live" ? {
      graph: new GraphClient(new AuthenticatedHttp(credential, "https://graph.microsoft.com/.default")),
    } : {}),
  };
}
