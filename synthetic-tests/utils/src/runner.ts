import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { resultSchema, type Probe, type SyntheticResult, type Telemetry } from "./contracts.js";
import type { GraphClient } from "./graph.js";
import type { TeamsBotClient } from "./teams.js";
import { categoryOf, IntegrationError } from "./http.js";
import { baseResult, simulate, type ProbeHandler } from "./probes.js";
import { publishTelemetryAndHealth, type ResultTelemetry } from "./results.js";
import type { CycleResults, HealthReporter } from "./health-reports.js";

const MAX_CONCURRENT_PROBES = 3;
const CYCLE_TIMEOUT_MS = 170_000;
const CLEANUP_GRACE_MS = 12_000;

export interface RunnerDependencies {
  results: ResultTelemetry;
  telemetry: Telemetry;
  graph?: GraphClient;
  teamsBot?: TeamsBotClient;
  handler?: ProbeHandler;
  now?: () => number;
  reportHealth?: HealthReporter;
}

interface CycleContext {
  cycleId: string;
  startedAt: number;
  signal: AbortSignal;
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
  const probeSignal = AbortSignal.any([
    cycle.signal,
    AbortSignal.timeout(config.PROBE_TIMEOUT_MS),
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
      }),
      deadline.promise,
    ]);
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
    result.diagnosticCategory = categoryOf(error);
    result.diagnosticContext.testStage = "execution";
    telemetry.emit("probe-execution-failed", {
      cycleId: cycle.cycleId,
      testId: probe.id,
      category: result.diagnosticCategory,
    });
    return result;
  } finally {
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
    while (nextProbeIndex < config.probes.length && !cycle.signal.aborted) {
      const probe = config.probes[nextProbeIndex++];
      if (!probe) break;
      const result = await runSingleProbe(probe, config, dependencies, cycle);
      results.push(result);

      // Export errors must not be turned into a second, fabricated probe result.
      try { dependencies.results.record(result, config.EXECUTION_MODE); }
      catch (error) {
        if (!dependencies.reportHealth) throw error;
        telemetryErrors.push(error);
        dependencies.telemetry.emit("result-telemetry-failed", { cycleId: cycle.cycleId, category: categoryOf(error) });
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
  signal: AbortSignal, telemetryErrors: unknown[],
): Promise<void> {
  const complete = cycle.results.length === config.probes.length && !signal.aborted;
  if (!complete && dependencies.reportHealth) {
    dependencies.telemetry.emit("health-report-skipped-incomplete-cycle", {
      cycleId: cycle.cycleId, probeCount: cycle.results.length,
    });
  }
  await publishTelemetryAndHealth(dependencies.results, () =>
    complete ? dependencies.reportHealth?.(cycle) : undefined);
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
  const cancellationSignals = [
    stopOtherProbes.signal,
    AbortSignal.timeout(CYCLE_TIMEOUT_MS),
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
    const cycle = { cycleId, startedAt: cycleStartedAt, signal: cycleSignal };
    const { results, telemetryErrors } = await executeProbes(config, dependencies, cycle, stopOtherProbes);

    stage = "reporting";
    await publishCycleResults(config, dependencies, { cycleId, results }, cycleSignal, telemetryErrors);
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
  }
}
