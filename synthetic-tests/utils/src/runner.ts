import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { resultSchema, type Probe, type SyntheticResult, type Telemetry } from "./contracts.js";
import type { GraphClient } from "./graph.js";
import type { TeamsJourneyClient } from "./teams.js";
import { categoryOf, IntegrationError } from "./http.js";
import { baseResult, simulate, type ProbeHandler } from "./probes.js";
import type { ResultOutput } from "./results.js";
import type { CycleResults, HealthReporter } from "./health-reports.js";

const MAX_CONCURRENT_PROBES = 3;
const CYCLE_TIMEOUT_MS = 170_000;
const CLEANUP_GRACE_MS = 12_000;

export interface RunnerDependencies {
  results: ResultOutput;
  telemetry: Telemetry;
  graph?: GraphClient;
  teamsBot?: TeamsJourneyClient;
  teamsCalling?: GraphClient;
  shutdown?: () => Promise<void>;
  clientsForProbe?: (probe: Probe) => { graph: GraphClient; teamsBot: TeamsJourneyClient };
  handler?: ProbeHandler;
  now?: () => number;
  reportHealth?: HealthReporter;
}

interface CycleContext {
  cycleId: string;
  startedAt: number;
  signal: AbortSignal;
  externalSignal?: AbortSignal | undefined;
}

function createCompletionDeadline(signal: AbortSignal, probeTimeoutMs: number, cycleStartedAt: number) {
  let executionTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let onCancellation: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    const probeBudgetMs = probeTimeoutMs + CLEANUP_GRACE_MS;
    const remainingCycleMs = CYCLE_TIMEOUT_MS + CLEANUP_GRACE_MS
      - (performance.now() - cycleStartedAt);
    const completionBudgetMs = Math.max(0, Math.min(probeBudgetMs, remainingCycleMs));
    executionTimer = setTimeout(() => reject(new IntegrationError("cancelled")), completionBudgetMs);

    // Cancellation stops the operation but still gives its cleanup time to finish.
    onCancellation = () => {
      cleanupTimer = setTimeout(() => reject(new IntegrationError("cancelled")), CLEANUP_GRACE_MS);
    };
    signal.addEventListener("abort", onCancellation, { once: true });
    if (signal.aborted) onCancellation();
  });
  return {
    promise,
    dispose() {
      clearTimeout(executionTimer);
      clearTimeout(cleanupTimer);
      if (onCancellation) signal.removeEventListener("abort", onCancellation);
    },
  };
}

async function runSingleProbe(
  probe: Probe,
  config: Config,
  dependencies: RunnerDependencies,
  cycle: CycleContext,
): Promise<SyntheticResult> {
  const { telemetry, now = Date.now } = dependencies;
  const execution = new AbortController();
  const executionTimer = setTimeout(() => execution.abort(), config.PROBE_TIMEOUT_MS);
  const probeSignal = AbortSignal.any([
    cycle.signal,
    execution.signal,
  ]);
  const handler = config.EXECUTION_MODE === "simulation"
    ? simulate
    : dependencies.handler;
  const attemptStartedAt = now();

  let deadline: ReturnType<typeof createCompletionDeadline> | undefined;

  try {
    if (!handler) throw new IntegrationError("collector-failure");
    probeSignal.throwIfAborted();
    deadline = createCompletionDeadline(probeSignal, config.PROBE_TIMEOUT_MS, cycle.startedAt);

    const rawResult = await Promise.race([
      handler(probe, {
        config,
        signal: probeSignal,
        telemetry,
        now,
        ...(dependencies.graph ? { graph: dependencies.graph } : {}),
        ...(dependencies.teamsBot ? { teamsBot: dependencies.teamsBot } : {}),
        ...(dependencies.teamsCalling ? { teamsCalling: dependencies.teamsCalling } : {}),
        ...(dependencies.clientsForProbe && probe.type !== "teams-call" ? dependencies.clientsForProbe(probe) : {}),
      }),
      deadline.promise,
    ]);
    if (probeSignal.aborted) {
      // A handler may finish cleanup after cancellation, but cannot turn a deadline into success.
      const timedOut = resultSchema.safeParse(rawResult);
      if (timedOut.success) {
        return resultSchema.parse({
          ...timedOut.data, success: false, diagnosticCategory: cycle.externalSignal?.aborted ? "cancelled" : "delivery-timeout",
          durationMs: Math.max(0, now() - attemptStartedAt),
        });
      }
      throw new IntegrationError("delivery-timeout");
    }
    const parsedResult = resultSchema.safeParse(rawResult);
    if (!parsedResult.success) {
      throw new IntegrationError("malformed-response");
    }

    if (config.EXECUTION_MODE === "live") {
      return resultSchema.parse({
        ...parsedResult.data,
        durationMs: Math.max(0, now() - attemptStartedAt),
      });
    }
    return parsedResult.data;
  } catch (error) {
    const result = baseResult(probe, now());
    result.durationMs = Math.max(0, now() - attemptStartedAt);
    result.diagnosticCategory = cycle.externalSignal?.aborted ? "cancelled"
      : probeSignal.aborted ? "delivery-timeout" : categoryOf(error);
    result.diagnosticContext.testStage = "execution";
    telemetry.emit("probe-execution-failed", {
      cycleId: cycle.cycleId,
      testId: probe.id,
      category: result.diagnosticCategory,
    });
    return result;
  } finally {
    clearTimeout(executionTimer);
    deadline?.dispose();
  }
}

