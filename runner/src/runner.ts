import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { resultSchema, type Probe, type SyntheticResult, type Telemetry } from "../../shared/src/contracts.js";
import type { GraphClient } from "../../shared/src/graph.js";
import { categoryOf, IntegrationError } from "../../shared/src/http.js";
import { baseResult, simulate, type ProbeHandler } from "../../shared/src/probes.js";
import { handlers } from "../../probes/src/registry.js";
import type { ResultTelemetry } from "../../telemetry/src/results.js";

const MAX_CONCURRENT_PROBES = 3;
const CYCLE_TIMEOUT_MS = 170_000;
const CLEANUP_GRACE_MS = 12_000;

export interface RunnerDependencies {
  results: ResultTelemetry;
  telemetry: Telemetry;
  graph?: GraphClient;
  handlers?: Readonly<Record<Probe["type"], ProbeHandler>>;
  now?: () => number;
}

async function runSingleProbe(
  probe: Probe,
  config: Config,
  dependencies: RunnerDependencies,
  cycleSignal: AbortSignal,
  cycleStartedAt: number,
  cycleId: string,
): Promise<SyntheticResult> {
  const { telemetry, now = Date.now } = dependencies;
  const probeSignal = AbortSignal.any([
    cycleSignal,
    AbortSignal.timeout(config.PROBE_TIMEOUT_MS),
  ]);
  const handler = config.EXECUTION_MODE === "simulation"
    ? simulate
    : (dependencies.handlers ?? handlers)[probe.type];
  const attemptStartedAt = now();

  let executionTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let onCancellation: (() => void) | undefined;

  try {
    probeSignal.throwIfAborted();
    const completionDeadline = new Promise<never>((_, reject) => {
      const probeBudgetMs = config.PROBE_TIMEOUT_MS + CLEANUP_GRACE_MS;
      const remainingCycleMs = CYCLE_TIMEOUT_MS + CLEANUP_GRACE_MS
        - (performance.now() - cycleStartedAt);
      const completionBudgetMs = Math.max(0, Math.min(probeBudgetMs, remainingCycleMs));
      executionTimer = setTimeout(
        () => reject(new IntegrationError("cancelled")),
        completionBudgetMs,
      );

      // Cancellation stops the operation but still gives its cleanup time to finish.
      onCancellation = () => {
        cleanupTimer = setTimeout(
          () => reject(new IntegrationError("cancelled")),
          CLEANUP_GRACE_MS,
        );
      };
      probeSignal.addEventListener("abort", onCancellation, { once: true });
      if (probeSignal.aborted) {
        onCancellation();
      }
    });

    const rawResult = await Promise.race([
      handler(probe, {
        config,
        signal: probeSignal,
        telemetry,
        now,
        ...(dependencies.graph ? { graph: dependencies.graph } : {}),
      }),
      completionDeadline,
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
      cycleId,
      testId: probe.id,
      category: result.diagnosticCategory,
    });
    return result;
  } finally {
    clearTimeout(executionTimer);
    clearTimeout(cleanupTimer);
    if (onCancellation) {
      probeSignal.removeEventListener("abort", onCancellation);
    }
  }
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
    const results: SyntheticResult[] = [];
    let nextProbeIndex = 0;

    const runNextProbes = async () => {
      while (nextProbeIndex < config.probes.length && !cycleSignal.aborted) {
        const probe = config.probes[nextProbeIndex++];
        if (!probe) {
          break;
        }
        const result = await runSingleProbe(
          probe,
          config,
          dependencies,
          cycleSignal,
          cycleStartedAt,
          cycleId,
        );
        results.push(result);

        // Export errors must not be turned into a second, fabricated probe result.
        dependencies.results.record(result, config.EXECUTION_MODE);
      }
    };

    const concurrency = Math.min(MAX_CONCURRENT_PROBES, config.probes.length);
    const executions = Array.from({ length: concurrency }, async () => {
      try {
        await runNextProbes();
      } catch (error) {
        stopOtherProbes.abort();
        throw error;
      }
    });
    const completedExecutions = await Promise.allSettled(executions);
    const failedExecution = completedExecutions.find(execution => execution.status === "rejected");
    if (failedExecution?.status === "rejected") {
      throw failedExecution.reason;
    }

    stage = "telemetry";
    await dependencies.results.forceFlush();
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
