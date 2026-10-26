import { z } from "zod";
import type { GraphClient } from "./graph.js";
import { ProviderCollectionError, readProviderCollection, type ProviderSourceDefinition } from "./provider-collection.js";
import { serviceActivitySchema, type ServiceConfig } from "./service-config.js";
import { activityFunctionNames, activityFunctions, isPercentageActivity, type ActivityFunction } from "./provider-catalog.js";

export interface ServiceActivityWindow {
  start: string;
  end: string;
  aggregationIntervalMinutes: 5 | 10 | 15 | 30;
}
export function serviceActivityWindow(raw: z.input<typeof serviceActivitySchema>, now = Date.now()): ServiceActivityWindow {
  const config = serviceActivitySchema.parse(raw);
  if (!Number.isFinite(now) || config.lookbackMinutes < config.aggregationIntervalMinutes ||
      config.lookbackMinutes % config.aggregationIntervalMinutes !== 0) {
    throw new ProviderCollectionError("collector-failure");
  }
  const bucketMs = config.aggregationIntervalMinutes * 60_000;
  const end = Math.floor(now / bucketMs) * bucketMs;
  return {
    start: new Date(end - config.lookbackMinutes * 60_000).toISOString(),
    end: new Date(end).toISOString(), aggregationIntervalMinutes: config.aggregationIntervalMinutes,
  };
}

export function serviceActivityPath(
  name: ActivityFunction, window: ServiceActivityWindow,
): string {
  if (!(activityFunctionNames as readonly string[]).includes(name) ||
      ![5, 10, 15, 30].includes(window.aggregationIntervalMinutes)) {
    throw new ProviderCollectionError("collector-failure");
  }
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  const bucketMs = window.aggregationIntervalMinutes * 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
      end - start > 1440 * 60_000 || start % bucketMs || end % bucketMs) {
    throw new ProviderCollectionError("collector-failure");
  }
  const utc = (value: number) => new Date(value).toISOString().replace(".000Z", "Z");
  return `/reports/serviceActivity/${name}(inclusiveIntervalStartDateTime=${utc(start)},exclusiveIntervalEndDateTime=${utc(end)},aggregationIntervalInMinutes=${window.aggregationIntervalMinutes})`;
}
const intervalStart = z.string().max(64).datetime({ offset: true });
const percentageSchema = z.object({ intervalStartDateTime: intervalStart, percentage: z.number().finite().min(0).max(100) });
const valueSchema = z.object({ intervalStartDateTime: intervalStart, value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });

async function readActivity<T extends { intervalStartDateTime: string }>(
  graph: GraphClient, name: Parameters<typeof serviceActivityPath>[0], schema: z.ZodType<T>,
  window: ServiceActivityWindow, signal: AbortSignal,
): Promise<T[]> {
  const current = Date.now();
  if (Date.parse(window.end) > current || Date.parse(window.start) < current - 30 * 86400000) {
    throw new ProviderCollectionError("collector-failure");
  }
  const maxBuckets = (Date.parse(window.end) - Date.parse(window.start)) / (window.aggregationIntervalMinutes * 60_000);
  const records = await readProviderCollection(graph, serviceActivityPath(name, window), schema, signal, "beta", "", maxBuckets);
  if (!records.length) throw new ProviderCollectionError("no-data");
  const starts = new Set<number>();
  for (const record of records) {
    const start = Date.parse(record.intervalStartDateTime);
    if (start < Date.parse(window.start) || start >= Date.parse(window.end) ||
        start % (window.aggregationIntervalMinutes * 60_000) || starts.has(start)) {
      throw new ProviderCollectionError("malformed-response");
    }
    starts.add(start);
    record.intervalStartDateTime = new Date(start).toISOString();
  }
  return records;
}
export function getConnectivityMetricsForExchange(graph: GraphClient, window: ServiceActivityWindow, signal: AbortSignal) {
  return readActivity(graph, "getConnectivityMetricsForExchange", percentageSchema, window, signal);
}
export function getMessageVolumeMetricsForTeamsChat(graph: GraphClient, window: ServiceActivityWindow, signal: AbortSignal) {
  return readActivity(graph, "getMessageVolumeMetricsForTeamsChat", valueSchema, window, signal);
}

export function serviceActivitySources(service: ServiceConfig): ProviderSourceDefinition[] {
  if (!service.serviceActivity.enabled || service.type === "onedrive") return [];
  const type = service.type;
  const functions = service.serviceActivity.functions ?? activityFunctions[service.type];
  return functions.map(name => ({
    source: name, apiVersion: "beta",
    async collect(graph, signal, collectedAt) {
      const window = serviceActivityWindow(service.serviceActivity, Date.parse(collectedAt));
      const rows = isPercentageActivity(name)
        ? await readActivity(graph, name, percentageSchema, window, signal)
        : await readActivity(graph, name, valueSchema, window, signal);
      return rows.map(row => ({
        kind: "activity", service: type, collectedAt, function: name,
        intervalStart: row.intervalStartDateTime,
        intervalEnd: new Date(Date.parse(row.intervalStartDateTime) + window.aggregationIntervalMinutes * 60_000).toISOString(),
        aggregationIntervalMinutes: window.aggregationIntervalMinutes,
        ...("percentage" in row ? { percentage: row.percentage } : { value: row.value }),
      }));
    },
  }));
}
