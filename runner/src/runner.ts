import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { resultSchema, type Probe, type SyntheticResult, type Telemetry } from "../../shared/src/contracts.js";
import type { ReportSink } from "../../health-model/src/ahm.js";
import type { GraphClient } from "../../shared/src/graph.js";
import { categoryOf, IntegrationError } from "../../shared/src/http.js";
import { aggregate } from "../../health-model/src/policy.js";
import { baseResult, simulate, type ProbeHandler } from "../../shared/src/probes.js";
import { handlers } from "../../probes/src/registry.js";
import type { StateStore } from "./state.js";

export interface RunnerDependencies {
  sink: ReportSink;
  state: StateStore;
  telemetry: Telemetry;
  graph?: GraphClient;
  handlers?: Readonly<Record<Probe["type"], ProbeHandler>>;
  now?: () => number;
}

export async function runCycle(config: Config, dependencies: RunnerDependencies, externalSignal?: AbortSignal) {
  const { sink, state, telemetry, now = Date.now } = dependencies;
  const cycleId = randomUUID();
  const started = performance.now();
  let stage = "state-load";
  const deadline = AbortSignal.timeout(170000);
  const signal = externalSignal ? AbortSignal.any([externalSignal, deadline]) : deadline;
  telemetry.emit("service-execution-started", { cycleId, executionMode: config.EXECUTION_MODE, probeCount: config.probes.length });
  try {
    signal.throwIfAborted();
    const history = await state.load();
    stage = "probes";
    const results: SyntheticResult[] = [];
    let index = 0;
    const worker = async () => {
      while (index < config.probes.length && !signal.aborted) {
        const probe = config.probes[index++];
        if (!probe) break;
        const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(config.PROBE_TIMEOUT_MS)]);
        const handler = config.EXECUTION_MODE === "simulation" ? simulate : (dependencies.handlers ?? handlers)[probe.type];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        let result: SyntheticResult;
        try {
          probeSignal.throwIfAborted();
          result = await Promise.race([
            handler(probe, { config, signal: probeSignal, telemetry, now, ...(dependencies.graph ? { graph: dependencies.graph } : {}) }),
            new Promise<never>((_, reject) => {
              const budget = Math.max(0, Math.min(config.PROBE_TIMEOUT_MS + 12000, 182000 - (performance.now() - started)));
              timer = setTimeout(() => reject(new IntegrationError("cancelled")), budget);
              // Existing handlers get their independent 10s cleanup budget after cancellation.
              onAbort = () => { cleanupTimer = setTimeout(() => reject(new IntegrationError("cancelled")), 12000); };
              probeSignal.addEventListener("abort", onAbort, { once: true });
              if (probeSignal.aborted) onAbort();
            }),
          ]);
          const parsed = resultSchema.safeParse(result);
          if (!parsed.success) throw new IntegrationError("malformed-response");
          result = parsed.data;
        } catch (error) {
          result = baseResult(probe, now(), config.REPORT_TTL_SECONDS);
          result.diagnosticCategory = categoryOf(error);
          result.diagnosticContext.testStage = "execution";
          telemetry.emit("probe-execution-failed", { cycleId, testId: probe.id, category: categoryOf(error) });
        } finally {
          clearTimeout(timer);
          clearTimeout(cleanupTimer);
          if (onAbort) probeSignal.removeEventListener("abort", onAbort);
        }
        results.push(result);
        telemetry.emit("synthetic-result", { cycleId, ...result });
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, config.probes.length) }, worker));
    signal.throwIfAborted();
    stage = "aggregation";
    const aggregation = aggregate(config.probes, results, config, history, now(), cycleId, telemetry);
    const reports = [...aggregation.reports];
    for (const report of reports) {
      report.context.executionMode = config.EXECUTION_MODE;
      const probe = config.probes.find(item => item.cohort === report.entity);
      if (probe) report.context.testType = probe.type;
      report.context.durationMeaning = config.EXECUTION_MODE === "simulation" ? "modeled-not-measured-latency" : "measured-probe-duration";
    }
    stage = "ingestion";
    for (const report of reports) {
      await sink.submit(report, signal);
      telemetry.emit("health-report-submitted", { cycleId, entity: report.entity, state: report.state });
    }
    signal.throwIfAborted();
    stage = "state-save";
    await state.save(aggregation.history);
    telemetry.emit("service-execution-completed", { cycleId, probeCount: results.length });
    return { cycleId, results, reports };
  } catch (error) {
    telemetry.emit("service-execution-failed", { cycleId, stage, category: categoryOf(error), errorType: error instanceof Error ? error.name : "unknown" });
    throw new Error(`Synthetic cycle failed (${categoryOf(error)}); see correlation ${cycleId}`);
  }
}
