import {
  AzureMonitorLogExporter, AzureMonitorMetricExporter, type AzureMonitorExporterOptions,
} from "@azure/monitor-opentelemetry-exporter";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import type { PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { ConfigurationError } from "./config.js";
import type { Telemetry } from "./contracts.js";
import { consoleExporters, createResultTelemetry, TelemetryExportError, type ResultTelemetry } from "./results.js";
import { resultSchema } from "./contracts.js";
import { providerLog } from "./provider-diagnostics.js";

export function validateConnectionString(env: NodeJS.ProcessEnv): string {
  const value = env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  const fail = () => new ConfigurationError("azure-monitor telemetry requires a valid APPLICATIONINSIGHTS_CONNECTION_STRING");
  if (!value) throw fail();
  const fields = new Map<string, string>();
  for (const pair of value.split(";")) {
    const match = /^([a-zA-Z]+)=([^=;\s]+)$/.exec(pair);
    if (!match || fields.has(match[1]!.toLowerCase())) throw fail();
    fields.set(match[1]!.toLowerCase(), match[2]!);
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(fields.get("instrumentationkey") ?? "")) throw fail();
  if (fields.has("authorization") && fields.get("authorization")!.toLowerCase() !== "ikey") throw fail();
  for (const [key, endpoint] of fields) {
    if (key.endsWith("endpoint")) {
      try {
        const url = new URL(endpoint);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw fail();
      } catch { throw fail(); }
    }
  }
  for (const key of ["endpointsuffix", "location"]) {
    if (fields.has(key) && !/^[a-zA-Z0-9.-]+$/.test(fields.get(key)!)) throw fail();
  }
  return value;
}

export interface AzureExporterFactory {
  logs(options: AzureMonitorExporterOptions): LogRecordExporter;
  metrics(options: AzureMonitorExporterOptions): PushMetricExporter;
}
const azureExporters: AzureExporterFactory = {
  logs: options => new AzureMonitorLogExporter(options),
  metrics: options => new AzureMonitorMetricExporter(options),
};

export async function createProbeTelemetry(
  destination: "none" | "console" | "azure-monitor", output: Telemetry, env: NodeJS.ProcessEnv,
  factory: AzureExporterFactory = azureExporters,
): Promise<ResultTelemetry> {
  if (destination === "none") {
    return {
      record: (result, mode) => output.emit("synthetic-result", { mode, result: resultSchema.parse(result) }),
      recordDiagnostic: record => {
        const log = providerLog(record);
        output.emit("provider-diagnostic", { body: log.body, attributes: log.attributes });
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    };
  }
  if (destination === "console") return createResultTelemetry(consoleExporters(output), output);
  const connectionString = validateConnectionString(env);
  const options: AzureMonitorExporterOptions = {
    connectionString, disableOfflineStorage: true, retryOptions: { maxRetries: 0 },
    // The beta exporter treats ingestion throttling as success; enforce rejection and bound HTTP requests.
    additionalPolicies: [{
      position: "perCall",
      policy: {
        name: "synthetic-telemetry-status",
        async sendRequest(request, next) {
          request.timeout = 5000;
          try {
            const response = await next(request);
            if (response.status !== 200) throw new TelemetryExportError();
            return response;
          } catch {
            // Do not let the beta exporter acknowledge a failed request as an offline-storage success.
            throw new TelemetryExportError();
          }
        },
      },
    }],
  };
  let logs: LogRecordExporter | undefined;
  let metrics: PushMetricExporter | undefined;
  const statsbeat = process.env.APPLICATION_INSIGHTS_NO_STATSBEAT;
  try {
    // No exporter self-monitoring singleton, resource discovery, or extra background providers.
    process.env.APPLICATION_INSIGHTS_NO_STATSBEAT = "true";
    logs = factory.logs(options);
    metrics = factory.metrics(options);
    return createResultTelemetry({ logs, metrics }, output);
  } catch {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([
          Promise.resolve().then(() => logs?.shutdown()),
          Promise.resolve().then(() => metrics?.shutdown()),
        ]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 5500); }),
      ]);
    } finally { clearTimeout(timer); }
    throw new ConfigurationError("Cannot initialize azure-monitor telemetry exporters");
  } finally {
    if (statsbeat === undefined) delete process.env.APPLICATION_INSIGHTS_NO_STATSBEAT;
    else process.env.APPLICATION_INSIGHTS_NO_STATSBEAT = statsbeat;
  }
}
