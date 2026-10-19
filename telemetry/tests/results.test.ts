import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { InMemoryLogRecordExporter, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, InMemoryMetricExporter, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { SyntheticResult } from "../../shared/src/contracts.js";
import { baseResult } from "../../shared/src/probes.js";
import { createResultTelemetry, outcomeOf } from "../src/results.js";

afterEach(() => vi.useRealTimers());
const output = () => ({ emit: vi.fn() });
function result(overrides: Partial<SyntheticResult> = {}): SyntheticResult {
  return {
    ...baseResult({ id: "ex-001", type: "exchange-mail-flow", cohort: "exchange-global" }, Date.parse("2026-10-19T12:00:00Z")),
    success: true, durationMs: 1600, deliveryDurationMs: 700, ...overrides,
  };
}
function memory() {
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const events = output();
  return { logs, metrics, events, telemetry: createResultTelemetry({ logs, metrics }, events) };
}

describe("real isolated OTel measurements", () => {
  it("emits one flat, timestamped log and the exact instruments with seconds and bounded dimensions", async () => {
    const { telemetry, logs, metrics } = memory();
    try {
      const sample = result();
      telemetry.record(sample, "live");
      await telemetry.forceFlush();
      const entries = logs.getFinishedLogRecords();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        body: "synthetic-result", hrTime: [Date.parse(sample.observedAt) / 1000, 0],
        attributes: {
          "probe.schema_version": "2.0", "probe.service": "exchange", "probe.cohort": "exchange-global",
          "probe.id": sample.testId, "probe.correlation_id": sample.correlationId, "probe.mode": "live",
          "probe.success": true, "probe.outcome": "success", "probe.observed_at": sample.observedAt,
          "probe.duration_ms": 1600, "probe.delivery_duration_ms": 700, "probe.diagnostic_category": "none",
        },
      });
      const instruments = metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics));
      expect(instruments.map(metric => metric.descriptor.name).sort()).toEqual([
        "mailflow.delivery.duration", "synthetic.probe.duration", "synthetic.probe.runs",
      ]);
      for (const instrument of instruments) {
        expect(instrument.aggregationTemporality).toBe(AggregationTemporality.DELTA);
        expect(instrument.dataPoints[0]?.attributes).toEqual({
          "probe.service": "exchange", "probe.mode": "live", "probe.outcome": "success",
        });
      }
      expect(instruments.find(metric => metric.descriptor.name === "synthetic.probe.runs")?.dataPoints[0]?.value).toBe(1);
      const total = instruments.find(metric => metric.descriptor.name === "synthetic.probe.duration");
      expect(total?.descriptor.unit).toBe("s");
      expect(total?.dataPoints[0]?.value).toMatchObject({ count: 1, sum: 1.6 });
      expect(instruments.find(metric => metric.descriptor.name === "mailflow.delivery.duration")?.dataPoints[0]?.value)
        .toMatchObject({ count: 1, sum: 0.7 });
    } finally { await telemetry.shutdown(); }
  });
  it("aggregates different targets into service-level measurements without mailbox or probe dimensions", async () => {
    const { telemetry, metrics } = memory();
    try {
      telemetry.record(result({ testId: "ex-001", cohort: "first-cohort" }), "live");
      telemetry.record(result({
        testId: "ex-002", cohort: "second-cohort", durationMs: 2400, deliveryDurationMs: 1700,
      }), "live");
      const timeout = result({
        testId: "ex-003", cohort: "third-cohort", success: false,
        diagnosticCategory: "delivery-timeout", durationMs: 4000,
      });
      delete timeout.deliveryDurationMs;
      telemetry.record(timeout, "live");
      await telemetry.forceFlush();

      const instruments = metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics));
      const runs = instruments.find(metric => metric.descriptor.name === "synthetic.probe.runs");
      expect(runs?.dataPoints).toHaveLength(2);
      expect(runs?.dataPoints.find(point => point.attributes["probe.outcome"] === "success")?.value).toBe(2);
      expect(runs?.dataPoints.find(point => point.attributes["probe.outcome"] === "failure")?.value).toBe(1);
      for (const instrument of instruments) {
        for (const point of instrument.dataPoints) {
          expect(Object.keys(point.attributes).sort()).toEqual([
            "probe.mode", "probe.outcome", "probe.service",
          ]);
        }
      }
      expect(instruments.find(metric => metric.descriptor.name === "synthetic.probe.duration")?.dataPoints
        .find(point => point.attributes["probe.outcome"] === "success")?.value).toMatchObject({
          count: 2, sum: 4,
        });
      expect(instruments.find(metric => metric.descriptor.name === "mailflow.delivery.duration")?.dataPoints[0]?.value)
        .toMatchObject({ count: 2, sum: 2.4 });
    } finally { await telemetry.shutdown(); }
  });
  it("exports delta counts rather than recounting previous intervals", async () => {
    const { telemetry, metrics, logs } = memory();
    try {
      telemetry.record(result(), "simulation");
      await telemetry.forceFlush();
      telemetry.record(result(), "simulation");
      telemetry.record(result(), "simulation");
      await telemetry.forceFlush();
      const runs = metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics))
        .filter(metric => metric.descriptor.name === "synthetic.probe.runs");
      expect(runs.map(metric => metric.dataPoints[0]?.value)).toEqual([1, 2]);
      expect(logs.getFinishedLogRecords()).toHaveLength(3);
      expect(runs[0]?.dataPoints[0]?.attributes["probe.mode"]).toBe("simulation");
    } finally { await telemetry.shutdown(); }
  });
  it("counts every attempt but records delivery only for confirmed delivery, including subsequent cleanup failure", async () => {
    const { telemetry, metrics, logs } = memory();
    try {
      const timeout = result({ success: false, diagnosticCategory: "delivery-timeout", diagnosticContext: { cleanupSucceeded: true } });
      delete timeout.deliveryDurationMs;
      telemetry.record(timeout, "live");
      telemetry.record(result({ success: false, diagnosticCategory: "cleanup-failure", diagnosticContext: { cleanupSucceeded: false } }), "live");
      await telemetry.forceFlush();
      const instruments = metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics));
      expect(instruments.find(metric => metric.descriptor.name === "synthetic.probe.runs")?.dataPoints[0]?.value).toBe(2);
      expect(instruments.find(metric => metric.descriptor.name === "synthetic.probe.duration")?.dataPoints[0]?.value)
        .toMatchObject({ count: 2, sum: 3.2 });
      expect(instruments.find(metric => metric.descriptor.name === "mailflow.delivery.duration")?.dataPoints[0]?.value)
        .toMatchObject({ count: 1, sum: 0.7 });
      expect(logs.getFinishedLogRecords()[1]?.attributes["probe.cleanup_succeeded"]).toBe(false);
    } finally { await telemetry.shutdown(); }
  });
  it("does not fabricate Exchange delivery duration for SharePoint", async () => {
    const { telemetry, metrics } = memory();
    try {
      const sample = result({ testType: "sharepoint-file", targetService: "SharePoint Online" });
      delete sample.deliveryDurationMs;
      telemetry.record(sample, "live");
      await telemetry.forceFlush();
      expect(metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics))
        .some(metric => metric.descriptor.name === "mailflow.delivery.duration")).toBe(false);
    } finally { await telemetry.shutdown(); }
  });
  it("records authentication failure as an unexecutable attempt, not service downtime or missing data", async () => {
    const { telemetry, logs, metrics } = memory();
    try {
      const sample = result({ success: false, diagnosticCategory: "authentication-failure", durationMs: 150 });
      delete sample.deliveryDurationMs;
      telemetry.record(sample, "live");
      await telemetry.forceFlush();
      expect(logs.getFinishedLogRecords()[0]?.attributes).toMatchObject({
        "probe.outcome": "unexecutable", "probe.success": false, "probe.duration_ms": 150,
      });
      expect(metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics))
        .every(metric => metric.dataPoints.every(point => point.attributes["probe.outcome"] === "unexecutable"))).toBe(true);
    } finally { await telemetry.shutdown(); }
  });
  it("allowlists safe fields and refuses malformed measurements before recording anything", async () => {
    const { telemetry, metrics, logs } = memory();
    try {
      telemetry.record(result({ diagnosticContext: { region: "private@example.invalid", authenticationDurationMs: 123 } }), "live");
      for (const durationMs of [-1, Infinity, NaN]) expect(() => telemetry.record(result({ durationMs }), "live")).toThrow();
      expect(() => telemetry.record({ ...result(), mailbox: "private@example.invalid" } as SyntheticResult, "live")).toThrow();
      await telemetry.forceFlush();
      const exported = JSON.stringify([metrics.getMetrics(), logs.getFinishedLogRecords()]);
      expect(exported).not.toContain("private@example.invalid");
      expect(exported).not.toContain("authenticationDurationMs");
      expect(logs.getFinishedLogRecords()).toHaveLength(1);
    } finally { await telemetry.shutdown(); }
  });
  it.each([
    ["authentication-failure", "unexecutable"], ["permission-failure", "unexecutable"],
    ["collector-failure", "unexecutable"], ["malformed-response", "unexecutable"],
    ["graph-throttling", "unexecutable"], ["cancelled", "unexecutable"],
    ["delivery-timeout", "failure"], ["cleanup-failure", "failure"], ["send-failure", "failure"],
    ["read-failure", "failure"], ["graph-unavailable", "failure"],
  ] as const)("classifies %s as %s without declaring health", (diagnosticCategory, expected) => {
    expect(outcomeOf(result({ success: false, diagnosticCategory }))).toBe(expected);
  });
});

