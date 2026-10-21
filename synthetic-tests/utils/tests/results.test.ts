import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { InMemoryLogRecordExporter, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, DataPointType, InMemoryMetricExporter, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { isReportedStep, type SyntheticResult } from "../src/contracts.js";
import { baseResult, simulate } from "../src/probes.js";
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
  it("preserves all per-step and per-attempt logs at the thirty-target configuration limit", async () => {
    const { telemetry, logs } = memory();
    try {
      for (let index = 0; index < 30; index++) {
        const sample = await simulate({ id: `exchange-${index}`, type: "exchange-mail-flow", cohort: "exchange-global" }, {
          config: { SYNTHETIC_SCENARIO: "healthy", PROBE_TIMEOUT_MS: 45000, POLL_INTERVAL_MS: 100 },
          signal: new AbortController().signal, telemetry: output(),
        });
        telemetry.record(sample, "simulation");
      }
      await telemetry.forceFlush();
      const records = logs.getFinishedLogRecords();
      expect(records.filter(record => record.body === "synthetic-result")).toHaveLength(30);
      expect(records.filter(record => record.body === "synthetic-step")).toHaveLength(90);
    } finally { await telemetry.shutdown(); }
  });
  it.each(["exchange-mail-flow", "teams-channel-message", "sharepoint-file"] as const)(
    "exports timed step 1/0 samples for %s, never skipped steps or target dimensions", async type => {
      const { telemetry, metrics, logs } = memory();
      try {
        const sample = await simulate({ id: "opaque-probe", type, cohort: "opaque-cohort" }, {
          config: { SYNTHETIC_SCENARIO: "failed", PROBE_TIMEOUT_MS: 45000, POLL_INTERVAL_MS: 100 },
          signal: new AbortController().signal, telemetry: output(), now: () => Date.parse("2026-10-19T12:00:00Z"),
        });
        telemetry.record(sample, "simulation");
        await telemetry.forceFlush();
        const instruments = metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics));
        const success = instruments.find(metric => metric.descriptor.name === "synthetic.step.success");
        const duration = instruments.find(metric => metric.descriptor.name === "synthetic.step.duration");
        expect(success?.descriptor.unit).toBe("1");
        expect(duration?.descriptor.unit).toBe("s");
        const executed = sample.steps.filter(step => isReportedStep(step.name)).filter(step => step.status !== "skipped");
        expect(success?.dataPoints).toHaveLength(executed.length);
        expect(duration?.dataPoints).toHaveLength(executed.length);
        for (const step of executed) {
          const successPoint = success?.dataPoints.find(point => point.attributes["probe.step"] === step.name);
          expect(successPoint?.value).toMatchObject({ count: 1, sum: step.status === "succeeded" ? 1 : 0 });
          expect(duration?.dataPoints.find(point => point.attributes["probe.step"] === step.name)?.value)
            .toMatchObject({ count: 1, sum: step.durationMs / 1000 });
          expect(Object.keys(successPoint?.attributes ?? {}).sort()).toEqual([
            "probe.journey", "probe.mode", "probe.outcome", "probe.service", "probe.step",
          ]);
        }
        expect(instruments.find(metric => metric.descriptor.name === "synthetic.probe.success")?.dataPoints[0]?.value)
          .toMatchObject({ count: 1, sum: 0 });
        for (const instrument of instruments.filter(metric => !metric.descriptor.name.startsWith("synthetic.step."))) {
          expect(Object.keys(instrument.dataPoints[0]?.attributes ?? {}).sort())
            .toEqual(["probe.journey", "probe.mode", "probe.outcome", "probe.service"]);
        }
        const records = logs.getFinishedLogRecords();
        expect(records.filter(record => record.body === "synthetic-step")).toHaveLength(sample.steps.filter(step => isReportedStep(step.name)).length);
        expect(records.every(record => !["authenticate", "cleanup"].includes(String(record.attributes["probe.step"])))).toBe(true);
        expect(records.filter(record => record.body === "synthetic-result")).toHaveLength(1);
        expect(JSON.stringify(metrics.getMetrics())).not.toMatch(/opaque-probe|opaque-cohort|correlation_id/);
      } finally { await telemetry.shutdown(); }
    },
  );
  it("exports cleanup failure as zero without changing successful earlier step observations or delivery timing", async () => {
    const { telemetry, metrics } = memory();
    try {
      const sample = result({
        success: false, diagnosticCategory: "cleanup-failure", diagnosticContext: { cleanupSucceeded: false },
        steps: [
          { name: "authenticate", status: "succeeded", observedAt: new Date(1000).toISOString(), durationMs: 100 },
          { name: "create-draft", status: "succeeded", observedAt: new Date(1100).toISOString(), durationMs: 100 },
          { name: "send", status: "succeeded", observedAt: new Date(1200).toISOString(), durationMs: 100 },
          { name: "confirm-delivery", status: "succeeded", observedAt: new Date(1800).toISOString(), durationMs: 600 },
          { name: "cleanup", status: "failed", observedAt: new Date(1900).toISOString(), durationMs: 100, diagnosticCategory: "cleanup-failure" },
        ],
      });
      telemetry.record(sample, "live");
      await telemetry.forceFlush();
      const instruments = metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics));
      const success = instruments.find(metric => metric.descriptor.name === "synthetic.step.success");
      for (const point of success?.dataPoints ?? []) {
        expect(point.value).toMatchObject({ count: 1, sum: 1 });
        expect(["authenticate", "cleanup"]).not.toContain(point.attributes["probe.step"]);
      }
      expect(instruments.find(metric => metric.descriptor.name === "mailflow.delivery.duration")?.dataPoints[0]?.value)
        .toMatchObject({ count: 1, sum: 0.7 });
    } finally { await telemetry.shutdown(); }
  });
  it("does not fabricate blocked send/read observations on authentication failure", async () => {
    const { telemetry, metrics } = memory();
    try {
      const sample = result({ success: false, diagnosticCategory: "authentication-failure", steps: [
        { name: "authenticate", status: "failed", observedAt: new Date(1000).toISOString(), durationMs: 100, diagnosticCategory: "authentication-failure" },
        { name: "create-draft", status: "skipped", observedAt: new Date(1000).toISOString(), reason: "prerequisite-failed" },
        { name: "send", status: "skipped", observedAt: new Date(1000).toISOString(), reason: "prerequisite-failed" },
        { name: "confirm-delivery", status: "skipped", observedAt: new Date(1000).toISOString(), reason: "prerequisite-failed" },
        { name: "cleanup", status: "skipped", observedAt: new Date(1000).toISOString(), reason: "no-mutation" },
      ] });
      delete sample.deliveryDurationMs;
      telemetry.record(sample, "live");
      await telemetry.forceFlush();
      const steps = metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics))
        .filter(metric => metric.descriptor.name.startsWith("synthetic.step."));
      expect(steps).toHaveLength(0);
    } finally { await telemetry.shutdown(); }
  });
  it("rejects unbounded or wrong-journey step labels before exporting", async () => {
    const { telemetry } = memory();
    try {
      const step = { name: "send" as const, status: "succeeded" as const, observedAt: new Date(1000).toISOString(), durationMs: 100 };
      expect(() => telemetry.record(result({ steps: [{ ...step, name: "private-label" as never }] }), "live")).toThrow();
      expect(() => telemetry.record(result({ steps: [{ ...step, name: "post-message" }] }), "live")).toThrow();
      expect(() => telemetry.record(result({ steps: [step, step] }), "live")).toThrow();
      expect(() => telemetry.record({ ...result(), journey: "private-label" } as SyntheticResult, "live")).toThrow();
    } finally { await telemetry.shutdown(); }
  });
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
        "mailflow.delivery.duration", "synthetic.probe.duration", "synthetic.probe.success",
      ]);
      for (const instrument of instruments) {
        expect(instrument.aggregationTemporality).toBe(AggregationTemporality.DELTA);
        expect(instrument.dataPoints[0]?.attributes).toEqual({
          "probe.service": "exchange", "probe.journey": "send-receive-mail", "probe.mode": "live", "probe.outcome": "success",
        });
      }
      const success = instruments.find(metric => metric.descriptor.name === "synthetic.probe.success");
      expect(success?.descriptor.unit).toBe("1");
      expect(success?.dataPoints[0]?.value).toMatchObject({ count: 1, sum: 1 });
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
      const success = instruments.find(metric => metric.descriptor.name === "synthetic.probe.success");
      expect(success?.dataPoints).toHaveLength(2);
      expect(success?.dataPoints.find(point => point.attributes["probe.outcome"] === "success")?.value)
        .toMatchObject({ count: 2, sum: 2 });
      expect(success?.dataPoints.find(point => point.attributes["probe.outcome"] === "failure")?.value)
        .toMatchObject({ count: 1, sum: 0 });
      for (const instrument of instruments) {
        for (const point of instrument.dataPoints) {
          expect(Object.keys(point.attributes).sort()).toEqual([
            "probe.journey", "probe.mode", "probe.outcome", "probe.service",
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
  it("exports interval success samples rather than recounting previous intervals", async () => {
    const { telemetry, metrics, logs } = memory();
    try {
      telemetry.record(result(), "simulation");
      await telemetry.forceFlush();
      telemetry.record(result(), "simulation");
      telemetry.record(result(), "simulation");
      await telemetry.forceFlush();
      const success = metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics))
        .filter(metric => metric.descriptor.name === "synthetic.probe.success");
      expect(success.map(metric => metric.dataPoints[0]?.value)).toMatchObject([
        { count: 1, sum: 1 },
        { count: 2, sum: 2 },
      ]);
      expect(logs.getFinishedLogRecords()).toHaveLength(3);
      expect(success[0]?.dataPoints[0]?.attributes["probe.mode"]).toBe("simulation");
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
      expect(instruments.find(metric => metric.descriptor.name === "synthetic.probe.success")?.dataPoints[0]?.value)
        .toMatchObject({ count: 2, sum: 0 });
      expect(instruments.find(metric => metric.descriptor.name === "synthetic.probe.duration")?.dataPoints[0]?.value)
        .toMatchObject({ count: 2, sum: 3.2 });
      expect(instruments.find(metric => metric.descriptor.name === "mailflow.delivery.duration")?.dataPoints[0]?.value)
        .toMatchObject({ count: 1, sum: 0.7 });
      expect(logs.getFinishedLogRecords()[1]?.attributes).not.toHaveProperty("probe.cleanup_succeeded");
    } finally { await telemetry.shutdown(); }
  });
  it("calculates success from 0/1 observations independently for each service across unequal export batches", async () => {
    const { telemetry, metrics } = memory();
    try {
      const failure = result({
        success: false, diagnosticCategory: "delivery-timeout", durationMs: 2000,
      });
      delete failure.deliveryDurationMs;
      const unexecutable = result({
        success: false, diagnosticCategory: "authentication-failure", durationMs: 150,
      });
      delete unexecutable.deliveryDurationMs;
      const sharepoint = result({
        testType: "sharepoint-file", targetService: "SharePoint Online",
        success: false, diagnosticCategory: "read-failure",
      });
      delete sharepoint.deliveryDurationMs;

      telemetry.record(result(), "live");
      await telemetry.forceFlush();
      telemetry.record(result(), "live");
      telemetry.record(failure, "live");
      telemetry.record(unexecutable, "live");
      telemetry.record(sharepoint, "live");
      await telemetry.forceFlush();

      const totals = new Map<string, { successful: number; attempts: number }>();
      const instruments = metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics));
      for (const instrument of instruments) {
        if (instrument.descriptor.name !== "synthetic.probe.success") continue;
        if (instrument.dataPointType !== DataPointType.HISTOGRAM) {
          throw new Error("Success must preserve a sample count and sum");
        }
        for (const point of instrument.dataPoints) {
          const service = String(point.attributes["probe.service"]);
          const total = totals.get(service) ?? { successful: 0, attempts: 0 };
          total.successful += point.value.sum ?? 0;
          total.attempts += point.value.count;
          totals.set(service, total);
          if (point.attributes["probe.outcome"] === "unexecutable") {
            expect(point.value).toMatchObject({ count: 1, sum: 0 });
          }
        }
      }
      expect(totals.get("exchange")).toEqual({ successful: 2, attempts: 4 });
      expect(totals.get("sharepoint")).toEqual({ successful: 0, attempts: 1 });
      const exchange = totals.get("exchange")!;
      const sharepointTotal = totals.get("sharepoint")!;
      expect(100 * exchange.successful / exchange.attempts).toBe(50);
      expect(100 * sharepointTotal.successful / sharepointTotal.attempts).toBe(0);
    } finally { await telemetry.shutdown(); }
  });
  it("exports send request timing in seconds for accepted and failed requests, independently of delivery", async () => {
    const { telemetry, logs, metrics } = memory();
    try {
      telemetry.record(result({ sendDurationMs: 250 }), "live");
      const failed = result({
        success: false, diagnosticCategory: "send-failure", sendDurationMs: 350,
      });
      delete failed.deliveryDurationMs;
      telemetry.record(failed, "live");
      await telemetry.forceFlush();

      const instruments = metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics));
      const send = instruments.find(metric => metric.descriptor.name === "mailflow.send.duration");
      expect(send?.descriptor.unit).toBe("s");
      expect(send?.dataPoints.find(point => point.attributes["probe.outcome"] === "success")?.value)
        .toMatchObject({ count: 1, sum: 0.25 });
      expect(send?.dataPoints.find(point => point.attributes["probe.outcome"] === "failure")?.value)
        .toMatchObject({ count: 1, sum: 0.35 });
      expect(instruments.find(metric => metric.descriptor.name === "mailflow.delivery.duration")?.dataPoints)
        .toHaveLength(1);
      expect(logs.getFinishedLogRecords().map(log => log.attributes["probe.send_duration_ms"]))
        .toEqual([250, 350]);
    } finally { await telemetry.shutdown(); }
  });
  it("exports SharePoint upload and read requests independently with binary success", async () => {
    const { telemetry, metrics, logs } = memory();
    try {
      const sample = {
        ...baseResult({ id: "sp-001", type: "sharepoint-file", cohort: "sharepoint-global" }, Date.now()),
        success: true, durationMs: 1200, uploadDurationMs: 200, readDurationMs: 300,
      };
      telemetry.record(sample, "live");
      await telemetry.forceFlush();
      const instruments = metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics));
      expect(instruments.find(metric => metric.descriptor.name === "synthetic.probe.success")?.dataPoints[0]?.value)
        .toMatchObject({ count: 1, sum: 1 });
      expect(instruments.find(metric => metric.descriptor.name === "sharepoint.file.upload.duration")?.dataPoints[0]?.value)
        .toMatchObject({ count: 1, sum: 0.2 });
      expect(instruments.find(metric => metric.descriptor.name === "sharepoint.file.read.duration")?.dataPoints[0]?.value)
        .toMatchObject({ count: 1, sum: 0.3 });
      expect(instruments.every(metric => metric.descriptor.unit === (metric.descriptor.name === "synthetic.probe.success" ? "1" : "s"))).toBe(true);
      expect(logs.getFinishedLogRecords()[0]?.attributes).toMatchObject({
        "probe.service": "sharepoint", "probe.upload_duration_ms": 200, "probe.read_duration_ms": 300,
      });
    } finally { await telemetry.shutdown(); }
  });
  it("exports Teams Connector send and confirmed channel publication separately, not as Exchange timings", async () => {
    const { telemetry, metrics, logs } = memory();
    try {
      const sample = {
        ...baseResult({ id: "teams-001", type: "teams-channel-message", cohort: "teams-global" }, Date.now()),
        success: false, diagnosticCategory: "cleanup-failure" as const,
        durationMs: 1200, sendDurationMs: 200, publicationDurationMs: 700,
        diagnosticContext: { cleanupSucceeded: false },
      };
      telemetry.record(sample, "live");
      await telemetry.forceFlush();
      const instruments = metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics));
      expect(instruments.find(metric => metric.descriptor.name === "synthetic.probe.success")?.dataPoints[0]?.value)
        .toMatchObject({ count: 1, sum: 0 });
      expect(instruments.find(metric => metric.descriptor.name === "teams.message.send.duration")?.dataPoints[0]?.value)
        .toMatchObject({ count: 1, sum: 0.2 });
      expect(instruments.find(metric => metric.descriptor.name === "teams.message.publication.duration")?.dataPoints[0]?.value)
        .toMatchObject({ count: 1, sum: 0.7 });
      expect(instruments.some(metric => metric.descriptor.name.startsWith("mailflow."))).toBe(false);
      for (const metric of instruments) {
        expect(metric.dataPoints[0]?.attributes).toEqual({
          "probe.service": "teams", "probe.journey": "publish-channel-message", "probe.mode": "live", "probe.outcome": "failure",
        });
      }
      expect(logs.getFinishedLogRecords()[0]?.attributes).toMatchObject({
        "probe.service": "teams", "probe.publication_duration_ms": 700,
      });
      expect(logs.getFinishedLogRecords()[0]?.attributes).not.toHaveProperty("probe.cleanup_succeeded");
    } finally { await telemetry.shutdown(); }
  });
  it("does not fabricate Exchange send or delivery duration for SharePoint", async () => {
    const { telemetry, metrics } = memory();
    try {
      const sample = result({ testType: "sharepoint-file", targetService: "SharePoint Online" });
      delete sample.deliveryDurationMs;
      telemetry.record(sample, "live");
      await telemetry.forceFlush();
      expect(metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics))
        .some(metric => ["mailflow.send.duration", "mailflow.delivery.duration"].includes(metric.descriptor.name))).toBe(false);
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
