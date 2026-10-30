import { createHash } from "node:crypto";
import { app, type InvocationContext } from "@azure/functions";
import { ManagedIdentityCredential } from "@azure/identity";
import { LogsIngestionClient } from "@azure/monitor-ingestion";
import { ContainerClient } from "@azure/storage-blob";
import { z } from "zod";
import { observationSchema } from "../../utils/src/observations.js";

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
}).parse(process.env);
const credential = new ManagedIdentityCredential({ clientId: settings.AZURE_CLIENT_ID });
const uploader = new LogsIngestionClient(settings.OBSERVATION_INGESTION_ENDPOINT, credential, {
  retryOptions: { maxRetries: 2, retryDelayInMs: 500, maxRetryDelayInMs: 5000 },
});
const quarantine = new ContainerClient(settings.OBSERVATION_QUARANTINE_URL, credential);
const stream = "Custom-M365Synthetic";

function payload(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return JSON.stringify(raw) ?? String(raw);
}

async function preserveFailure(text: string, reason: string, context: InvocationContext): Promise<void> {
  const hash = createHash("sha256").update(text).digest("hex");
  await quarantine.getBlockBlobClient(`${hash}.json`).uploadData(Buffer.from(text), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    metadata: { reason },
  });
  context.error("observations-quarantined", { recordHash: hash, reason });
}

export async function ingestObservations(events: unknown[], context: InvocationContext): Promise<void> {
  const records: { RawData: string }[] = [];
  for (const raw of events) {
    const text = payload(raw);
    let data: unknown;
    try { data = typeof raw === "string" || Buffer.isBuffer(raw) ? JSON.parse(text) : raw; }
    catch {
      await preserveFailure(text, "invalid-json", context);
      continue;
    }
    const parsed = observationSchema.safeParse(data);
    if (!parsed.success || Buffer.byteLength(text) > 65536) {
      await preserveFailure(text, parsed.success ? "oversized-observation" : "invalid-observation", context);
      continue;
    }
    records.push({ RawData: JSON.stringify(parsed.data) });
  }
  if (!records.length) return;
  try {
    await uploader.upload(settings.OBSERVATION_RULE_ID, stream, records, {
      abortSignal: AbortSignal.timeout(60000),
    });
    context.log("observations-ingested", { count: records.length });
  } catch (error) {
    context.error("observation-ingestion-failed", {
      count: records.length, retry: context.retryContext?.retryCount ?? 0,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    if ((context.retryContext?.retryCount ?? 0) < 5) throw error;
    await preserveFailure(JSON.stringify(records), "ingestion-retries-exhausted", context);
  }
}

app.eventHub("ingestObservations", {
  connection: "ObservationEvents",
  eventHubName: settings.OBSERVATION_EVENT_HUB,
  consumerGroup: "log-analytics",
  cardinality: "many",
  retry: { strategy: "exponentialBackoff", maxRetryCount: 5, minimumInterval: 1000, maximumInterval: 30000 },
  handler: ingestObservations,
});
