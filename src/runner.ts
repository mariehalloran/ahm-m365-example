import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { resultSchema, type HealthReport, type Probe, type SyntheticResult, type Telemetry } from "./contracts.js";
import type { ReportSink } from "./ahm.js";
import type { GraphClient } from "./graph.js";
import { categoryOf, IntegrationError } from "./http.js";
import { aggregate } from "./policy.js";
import { baseResult, handlers, simulate, type ProbeHandler } from "./probes.js";
import { providerReport } from "./provider.js";
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
  const pipeline = (healthy: boolean): HealthReport => ({
    entity: "runner-heartbeat", signal: "heartbeat", state: healthy ? "Healthy" : "Unknown",
    observedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + config.REPORT_TTL_SECONDS * 1000).toISOString(),
    context: { cycleId, source: "pipeline", reason: healthy ? "complete-cycle" : "incomplete-cycle" },
  });
  telemetry.emit("cycle-started", { cycleId, executionMode: config.EXECUTION_MODE, probeCount: config.probes.length });
  try {
    const history = await state.load();
    stage = "probes";
    const results: SyntheticResult[] = [];
    let index = 0;
    const worker = async () => {
      while (index < config.probes.length) {
        const probe = config.probes[index++];
        if (!probe) break;
        const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(config.PROBE_TIMEOUT_MS)]);
        const handler = config.EXECUTION_MODE === "simulation" ? simulate : (dependencies.handlers ?? handlers)[probe.type];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: SyntheticResult;
        try {
          probeSignal.throwIfAborted();
          result = await Promise.race([
            handler(probe, { config, signal: probeSignal, telemetry, now, ...(dependencies.graph ? { graph: dependencies.graph } : {}) }),
            new Promise<never>((_, reject) => {
              const budget = Math.max(0, Math.min(config.PROBE_TIMEOUT_MS + 12000, 182000 - (performance.now() - started)));
              timer = setTimeout(() => reject(new IntegrationError("cancelled")), budget);
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
        }
        results.push(result);
        telemetry.emit("synthetic-result", { cycleId, ...result });
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, config.probes.length) }, worker));
    signal.throwIfAborted();
    stage = "aggregation";
    const aggregation = aggregate(config.probes, results, config, history, now(), cycleId, telemetry);
    stage = "provider";
    const reports = [...aggregation.reports, await providerReport(config, dependencies.graph, cycleId, telemetry, signal, now())];
    if (config.EXECUTION_MODE === "live") {
      const started = now();
      const graphReport: HealthReport = {
        entity: "graph-availability", signal: "graph-availability", state: "Unknown",
        observedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + config.REPORT_TTL_SECONDS * 1000).toISOString(),
        context: { cycleId, source: "pipeline" },
      };
      try {
        if (!dependencies.graph) throw new IntegrationError("collector-failure");
        const response = await dependencies.graph.request("/admin/serviceAnnouncement/healthOverviews?$select=id", signal);
        await response.body?.cancel();
        graphReport.state = "Healthy";
      } catch (error) {
        graphReport.state = "Unhealthy";
        graphReport.context.reason = categoryOf(error);
        telemetry.emit("graph-query-failed", { cycleId, category: categoryOf(error), ...(error instanceof IntegrationError ? { httpStatus: error.status } : {}) });
      }
      telemetry.emit("graph-control-plane", { cycleId, state: graphReport.state, durationMs: now() - started });
      reports.push(graphReport);
    }
    stage = "ingestion";
    for (const report of reports) {
      await sink.submit(report, signal);
      telemetry.emit("health-report-submitted", { cycleId, entity: report.entity, state: report.state });
    }
    stage = "state-save";
    await state.save(aggregation.history);
    const heartbeat = pipeline(true);
    stage = "heartbeat";
    await sink.submit(heartbeat, signal);
    telemetry.emit("cycle-completed", { cycleId, state: "Healthy", probeCount: results.length });
    return { cycleId, results, reports: [...reports, heartbeat] };
  } catch (error) {
    telemetry.emit("cycle-failed", { cycleId, stage, category: categoryOf(error), errorType: error instanceof Error ? error.name : "unknown" });
    try { await sink.submit(pipeline(false), AbortSignal.timeout(10000)); }
    catch (submissionError) { telemetry.emit("heartbeat-submission-failed", { cycleId, category: categoryOf(submissionError) }); }
    throw new Error(`Synthetic cycle failed (${categoryOf(error)}); see correlation ${cycleId}`);
  }
}