async function executeProbes(
  config: Config, dependencies: RunnerDependencies, cycle: CycleContext, stopOtherProbes: AbortController,
) {
  const results: SyntheticResult[] = [];
  const telemetryErrors: unknown[] = [];
  let nextProbeIndex = 0;
  const runNextProbes = async () => {
    while (nextProbeIndex < config.probes.length && !cycle.externalSignal?.aborted) {
      const probe = config.probes[nextProbeIndex++];
      if (!probe) break;
      const result = await runSingleProbe(probe, config, dependencies, cycle);
      results.push(result);

      // Output errors must not be turned into a second, fabricated probe result.
      try { dependencies.results.record(result, config.EXECUTION_MODE); }
      catch (error) {
        telemetryErrors.push(error);
        dependencies.telemetry.emit("result-output-failed", { cycleId: cycle.cycleId, category: categoryOf(error) });
      }
    }
  };
  const concurrency = Math.min(MAX_CONCURRENT_PROBES, config.probes.length);
  const executions = Array.from({ length: concurrency }, async () => {
    try { await runNextProbes(); }
    catch (error) {
      stopOtherProbes.abort();
      throw error;
    }
  });
  const completedExecutions = await Promise.allSettled(executions);
  const failedExecution = completedExecutions.find(execution => execution.status === "rejected");
  if (failedExecution?.status === "rejected") throw failedExecution.reason;
  return { results, telemetryErrors };
}

async function publishCycleResults(
  config: Config, dependencies: RunnerDependencies, cycle: CycleResults,
  telemetryErrors: unknown[],
): Promise<void> {
  const complete = cycle.results.length === config.probes.length;
  if (!complete && dependencies.reportHealth) {
    dependencies.telemetry.emit("health-report-skipped-incomplete-cycle", {
      cycleId: cycle.cycleId, probeCount: cycle.results.length,
    });
  }
  if (complete) await dependencies.reportHealth?.(cycle);
  if (telemetryErrors.length) throw telemetryErrors[0];
}

export async function runCycle(
  config: Config,
  dependencies: RunnerDependencies,
  externalSignal?: AbortSignal,
) {
  const { telemetry } = dependencies;
  const cycleId = randomUUID();
  const cycleStartedAt = performance.now();
  const stopOtherProbes = new AbortController();
  const deadline = new AbortController();
  const cycleTimer = setTimeout(() => deadline.abort(), CYCLE_TIMEOUT_MS);
  const cancellationSignals = [
    stopOtherProbes.signal,
    deadline.signal,
  ];
  if (externalSignal) {
    cancellationSignals.push(externalSignal);
  }
  const cycleSignal = AbortSignal.any(cancellationSignals);
  let stage = "probes";

  telemetry.emit("service-execution-started", {
    cycleId,
    executionMode: config.EXECUTION_MODE,
    probeCount: config.probes.length,
  });

  try {
    cycleSignal.throwIfAborted();
    const cycle = { cycleId, startedAt: cycleStartedAt, signal: cycleSignal, externalSignal };
    const { results, telemetryErrors } = await executeProbes(config, dependencies, cycle, stopOtherProbes);

    stage = "reporting";
    await publishCycleResults(config, dependencies, { cycleId, results }, telemetryErrors);
    telemetry.emit("service-execution-completed", {
      cycleId,
      probeCount: results.length,
    });
    return { cycleId, results };
  } catch (error) {
    const category = categoryOf(error);
    telemetry.emit("service-execution-failed", {
      cycleId,
      stage,
      category,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    throw new Error(`Synthetic cycle failed (${category}); see correlation ${cycleId}`);
  } finally { clearTimeout(cycleTimer); }
}