describe("sanitized export failures and bounded lifecycle", () => {
  it("waits for an already-started batch export instead of claiming a successful one-shot flush", async () => {
    vi.useFakeTimers();
    let finish!: (result: ExportResult) => void;
    const logs: LogRecordExporter = {
      export: vi.fn((_records, callback) => { finish = callback; }),
      shutdown: async () => undefined,
    };
    const telemetry = createResultTelemetry({ logs, metrics: new InMemoryMetricExporter(AggregationTemporality.DELTA) }, output(), 10000);
    telemetry.record(result(), "live");
    await vi.advanceTimersByTimeAsync(5000);
    expect(logs.export).toHaveBeenCalledOnce();
    let settled = false;
    const flushed = expect(telemetry.forceFlush()).rejects.toThrow("Probe telemetry export failed").finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    finish({ code: ExportResultCode.FAILED, error: new Error("private") });
    await flushed;
    await telemetry.shutdown();
  });
  it.each(["logs", "metrics"] as const)("surfaces failed %s callbacks even when the SDK swallows them", async signal => {
    const logs = new InMemoryLogRecordExporter();
    const metrics = new InMemoryMetricExporter(AggregationTemporality.DELTA);
    const events = output();
    vi.spyOn(signal === "logs" ? logs : metrics, "export").mockImplementation((_batch: unknown, callback: (result: ExportResult) => void) => {
      callback({ code: ExportResultCode.FAILED, error: new Error("private-response-body connection-string") });
    });
    const telemetry = createResultTelemetry({ logs, metrics }, events);
    telemetry.record(result(), "live");
    await expect(telemetry.forceFlush()).rejects.toThrow("Probe telemetry export failed");
    expect(events.emit).toHaveBeenCalledWith("telemetry-export-failed", { signal, category: "collector-failure" });
    expect(JSON.stringify(events.emit.mock.calls)).not.toMatch(/private-response|connection-string/);
    await telemetry.shutdown();
  });
  it.each(["throw", "reject"] as const)("sanitizes exporter %s errors", async behavior => {
    const logs: LogRecordExporter = {
      export: behavior === "throw" ? () => { throw new Error("private"); } : async () => { throw new Error("private"); },
      shutdown: vi.fn(async () => undefined),
    };
    const events = output();
    const telemetry = createResultTelemetry({ logs, metrics: new InMemoryMetricExporter(AggregationTemporality.DELTA) }, events);
    telemetry.record(result(), "live");
    await expect(telemetry.forceFlush()).rejects.toThrow("Probe telemetry export failed");
    await telemetry.shutdown();
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain("private");
    expect(logs.shutdown).toHaveBeenCalledOnce();
  });
  it("bounds a hung exporter, shuts down and does not persist or retry an outbox", async () => {
    vi.useFakeTimers();
    const logs = { export: vi.fn(), shutdown: vi.fn(async () => undefined) };
    const metrics = new InMemoryMetricExporter(AggregationTemporality.DELTA);
    const telemetry = createResultTelemetry({ logs, metrics }, output(), 50);
    telemetry.record(result(), "live");
    const flushed = expect(telemetry.forceFlush()).rejects.toThrow("Probe telemetry export failed");
    await vi.advanceTimersByTimeAsync(50);
    await flushed;
    await telemetry.shutdown();
    expect(logs.export).toHaveBeenCalledOnce();
    expect(logs.shutdown).toHaveBeenCalledOnce();
    expect(() => telemetry.record(result(), "live")).toThrow();
  });
  it("bounds shutdown and attempts both exporters even if one fails", async () => {
    vi.useFakeTimers();
    const logs = new InMemoryLogRecordExporter();
    const metrics: PushMetricExporter = {
      export: (_batch, callback) => callback({ code: ExportResultCode.SUCCESS }),
      forceFlush: async () => undefined, shutdown: vi.fn(async () => new Promise<never>(() => undefined)),
    };
    const shutdownLogs = vi.spyOn(logs, "shutdown");
    const telemetry = createResultTelemetry({ logs, metrics }, output(), 50);
    const stopped = expect(telemetry.shutdown()).rejects.toThrow("Probe telemetry export failed");
    await vi.advanceTimersByTimeAsync(550);
    await stopped;
    expect(shutdownLogs).toHaveBeenCalledOnce();
    expect(metrics.shutdown).toHaveBeenCalledOnce();
    await telemetry.shutdown();
  });
  it("allows the next independent export after a failed cycle without replaying dropped records", async () => {
    const logs = new InMemoryLogRecordExporter();
    const exported = vi.spyOn(logs, "export");
    exported.mockImplementationOnce((_records, callback) => callback({ code: ExportResultCode.FAILED }));
    const telemetry = createResultTelemetry({ logs, metrics: new InMemoryMetricExporter(AggregationTemporality.DELTA) }, output());
    telemetry.record(result(), "live");
    await expect(telemetry.forceFlush()).rejects.toThrow();
    const next = result();
    telemetry.record(next, "live");
    await telemetry.forceFlush();
    expect(logs.getFinishedLogRecords().map(record => record.attributes["probe.correlation_id"])).toEqual([next.correlationId]);
    expect(exported).toHaveBeenCalledTimes(2);
    await telemetry.shutdown();
  });
});
