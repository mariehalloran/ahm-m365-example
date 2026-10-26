import type { Attributes } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality, MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { probeServices, reportedResult, resultSchema, type SyntheticResult, type Telemetry } from "./contracts.js";
import { providerLog } from "./provider-diagnostics.js";
import { outcomeOf, type ExecutionMode, type ResultOutput } from "./results.js";
import { callQualityMeasurements, callQualitySignals } from "./health-reports.js";
import { callQualityMetricNames } from "./teams-call-quality.js";

export interface ResultTelemetry extends ResultOutput {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export class TelemetryExportError extends Error {
  constructor() { super("Probe telemetry export failed"); this.name = "TelemetryExportError"; }
}

export function resultAttributes(result: SyntheticResult, mode: ExecutionMode): Attributes {
  return {
    "probe.schema_version": result.schemaVersion,
    "probe.service": probeServices[result.testType].service,
    "probe.journey": probeServices[result.testType].journey,
    "probe.cohort": result.cohort ?? "unspecified",
    "probe.id": result.testId,
    "probe.correlation_id": result.correlationId,
    "probe.mode": mode,
    "probe.success": result.success,
    "probe.outcome": outcomeOf(result),
    "probe.observed_at": result.observedAt,
    "probe.duration_ms": result.durationMs,
    "probe.diagnostic_category": result.diagnosticCategory ?? "none",
    ...(result.sendDurationMs === undefined ? {} : { "probe.send_duration_ms": result.sendDurationMs }),
    ...(result.deliveryDurationMs === undefined ? {} : { "probe.delivery_duration_ms": result.deliveryDurationMs }),
    ...(result.publicationDurationMs === undefined ? {} : { "probe.publication_duration_ms": result.publicationDurationMs }),
  };
}

export function consoleExporters(output: Telemetry): { logs: LogRecordExporter; metrics: PushMetricExporter } {
  return {
    logs: {
      export(records, callback) {
        for (const record of records) output.emit("otel-log", { body: record.body, attributes: record.attributes });
        callback({ code: ExportResultCode.SUCCESS });
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    },
    metrics: {
      export(metrics, callback) {
        for (const scope of metrics.scopeMetrics) {
          for (const metric of scope.metrics) output.emit("probe-metrics", {
            name: metric.descriptor.name, unit: metric.descriptor.unit,
            temporality: "delta", dataPoints: metric.dataPoints,
          });
        }
        callback({ code: ExportResultCode.SUCCESS });
      },
      selectAggregationTemporality: () => AggregationTemporality.DELTA,
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    },
  };
}

export function createResultTelemetry(
  exporters: { logs: LogRecordExporter; metrics: PushMetricExporter },
  output: Telemetry, timeoutMs = 5000,
): ResultTelemetry {
  let failed = false;
  let closed = false;
  const activeExports = new Set<Promise<void>>();
  const reportFailure = (signal: "logs" | "metrics" | "lifecycle") => {
    failed = true;
    output.emit("telemetry-export-failed", { signal, category: "collector-failure" });
  };
  // SDK processors may swallow failed callbacks; retain sanitized status for the cycle flush.
  const checkedExport = <T>(
    signal: "logs" | "metrics",
    exportBatch: (data: T, callback: (result: ExportResult) => void) => void,
  ) => (data: T, callback: (result: ExportResult) => void): void => {
    let completed = false;
    let resolveExport!: () => void;
    const pending = new Promise<void>(resolve => { resolveExport = resolve; });
    activeExports.add(pending);
    const finish = (result: ExportResult) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      try {
        if (result.code !== ExportResultCode.SUCCESS) reportFailure(signal);
        callback(result.code === ExportResultCode.SUCCESS
          ? { code: ExportResultCode.SUCCESS }
          : { code: ExportResultCode.FAILED, error: new TelemetryExportError() });
      } finally {
        activeExports.delete(pending);
        resolveExport();
      }
    };
    const timer = setTimeout(() => finish({ code: ExportResultCode.FAILED }), timeoutMs);
    try {
      Promise.resolve(exportBatch(data, finish)).catch(() => finish({ code: ExportResultCode.FAILED }));
    } catch { finish({ code: ExportResultCode.FAILED }); }
  };
  const reader = new PeriodicExportingMetricReader({
    exporter: {
      export: checkedExport("metrics", exporters.metrics.export.bind(exporters.metrics)),
      selectAggregationTemporality: type => exporters.metrics.selectAggregationTemporality?.(type) ?? AggregationTemporality.DELTA,
      ...(exporters.metrics.selectAggregation ? { selectAggregation: exporters.metrics.selectAggregation.bind(exporters.metrics) } : {}),
      forceFlush: () => exporters.metrics.forceFlush(),
      shutdown: () => exporters.metrics.shutdown(),
    },
    exportIntervalMillis: 60000,
    exportTimeoutMillis: timeoutMs + 100,
  });
  const resource = resourceFromAttributes({ "service.name": "m365-synthetic-probes" });
  const meters = new MeterProvider({ resource, readers: [reader] });
  const loggers = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({
      exporter: {
        export: checkedExport("logs", exporters.logs.export.bind(exporters.logs)),
        forceFlush: () => exporters.logs.forceFlush(),
        shutdown: () => exporters.logs.shutdown(),
      },
      maxQueueSize: 2048, maxExportBatchSize: 128, scheduledDelayMillis: 5000, exportTimeoutMillis: timeoutMs + 100,
    })],
  });
  const meter = meters.getMeter("m365-synthetic-probes", "2.0");
  const logger = loggers.getLogger("m365-synthetic-probes", "2.0");
  const success = meter.createHistogram("synthetic.probe.success", { unit: "1" });
  const duration = meter.createHistogram("synthetic.probe.duration", { unit: "s" });
  const stepSuccess = meter.createHistogram("synthetic.step.success", { unit: "1" });
  const stepDuration = meter.createHistogram("synthetic.step.duration", { unit: "s" });
  const phaseDurations = {
    sendDurationMs: meter.createHistogram("synthetic.send.duration", { unit: "s" }),
    deliveryDurationMs: meter.createHistogram("mailflow.delivery.duration", { unit: "s" }),
    publicationDurationMs: meter.createHistogram("teams.message.publication.duration", { unit: "s" }),
  };
  const callPhases = [
    { name: "connection", step: "wait-for-answer" },
    { name: "playback", step: "play-audio" },
    { name: "disconnection", step: "end-call" },
  ].map(phase => ({
    ...phase,
    success: meter.createHistogram(`teams.call.${phase.name}.success`, { unit: "1" }),
    duration: meter.createHistogram(`teams.call.${phase.name}.duration`, { unit: "s" }),
  }));
  const qualityInstruments = Object.fromEntries(callQualityMetricNames.map(metric => [metric,
    meter.createGauge(`teams.call.quality.${metric}`, {
      unit: callQualitySignals[metric].unit === "Milliseconds" ? "ms" : callQualitySignals[metric].unit === "Percent" ? "%" : "1",
    }),
  ]));

  const lifecycle = async (operation: () => Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TelemetryExportError()), timeoutMs + 500);
        }),
      ]);
    } catch { reportFailure("lifecycle"); }
    finally { clearTimeout(timer); }
    if (failed) { failed = false; throw new TelemetryExportError(); }
  };
  return {
    recordCallQuality(cycle) {
      if (closed) throw new TelemetryExportError();
      for (const measurement of callQualityMeasurements(cycle)) {
        if (measurement.value !== undefined) qualityInstruments[measurement.metric]!.record(measurement.value, {
          "probe.service": "teams", "probe.journey": "scheduled-meeting", "probe.mode": "live",
          "quality.complete": measurement.complete,
        });
      }
      logger.emit({
        body: "teams-call-quality", timestamp: new Date(cycle.collectedAt),
        attributes: { "quality.cycle_id": cycle.cycleId, "quality.details": JSON.stringify(cycle) },
      });
    },
    recordDiagnostic(record) {
      if (closed) throw new TelemetryExportError();
      logger.emit(providerLog(record));
    },
    record(raw, mode) {
      if (closed) throw new TelemetryExportError();
      const result = reportedResult(resultSchema.parse(raw));
      const attributes = resultAttributes(result, mode);
      const dimensions = {
        "probe.service": attributes["probe.service"],
        "probe.journey": attributes["probe.journey"],
        "probe.mode": mode,
        "probe.outcome": outcomeOf(result),
      };
      success.record(result.success ? 1 : 0, dimensions);
      duration.record(result.durationMs / 1000, dimensions);
      if (result.testType === "teams-call") {
        for (const phase of callPhases) {
          const step = result.steps.find(step => step.name === phase.step);
          if (!step || step.status === "skipped") continue;
          const placed = result.steps.find(step => step.name === "place-call");
          const submissionMs = phase.name === "connection" && placed && placed.status !== "skipped" ? placed.durationMs : 0;
          phase.success.record(step.status === "succeeded" ? 1 : 0, dimensions);
          phase.duration.record((step.durationMs + submissionMs) / 1000, dimensions);
        }
      }
      for (const [field, instrument] of Object.entries(phaseDurations)) {
        const value = result[field as keyof typeof phaseDurations];
        if (value !== undefined) instrument.record(value / 1000, dimensions);
      }
      for (const step of result.steps) {
        const stepDimensions = {
          "probe.service": attributes["probe.service"],
          "probe.journey": attributes["probe.journey"],
          "probe.step": step.name,
          "probe.mode": mode,
          "probe.outcome": step.status === "succeeded" ? "success" : step.status === "failed" ? "failure" : "skipped",
        };
        if (step.status !== "skipped") {
          stepSuccess.record(step.status === "succeeded" ? 1 : 0, stepDimensions);
          stepDuration.record(step.durationMs / 1000, stepDimensions);
        }
        logger.emit({
          body: "synthetic-step", timestamp: new Date(step.observedAt),
          attributes: {
            ...stepDimensions, "probe.correlation_id": result.correlationId, "probe.id": result.testId,
            "probe.observed_at": step.observedAt, "probe.step_status": step.status,
            ...(step.status === "skipped" ? { "probe.skip_reason": step.reason } : { "probe.duration_ms": step.durationMs }),
            ...(step.status === "failed" ? { "probe.diagnostic_category": step.diagnosticCategory } : {}),
          },
        });
      }
      logger.emit({
        body: "synthetic-result", timestamp: new Date(result.observedAt),
        attributes: { ...attributes, ...(result.call ? { "probe.call_evidence": JSON.stringify(result.call) } : {}) },
      });
    },
    async forceFlush() {
      if (closed) throw new TelemetryExportError();
      await lifecycle(async () => {
        const settled = await Promise.allSettled([meters.forceFlush(), loggers.forceFlush()]);
        await Promise.all([...activeExports]);
        if (settled.some(result => result.status === "rejected")) throw new TelemetryExportError();
      });
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      await lifecycle(async () => {
        const settled = await Promise.allSettled([meters.shutdown(), loggers.shutdown()]);
        await Promise.all([...activeExports]);
        if (settled.some(result => result.status === "rejected")) throw new TelemetryExportError();
      });
    },
  };
}
