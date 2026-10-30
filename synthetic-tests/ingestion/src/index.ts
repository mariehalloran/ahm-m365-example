import { app, type InvocationContext } from "@azure/functions";
import { ManagedIdentityCredential } from "@azure/identity";
import { LogsIngestionClient } from "@azure/monitor-ingestion";
import { ContainerClient } from "@azure/storage-blob";
import { z } from "zod";
import { processObservations } from "./processor.js";

const settings = z.object({
  AZURE_CLIENT_ID: z.string().uuid(),
  OBSERVATION_INGESTION_ENDPOINT: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".ingest.monitor.azure.com") &&
      !url.username && !url.password && !url.search && !url.hash;
  }),
  OBSERVATION_RULE_ID: z.string().regex(/^dcr-[a-f0-9]+$/i),
  OBSERVATION_QUARANTINE_URL: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) &&
      url.pathname === "/quarantine" && !url.username && !url.password && !url.search && !url.hash;
  }),
  OBSERVATION_EVENT_HUB: z.string().min(1),
  OBSERVATION_CONSUMER_GROUP: z.string().min(1).max(50),
}).parse(process.env);
const credential = new ManagedIdentityCredential({ clientId: settings.AZURE_CLIENT_ID });
const uploader = new LogsIngestionClient(settings.OBSERVATION_INGESTION_ENDPOINT, credential, {
  retryOptions: { maxRetries: 2, retryDelayInMs: 500, maxRetryDelayInMs: 5000 },
});
const quarantine = new ContainerClient(settings.OBSERVATION_QUARANTINE_URL, credential);
const stream = "Custom-M365Synthetic";

export async function ingestObservations(events: unknown[], context: InvocationContext): Promise<void> {
  await processObservations(events, context, {
    upload: async (records, signal) => {
      await uploader.upload(settings.OBSERVATION_RULE_ID, stream, records, { abortSignal: signal });
    },
    quarantine: async ({ hash, text, reason }) => {
      await quarantine.getBlockBlobClient(`${hash}.json`).uploadData(Buffer.from(text), {
        blobHTTPHeaders: { blobContentType: "application/json" }, metadata: { reason },
      });
    },
  });
}

app.eventHub("ingestObservations", {
  connection: "ObservationEvents",
  eventHubName: settings.OBSERVATION_EVENT_HUB,
  consumerGroup: settings.OBSERVATION_CONSUMER_GROUP,
  cardinality: "many",
  retry: { strategy: "exponentialBackoff", maxRetryCount: 5, minimumInterval: 1000, maximumInterval: 30000 },
  handler: ingestObservations,
});
