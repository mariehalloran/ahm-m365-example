import { createHash } from "node:crypto";
import { observationSchema } from "../../utils/src/observations.js";

export type IngestionRecord = { RawData: string };
export interface IngestionContext {
  log(event: string, data: Record<string, unknown>): void;
  error(event: string, data: Record<string, unknown>): void;
  retryContext?: { retryCount: number } | undefined;
}
export interface IngestionSinks {
  upload(records: IngestionRecord[], signal: AbortSignal): Promise<void>;
  quarantine(record: { hash: string; text: string; reason: string }): Promise<void>;
}

function payload(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return JSON.stringify(raw) ?? String(raw);
}

async function preserveFailure(
  text: string, reason: string, context: IngestionContext, sinks: IngestionSinks,
): Promise<void> {
  const hash = createHash("sha256").update(text).digest("hex");
  await sinks.quarantine({ hash, text, reason });
  context.error("observations-quarantined", { recordHash: hash, reason });
}

export async function processObservations(
  events: unknown[], context: IngestionContext, sinks: IngestionSinks,
): Promise<void> {
  const records: IngestionRecord[] = [];
  for (const raw of events) {
    const text = payload(raw);
    let data: unknown;
    try { data = typeof raw === "string" || Buffer.isBuffer(raw) ? JSON.parse(text) : raw; }
    catch {
      await preserveFailure(text, "invalid-json", context, sinks);
      continue;
    }
    const parsed = observationSchema.safeParse(data);
    if (!parsed.success || Buffer.byteLength(text) > 65536) {
      await preserveFailure(text, parsed.success ? "oversized-observation" : "invalid-observation", context, sinks);
      continue;
    }
    records.push({ RawData: JSON.stringify(parsed.data) });
  }
  if (!records.length) return;
  try {
    await sinks.upload(records, AbortSignal.timeout(60000));
    context.log("observations-ingested", { count: records.length });
  } catch (error) {
    context.error("observation-ingestion-failed", {
      count: records.length, retry: context.retryContext?.retryCount ?? 0,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    if ((context.retryContext?.retryCount ?? 0) < 5) throw error;
    await preserveFailure(JSON.stringify(records), "ingestion-retries-exhausted", context, sinks);
  }
}
