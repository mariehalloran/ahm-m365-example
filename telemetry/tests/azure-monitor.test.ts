import { describe, expect, it, vi } from "vitest";
import { AzureMonitorLogExporter, AzureMonitorMetricExporter } from "@azure/monitor-opentelemetry-exporter";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, InMemoryMetricExporter, InstrumentType } from "@opentelemetry/sdk-metrics";
import { baseResult } from "../../shared/src/probes.js";
import { runServiceWorker } from "../../runner/src/worker.js";
import { parseServiceConfig } from "../../runner/src/service-config.js";
import { createProbeTelemetry, validateConnectionString, type AzureExporterFactory } from "../src/azure-monitor.js";

const connectionString = "InstrumentationKey=11111111-1111-4111-8111-111111111111;IngestionEndpoint=https://telemetry.example.invalid";
const env = { APPLICATIONINSIGHTS_CONNECTION_STRING: connectionString };
const output = () => ({ emit: vi.fn() });
const sample = () => ({
  ...baseResult({ id: "ex-001", type: "exchange-mail-flow", cohort: "exchange-global" }, Date.parse("2026-10-19T12:00:00Z")),
  success: true, durationMs: 1600, deliveryDurationMs: 700,
});

describe("explicit Azure Monitor configuration", () => {
  it.each([
    undefined, "", "secret-value", "InstrumentationKey=secret-value",
    `${connectionString};IngestionEndpoint=https://duplicate.invalid`,
    `${connectionString};Authorization=secret`,
    "InstrumentationKey=11111111-1111-4111-8111-111111111111;IngestionEndpoint=http://plain.invalid",
    "InstrumentationKey=11111111-1111-4111-8111-111111111111;IngestionEndpoint=https://user:secret@private.invalid",
    `${connectionString};EndpointSuffix=../../unsafe`,
  ])("rejects missing/malformed configuration without echoing supplied data", value => {
    const error = (() => {
      try { validateConnectionString(value === undefined ? {} : { APPLICATIONINSIGHTS_CONNECTION_STRING: value }); }
      catch (caught) { return caught as Error; }
    })();
    expect(error?.message).toBe("azure-monitor telemetry requires a valid APPLICATIONINSIGHTS_CONNECTION_STRING");
  });
  it("constructs neither Azure exporter nor credentials in console mode", async () => {
    const factory = { logs: vi.fn(), metrics: vi.fn() };
    const telemetry = await createProbeTelemetry("console", output(), {}, factory);
    await telemetry.shutdown();
    expect(factory.logs).not.toHaveBeenCalled();
    expect(factory.metrics).not.toHaveBeenCalled();
  });
  it("fails before exporter creation for invalid Azure config; never falls back to console", async () => {
    const factory = { logs: vi.fn(), metrics: vi.fn() };
    const events = output();
    await expect(createProbeTelemetry("azure-monitor", events, {}, factory)).rejects.toThrow("APPLICATIONINSIGHTS_CONNECTION_STRING");
    expect(factory.logs).not.toHaveBeenCalled();
    expect(factory.metrics).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
  it("disables disk storage and Statsbeat, and cleans up partial startup without exposing errors", async () => {
    const logs = new InMemoryLogRecordExporter();
    const shutdown = vi.spyOn(logs, "shutdown");
    const prior = process.env.APPLICATION_INSIGHTS_NO_STATSBEAT;
    const factory: AzureExporterFactory = {
      logs: vi.fn(options => {
        expect(options.disableOfflineStorage).toBe(true);
        expect(options).not.toHaveProperty("storageDirectory");
        expect(process.env.APPLICATION_INSIGHTS_NO_STATSBEAT).toBe("true");
        return logs;
      }),
      metrics: () => { throw new Error("private startup response"); },
    };
    await expect(createProbeTelemetry("azure-monitor", output(), env, factory)).rejects.toThrow("Cannot initialize azure-monitor telemetry exporters");
    expect(shutdown).toHaveBeenCalledOnce();
    expect(process.env.APPLICATION_INSIGHTS_NO_STATSBEAT).toBe(prior);
  });
});

describe("real Azure exporters through an in-process mock transport", () => {
  it("maps ordinary logs to MessageData and delta histogram sums/counts, with no HTTP/ARM/Blob autocollection", async () => {
    const requests: { url: string; envelopes: Record<string, any>[] }[] = [];
    const factory: AzureExporterFactory = {
      logs: options => new AzureMonitorLogExporter({ ...options, httpClient: {
        async sendRequest(request) {
          requests.push({ url: request.url, envelopes: JSON.parse(String(request.body)) });
          return { request, status: 200, headers: request.headers, bodyAsText: "{}" };
        },
      } }),
      metrics: options => {
        const exporter = new AzureMonitorMetricExporter({ ...options, httpClient: {
          async sendRequest(request) {
            requests.push({ url: request.url, envelopes: JSON.parse(String(request.body)) });
            return { request, status: 200, headers: request.headers, bodyAsText: "{}" };
          },
        } });
        expect(exporter.selectAggregationTemporality(InstrumentType.COUNTER)).toBe(AggregationTemporality.DELTA);
        expect(exporter.selectAggregationTemporality(InstrumentType.HISTOGRAM)).toBe(AggregationTemporality.DELTA);
        return exporter;
      },
    };
    const telemetry = await createProbeTelemetry("azure-monitor", output(), env, factory);
    try {
      telemetry.record(sample(), "live");
      await telemetry.forceFlush();
      expect(requests).toHaveLength(2);
      expect(requests.every(request => request.url.startsWith("https://telemetry.example.invalid/"))).toBe(true);
      const envelopes = requests.flatMap(request => request.envelopes);
      const log = envelopes.find(envelope => envelope.data.baseType === "MessageData");
      expect(log?.data.baseData.message).toBe("synthetic-result");
      expect(log?.time).toBe("2026-10-19T12:00:00.000Z");
      expect(log?.sampleRate).toBe(100);
      expect(log?.data.baseData.properties["probe.schema_version"]).toBe("2.0");
      const metrics = envelopes.filter(envelope => envelope.data.baseType === "MetricData");
      const points = metrics.flatMap(envelope => envelope.data.baseData.metrics);
      expect(points.find(point => point.name === "synthetic.probe.runs")).toMatchObject({ value: 1, count: 1 });
      expect(points.find(point => point.name === "synthetic.probe.duration")).toMatchObject({ value: 1.6, count: 1 });
      expect(points.find(point => point.name === "mailflow.delivery.duration")).toMatchObject({ value: 0.7, count: 1 });
      expect(envelopes.every(envelope => ["MessageData", "MetricData"].includes(envelope.data.baseType))).toBe(true);
    } finally { await telemetry.shutdown(); }
  });
  it.each([206, 307, 308, 400, 429, 500])("surfaces ingestion status %s instead of accepting the beta exporter's silent drop", async status => {
    const events = output();
    const factory: AzureExporterFactory = {
      logs: options => new AzureMonitorLogExporter({ ...options, httpClient: {
        async sendRequest(request) {
          expect(request.timeout).toBe(5000);
          return { request, status, headers: request.headers, bodyAsText: "private-response-body" };
        },
      } }),
      metrics: () => new InMemoryMetricExporter(AggregationTemporality.DELTA),
    };
    const telemetry = await createProbeTelemetry("azure-monitor", events, env, factory);
    telemetry.record(sample(), "live");
    await expect(telemetry.forceFlush()).rejects.toThrow("Probe telemetry export failed");
    await telemetry.shutdown();
    expect(events.emit).toHaveBeenCalledWith("telemetry-export-failed", { signal: "logs", category: "collector-failure" });
    expect(JSON.stringify(events.emit.mock.calls)).not.toMatch(/private-response-body|InstrumentationKey/);
  });
  it("makes --once fail, flushes and shuts down both providers after a failed export", async () => {
    const events = output();
    const logs = new InMemoryLogRecordExporter();
    vi.spyOn(logs, "export").mockImplementation((_records, callback) => callback({ code: 1, error: new Error("private") }));
    const metrics = new InMemoryMetricExporter(AggregationTemporality.DELTA);
    const stopLogs = vi.spyOn(logs, "shutdown");
    const stopMetrics = vi.spyOn(metrics, "shutdown");
    const service = parseServiceConfig({
      type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation",
      cohort: "exchange-global", telemetry: "azure-monitor", targets: [{ id: "ex-001" }],
    });
    await expect(runServiceWorker(service, {
      once: true, env, telemetry: events,
      createDependencies: async (_service, _config, scoped) => ({
        telemetry: scoped, results: await createProbeTelemetry("azure-monitor", scoped, env, {
          logs: () => logs, metrics: () => metrics,
        }),
      }),
    })).rejects.toThrow("Synthetic cycle failed");
    expect(stopLogs).toHaveBeenCalledOnce();
    expect(stopMetrics).toHaveBeenCalledOnce();
    expect(JSON.stringify(events.emit.mock.calls)).not.toMatch(/private|service-cycle-summary/);
  });
});
