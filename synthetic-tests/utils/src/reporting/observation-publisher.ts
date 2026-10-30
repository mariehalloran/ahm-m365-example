import { EventHubProducerClient } from "@azure/event-hubs";
import { ManagedIdentityCredential } from "@azure/identity";
import { z } from "zod";
import { ConfigurationError } from "../configuration/config.js";
import type { Telemetry } from "../contracts.js";
import { withAbort } from "../integrations/http.js";
import { cycleObservations } from "./observations.js";
import type { ProjectConfig } from "../configuration/project-config.js";
import type { CyclePublisher } from "./results.js";
import type { ServiceConfig } from "../configuration/service-config.js";

export function createObservationPublisher(
  project: ProjectConfig, service: ServiceConfig, telemetry: Telemetry, env: NodeJS.ProcessEnv,
): { publish: CyclePublisher; close: () => Promise<void> } {
  const pipeline = project.logAnalytics;
  if (!pipeline.enabled) throw new ConfigurationError("Raw observation publication requires logAnalytics.enabled");
  let client: EventHubProducerClient | undefined;
  if (service.mode === "live") {
    const identity = z.string().uuid().safeParse(env.AZURE_CLIENT_ID);
    if (!identity.success) throw new ConfigurationError("Observation publication requires an explicitly selected managed identity");
    client = new EventHubProducerClient(
      `${pipeline.eventHubNamespace}.servicebus.windows.net`,
      pipeline.eventHubName,
      new ManagedIdentityCredential({ clientId: identity.data }),
      { retryOptions: { maxRetries: 2, retryDelayInMs: 250, maxRetryDelayInMs: 2000, timeoutInMs: 5000 } },
    );
  }
  return {
    async publish(cycle) {
      const observations = cycleObservations(project, service, cycle).map(observation => ({
        ...observation, dimensions: {
          ...observation.dimensions,
          configSha256: env.MONITORING_CONFIG_SHA256,
          containerRevision: env.CONTAINER_APP_REVISION,
        },
      }));
      if (observations.some(observation => Buffer.byteLength(JSON.stringify(observation)) > 65536)) {
        throw new ConfigurationError("Observations must remain below 64 KiB; no payload was truncated or published");
      }
      if (!client) {
        telemetry.emit("observation-preview", { cycleId: cycle.cycleId, observationCount: observations.length });
        return;
      }
      const signal = cycle.signal ?? AbortSignal.timeout(service.type === "exchange" ? 12000 : 30000);
      try {
        let batch = await withAbort(signal, () => client!.createBatch({ abortSignal: signal }));
        for (const observation of observations) {
          const event = { body: observation, messageId: observation.eventId, contentType: "application/json" };
          if (!batch.tryAdd(event)) {
            if (!batch.count) throw new ConfigurationError("An observation exceeds the Event Hub event-size limit");
            await withAbort(signal, () => client!.sendBatch(batch, { abortSignal: signal }));
            batch = await withAbort(signal, () => client!.createBatch({ abortSignal: signal }));
            if (!batch.tryAdd(event)) throw new ConfigurationError("An observation exceeds the Event Hub event-size limit");
          }
        }
        if (batch.count) await withAbort(signal, () => client!.sendBatch(batch, { abortSignal: signal }));
        telemetry.emit("observations-published", {
          cycleId: cycle.cycleId, observationCount: observations.length,
          destination: pipeline.eventHubName,
        });
      } catch (error) {
        telemetry.emit("observation-publication-failed", {
          cycleId: cycle.cycleId, observationCount: observations.length,
          errorType: error instanceof Error ? error.name : "unknown",
        });
        throw error;
      }
    },
    async close() {
      if (client) await withAbort(AbortSignal.timeout(5000), () => client!.close());
    },
  };
}
