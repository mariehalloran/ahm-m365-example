import { z } from "zod";
import { GraphClient, graphNextPagePath, type GraphApiVersion } from "./graph.js";
import { categoryOf, IntegrationError } from "./http.js";
import type { ProviderCategory, ProviderDiagnostic, ProviderSource } from "./provider-diagnostics.js";
import type { ResultOutput } from "./results.js";
import type { ServiceConfig } from "./service-config.js";

export class ProviderCollectionError extends Error {
  constructor(readonly category: ProviderCategory) { super(category); this.name = "ProviderCollectionError"; }
}
export const PROVIDER_PAGE_LIMIT = 5;
export const PROVIDER_SOURCE_TIMEOUT_MS = 30_000;
export const PROVIDER_PAGE_BYTE_LIMIT = 2_000_000;

export async function readProviderCollection<T>(
  graph: GraphClient, path: string, item: z.ZodType<T>, signal: AbortSignal, version: GraphApiVersion,
  initialQuery = "?$top=100", maxItemsPerPage = 100,
): Promise<T[]> {
  const schema = z.object({
    value: z.array(item).max(maxItemsPerPage), "@odata.nextLink": z.string().min(1).optional(),
  });
  const results: T[] = [];
  let next = `${path}${initialQuery}`;
  const visited = new Set<string>();
  for (let page = 0; page < PROVIDER_PAGE_LIMIT; page++) {
    signal.throwIfAborted();
    if (visited.has(next)) throw new ProviderCollectionError("pagination-budget");
    visited.add(next);
    const response = await graph.json(next, schema, signal, "GET", undefined, true, version, PROVIDER_PAGE_BYTE_LIMIT);
    results.push(...response.value);
    const continuation = response["@odata.nextLink"];
    if (continuation === undefined) return results;
    next = graphNextPagePath(continuation, path, version);
  }
  // Never publish a partial collection as a complete snapshot.
  throw new ProviderCollectionError("pagination-budget");
}

export interface ProviderSourceDefinition {
  source: ProviderSource;
  apiVersion: GraphApiVersion;
  collect(graph: GraphClient, signal: AbortSignal, collectedAt: string): Promise<ProviderDiagnostic[]>;
}
export interface ProviderCollectionContext {
  service: ServiceConfig;
  graph?: GraphClient;
  results: Pick<ResultOutput, "recordDiagnostic">;
  signal: AbortSignal;
  now?: () => number;
}
export interface ProviderCollectionSummary {
  configured: number;
  succeeded: number;
  failed: number;
  skipped: number;
  records: number;
}
export type ProviderCollector = (context: ProviderCollectionContext) => Promise<ProviderCollectionSummary>;

export async function collectProviderSources(
  context: ProviderCollectionContext, sources: readonly ProviderSourceDefinition[],
): Promise<ProviderCollectionSummary> {
  const summary: ProviderCollectionSummary = { configured: sources.length, succeeded: 0, failed: 0, skipped: 0, records: 0 };
  const service = context.service.type;
  const now = context.now ?? Date.now;
  await Promise.all(sources.map(async definition => {
    const base = { service, source: definition.source, apiVersion: definition.apiVersion };
    if (context.service.mode === "simulation") {
      context.results.recordDiagnostic({ ...base, kind: "skipped", reason: "simulation", collectedAt: new Date(now()).toISOString() });
      summary.skipped++;
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let records: ProviderDiagnostic[];
    try {
      if (!context.graph) throw new IntegrationError("collector-failure");
      signal.throwIfAborted();
      const deadline = new Promise<never>((_, reject) => {
        onAbort = () => reject(new ProviderCollectionError(
          context.signal.aborted ? "cancelled" : "collection-budget",
        ));
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => controller.abort(), PROVIDER_SOURCE_TIMEOUT_MS);
      });
      records = await Promise.race([
        definition.collect(context.graph, signal, new Date(now()).toISOString()),
        deadline,
      ]);
      signal.throwIfAborted();
    } catch (error) {
      summary.failed++;
      context.results.recordDiagnostic({
        ...base, kind: "failure", collectedAt: new Date(now()).toISOString(),
        category: error instanceof ProviderCollectionError ? error.category : categoryOf(error),
        ...(error instanceof IntegrationError && error.status !== undefined ? { httpStatus: error.status } : {}),
      });
      return;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    for (const record of records) context.results.recordDiagnostic(record);
    summary.succeeded++;
    summary.records += records.length;
  }));
  return summary;
}
