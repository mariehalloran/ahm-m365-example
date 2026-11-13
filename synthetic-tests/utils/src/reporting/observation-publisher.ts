import { LogsIngestionClient } from "@azure/monitor-ingestion";
import { ManagedIdentityCredential } from "@azure/identity";
import { z } from "zod";
import { ConfigurationError } from "../configuration/config.js";
import type { ProjectConfig } from "../configuration/project-config.js";
import type { ServiceConfig } from "../configuration/service-config.js";
import type { Telemetry } from "../contracts.js";
import type { Observation } from "./observations.js";

export type ObservationSender = (observations: readonly Observation[], signal: AbortSignal) => Promise<void>;

/** Sends raw observations directly to the configured DCE/DCR; no broker or ingestion bridge exists. */
export function createObservationPublisher(
  project: ProjectConfig, service: ServiceConfig, telemetry: Telemetry, env: NodeJS.ProcessEnv,
): ObservationSender {
  if (!project.logAnalytics.enabled) throw new ConfigurationError("Observation ingestion requires logAnalytics.enabled");
  let client: LogsIngestionClient | undefined;
  const rule = env.LOGS_DCR_IMMUTABLE_ID;
  if (service.mode === "live") {
    const identity = z.string().uuid().safeParse(env.AZURE_CLIENT_ID);
    const endpoint = z.string().url().safeParse(env.LOGS_INGESTION_ENDPOINT);
    if (!identity.success || !endpoint.success || !rule?.startsWith("dcr-") ||
        new URL(endpoint.data).protocol !== "https:" || !new URL(endpoint.data).hostname.endsWith(".ingest.monitor.azure.com")) {
      throw new ConfigurationError("Direct Logs Ingestion requires an explicit managed identity and deployed DCE/DCR bindings");
    }
    client = new LogsIngestionClient(endpoint.data, new ManagedIdentityCredential({ clientId: identity.data }), {
      retryOptions: { maxRetries: 2, retryDelayInMs: 250, maxRetryDelayInMs: 2000 },
    });
  }
  return async (observations, signal) => {
    if (!observations.length) return;
    if (observations.some(observation => Buffer.byteLength(JSON.stringify(observation)) > 65536)) {
      throw new ConfigurationError("An observation exceeds 64 KiB; the payload was not truncated");
    }
    if (client) {
      await client.upload(rule!, "Custom-M365Synthetic", observations.map(row => ({ RawData: JSON.stringify(row) })), {
        abortSignal: signal,
        maxConcurrency: 1,
      });
      signal.throwIfAborted();
    }
    telemetry.emit(client ? "observations-published" : "observation-preview", {
      observationCount: observations.length, destination: "DCR-LogsIngestion",
    });
  };
}
