import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isReportedStep, probeServices, type StepName, type SyntheticResult, type Telemetry } from "../contracts.js";
import type { ProjectConfig } from "../configuration/project-config.js";
import { serviceProbes, type ServiceConfig } from "../configuration/service-config.js";
import { withAbort } from "../integrations/http.js";
import { createHealthReportPublisher, type HealthReport } from "./health-report-client.js";
import { measurementHealthReports } from "./health-reports.js";
import { resultMeasurements, type SyntheticMeasurement } from "./measurements.js";
import { createObservationPublisher, type ObservationSender } from "./observation-publisher.js";
import { resultObservations, type Observation } from "./observations.js";

export interface ExecutionReporter {
  step(result: SyntheticResult, name: StepName): Promise<void>;
  journey(result: SyntheticResult): Promise<void>;
  finish(signal: AbortSignal): Promise<void>;
}
export interface ObservedMeasurement {
  result: SyntheticResult;
  measurement: SyntheticMeasurement;
}
export interface ExecutionCorrelation {
  cycleId: string;
  lane: string;
  slot: number;
  configSha256: string;
  attemptId: string;
}
interface ReporterOptions {
  correlation?: ExecutionCorrelation;
  signal: AbortSignal;
  sendObservations?: ObservationSender;
  sendReports?: (reports: readonly HealthReport[], signal: AbortSignal) => Promise<void>;
}

/**
 * Streams during execution without waiting for network delivery inside business steps.
 * The configured attempt/step inventory bounds storage; one sender preserves publication order.
 */
export function createExecutionReporter(
  project: ProjectConfig, service: ServiceConfig, telemetry: Telemetry, env: NodeJS.ProcessEnv,
  options: ReporterOptions,
): ExecutionReporter {
  const cycleId = options.correlation?.cycleId ?? randomUUID();
  const probes = serviceProbes(service, project.services[service.type].scenarios);
  const attempts = new Set(probes.map(probe => `${probe.type}/${probe.id}`));
  const maximumMeasurements = probes.reduce((total, probe) =>
    total + 1 + probeServices[probe.type].steps.filter(isReportedStep).length + (probe.type === "teams-call" ? 2 : 0), 0);
  const observed = new Map<string, ObservedMeasurement>();
  const pendingLogs: Observation[] = [];
  const observedMeasurements = new Map<string, ObservedMeasurement[]>();
  const pendingReports = new Map<string, ObservedMeasurement[]>();
  const errors: unknown[] = [];
  const publisher = project.logAnalytics.enabled
    ? options.sendObservations ?? createObservationPublisher(project, service, telemetry, env)
    : undefined;
  const healthPublisher = publisher ? undefined : createHealthReportPublisher(project, service, telemetry, env);
  const sendReports = options.sendReports ?? ((reports, signal) => healthPublisher!(reports, { cycleId, signal }));
  let task: Promise<void> | undefined;
  let finishing = false;
  let publicationSignal = options.signal;
  const wake = new AbortController();

  /** Sends queued data with bounded request budgets, retaining every failure for the final drain. */
  async function pump(): Promise<void> {
    while (pendingLogs.length || pendingReports.size) {
      if (!finishing && pendingLogs.length < 100 && pendingReports.size < 100) {
        try { await delay(100, undefined, { signal: wake.signal }); }
        catch (error) { if (!wake.signal.aborted) throw error; }
      }
      const deadline = AbortSignal.timeout(service.publicationTimeoutSeconds * 1000);
      const signal = AbortSignal.any([publicationSignal, deadline]);
      if (publisher) {
        const batch = pendingLogs.splice(0, 100);
        await withAbort(signal, () => publisher(batch, signal));
      } else {
        const batch = [...pendingReports.entries()].slice(0, 100);
        for (const [key] of batch) pendingReports.delete(key);
        const reports = batch.flatMap(([, rows]) => measurementHealthReports(project, service, {
          cycleId, results: [], ...(options.correlation ? { configSha256: options.correlation.configSha256 } : {}),
        }, rows));
        await withAbort(signal, () => sendReports(reports, signal));
      }
    }
  }

  /** Starts only one observed sender; a failed transport never becomes a synthetic service result. */
  function startSender(): void {
    if (task || errors.length) return;
    task = pump().catch(error => {
      errors.push(error);
      telemetry.emit("execution-publication-failed", { cycleId, errorType: error instanceof Error ? error.name : "unknown" });
    }).finally(() => {
      task = undefined;
      if (!errors.length && (pendingLogs.length || pendingReports.size)) startSender();
    });
  }

  /** Queues each configured measurement once; transport latency must not stall Graph actions. */
  async function append(result: SyntheticResult, measurements: SyntheticMeasurement[]): Promise<void> {
    if (!attempts.has(`${result.testType}/${result.testId}`)) {
      throw new Error("Observation does not belong to a configured journey attempt");
    }
    for (const measurement of measurements) {
      if (finishing) throw new Error("Cannot publish observations after the execution reporter was closed");
      const key = `${result.testType}/${result.testId}/${measurement.kind}/${measurement.step}`;
      if (observed.has(key)) continue;
      if (observed.size >= maximumMeasurements) {
        throw new Error("Observation count exceeds the configured journey and business-step inventory");
      }
      observed.set(key, { result, measurement });
      if (publisher) {
        const rows = resultObservations(project, service, cycleId, result, [measurement]).map(row => ({
          ...row,
          dimensions: {
            ...row.dimensions, ...options.correlation,
            configSha256: env.MONITORING_CONFIG_SHA256 ?? options.correlation?.configSha256,
          },
        }));
        for (const row of rows) {
          telemetry.emit("synthetic-observation", row);
          if (errors.length) throw new AggregateError(errors, "Observation transport is unavailable; raw evidence remains in console diagnostics");
          pendingLogs.push(row);
        }
      } else {
        const entity = `${measurement.entityName}/${measurement.kind}/${measurement.step}`;
        const rows = observedMeasurements.get(entity) ?? [];
        rows.push({ result, measurement });
        observedMeasurements.set(entity, rows);
        pendingReports.set(entity, rows);
        if (errors.length) throw new AggregateError(errors, "Aggregate health publication failed");
      }
      startSender();
    }
  }

  return {
    async step(result, name) {
      await append(result, resultMeasurements(result).filter(measurement =>
        measurement.kind === "step" && measurement.step === name ||
        measurement.kind === "call-phase" && measurement.step === (name === "wait-for-answer" ? "connection" : name === "end-call" ? "disconnection" : "")));
    },
    async journey(result) {
      // Simulation has no actual in-flight actions, but still uses the identical projection.
      if (service.mode === "simulation") await append(result, resultMeasurements(result).filter(row => row.kind !== "journey"));
      await append(result, resultMeasurements(result).filter(measurement => measurement.kind === "journey"));
    },
    async finish(signal) {
      finishing = true;
      publicationSignal = signal;
      wake.abort();
      while (!errors.length && (task || pendingLogs.length || pendingReports.size)) {
        startSender();
        if (task) await withAbort(signal, () => task!);
      }
      if (errors.length) throw new AggregateError(errors, "Execution reporting failed independently of Microsoft 365 results");
      if (pendingLogs.length || pendingReports.size) throw new Error("Execution reporting did not drain before its publication deadline");
      telemetry.emit("execution-publication-completed", { cycleId, measurements: observed.size });
    },
  };
}
