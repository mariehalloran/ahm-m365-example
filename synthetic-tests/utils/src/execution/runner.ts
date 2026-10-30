import { randomUUID } from "node:crypto";
import type { Config } from "../configuration/config.js";
import {
  isInconclusiveCategory, probeServices, resultSchema, type DiagnosticCategory, type Probe, type SyntheticResult, type Telemetry,
} from "../contracts.js";
import type { GraphFileOperations } from "../integrations/graph.js";
import { categoryOf, IntegrationError, withAbort } from "../integrations/http.js";
import { GraphRequestPermits, type PermitMeasurements } from "./graph-request-permits.js";
import { baseResult, simulate, type ProbeContext, type ProbeHandler } from "./probes.js";
import type { CyclePublisher, CycleResults, ResultOutput } from "../reporting/results.js";
import {
  CLEANUP_GRACE_MS, EXCHANGE_INTERVAL_SECONDS, EXCHANGE_PUBLICATION_TIMEOUT_MS, JOURNEY_TIMEOUT_SECONDS, PUBLICATION_TIMEOUT_MS,
} from "./budgets.js";

export type TeamsBotPairClients = Pick<ProbeContext, "teamsBot" | "teamsCalling" | "teamsCallingPeer">;

export interface RunnerDependencies {
  results: ResultOutput;
  telemetry: Telemetry;
  graph?: GraphFileOperations & {
    forMailbox?: (mailbox: string, permits: GraphRequestPermits) => GraphFileOperations;
  };
  teamsBotPairs?: ReadonlyMap<string, TeamsBotPairClients>;
  shutdown?: () => Promise<void>;
  handler?: ProbeHandler;
  now?: () => number;
  sleep?: ProbeContext["sleep"];
  publishResults?: CyclePublisher;
  // A hard slot deadline still bounds publication; worker shutdown leaves its independent report grace.
  publicationSignal?: AbortSignal;
  exchangeRequests?: GraphRequestPermits;
  capacityGroups?: { id: string; displayName: string; targetIds: string[] }[];
}

interface CycleContext {
  cycleId: string;
  startedAt: number;
  signal: AbortSignal;
  externalSignal?: AbortSignal | undefined;
  startedAttempts: Set<string>;
}

/** Schedules a cancellable execution or settlement deadline. */
function schedule(milliseconds: number, action: () => void): () => void {
  const timer = setTimeout(action, milliseconds);
  return () => clearTimeout(timer);
}

/** Bounds handler settlement separately from business execution, including cleanup after cancellation. */
function createCompletionDeadline(
  signal: AbortSignal, config: Pick<Config, "PROBE_TIMEOUT_MS" | "CYCLE_TIMEOUT_MS">, cycleStartedAt: number,
) {
  let cancelExecution: (() => void) | undefined;
  let cancelCleanup: (() => void) | undefined;
  let onCancellation: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    const probeBudgetMs = config.PROBE_TIMEOUT_MS + CLEANUP_GRACE_MS;
    const remainingCycleMs = config.CYCLE_TIMEOUT_MS + CLEANUP_GRACE_MS
      - (performance.now() - cycleStartedAt);
    const completionBudgetMs = Math.max(0, Math.min(probeBudgetMs, remainingCycleMs));
    cancelExecution = schedule(completionBudgetMs, () => reject(new IntegrationError("cancelled")));

    // Cancellation stops the operation but still gives its cleanup time to finish.
    onCancellation = () => {
      cancelCleanup = schedule(CLEANUP_GRACE_MS, () => reject(new IntegrationError("cancelled")));
    };
    signal.addEventListener("abort", onCancellation, { once: true });
    if (signal.aborted) onCancellation();
  });
  return {
    promise,
    dispose() {
      cancelExecution?.();
      cancelCleanup?.();
      if (onCancellation) signal.removeEventListener("abort", onCancellation);
    },
  };
}

/** Preserves observed service failures and business steps when execution or settlement is interrupted. */
function interruptedResult(
  result: SyntheticResult, category: DiagnosticCategory, observedAt: number, durationMs: number,
): SyntheticResult {
  const failed = result.steps.find(step => step.status === "failed" && !isInconclusiveCategory(step.diagnosticCategory));
  const primaryFailure = !result.success && result.diagnosticCategory && !isInconclusiveCategory(result.diagnosticCategory)
    ? result.diagnosticCategory : undefined;
  const diagnosticCategory = primaryFailure ?? (failed?.status === "failed" ? failed.diagnosticCategory : category);
  const { deliveryDurationMs, publicationDurationMs, ...evidence } = result;
  return {
    ...evidence, success: false, diagnosticCategory,
    observedAt: new Date(observedAt).toISOString(), durationMs,
    // Only expiry of this journey's execution deadline can turn an interrupted action into a timeout sample.
    steps: result.steps.map(step => category === "delivery-timeout" && step.status === "failed" && step.diagnosticCategory === "cancelled"
      ? { ...step, diagnosticCategory: "delivery-timeout" } : step),
    ...(isInconclusiveCategory(diagnosticCategory) ? {
      ...(deliveryDurationMs === undefined ? {} : { deliveryDurationMs }),
      ...(publicationDurationMs === undefined ? {} : { publicationDurationMs }),
    } : {}),
  };
}

/** Runs one complete journey, distinguishing its execution deadline from enclosing worker cancellation. */
async function runSingleProbe<P extends Probe>(
  probe: P,
  config: Config,
  dependencies: RunnerDependencies,
  cycle: CycleContext,
  handler: ((probe: P, context: ProbeContext) => Promise<SyntheticResult>) | undefined,
): Promise<SyntheticResult> {
  const liveExchange = config.EXECUTION_MODE === "live" && probeServices[probe.type].service === "exchange";
  const liveTimedJourney = config.EXECUTION_MODE === "live" && probeServices[probe.type].service !== "onedrive";
  if (liveTimedJourney) {
    config = { ...config, PROBE_TIMEOUT_MS: Math.min(config.PROBE_TIMEOUT_MS, JOURNEY_TIMEOUT_SECONDS * 1000) };
  }
  const { telemetry } = dependencies;
  const now = dependencies.now ?? Date.now;
  const attemptStartedAt = now();
  const evidence = baseResult(probe, attemptStartedAt);
  const execution = new AbortController();
  const cancelExecution = schedule(config.PROBE_TIMEOUT_MS, () => execution.abort(new IntegrationError("delivery-timeout")));
  const probeSignal = AbortSignal.any([
    cycle.signal,
    execution.signal,
  ]);
  let executionFinishedAt: number | undefined;
  let cancelledDuringExecution = false;

  let deadline: ReturnType<typeof createCompletionDeadline> | undefined;

  try {
    if (!handler) throw new IntegrationError("collector-failure");
    probeSignal.throwIfAborted();
    cycle.startedAttempts.add(`${probe.type}:${probe.id}`);
    deadline = createCompletionDeadline(probeSignal, config, cycle.startedAt);
    const graph = liveExchange && probe.mailbox && dependencies.exchangeRequests && dependencies.graph?.forMailbox
      ? dependencies.graph.forMailbox(probe.mailbox, dependencies.exchangeRequests) : dependencies.graph;
    const pair = probe.botPairId ? dependencies.teamsBotPairs?.get(probe.botPairId) : undefined;
    if (config.EXECUTION_MODE === "live" && probeServices[probe.type].service === "teams" && !pair) {
      throw new IntegrationError("configuration-failure");
    }

    const rawResult = await Promise.race([
      handler(probe, {
        config,
        signal: probeSignal,
        telemetry,
        now,
        result: evidence,
        ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
        executionComplete: () => {
          cancelledDuringExecution ||= probeSignal.aborted;
          executionFinishedAt ??= now();
          cancelExecution();
        },
        ...(graph ? { graph } : {}),
        ...pair,
      }),
      deadline.promise,
    ]);
    const parsedResult = resultSchema.safeParse(rawResult);
    if (!parsedResult.success) {
      throw new IntegrationError("malformed-response");
    }
    const cancelled = cycle.externalSignal?.aborted ||
      (executionFinishedAt === undefined ? probeSignal.aborted : cancelledDuringExecution);
    const expired = liveTimedJourney && (executionFinishedAt ?? now()) - attemptStartedAt >= config.PROBE_TIMEOUT_MS;
    if (cancelled || expired) {
      const category = cancelled
        ? categoryOf(probeSignal.reason) === "delivery-timeout" ? "delivery-timeout" : "cancelled"
        : "delivery-timeout";
      return resultSchema.parse(interruptedResult(parsedResult.data, category, now(), Math.max(0, now() - attemptStartedAt)));
    }

    if (config.EXECUTION_MODE === "live") {
      return resultSchema.parse({
        ...parsedResult.data,
        durationMs: Math.max(0, now() - attemptStartedAt),
      });
    }
    return parsedResult.data;
  } catch (error) {
    const observedCategory = categoryOf(error);
    const category = isInconclusiveCategory(observedCategory) && probeSignal.aborted
      ? categoryOf(probeSignal.reason) === "delivery-timeout" ? "delivery-timeout" : "cancelled"
      : observedCategory;
    const durationMs = Math.max(0, now() - attemptStartedAt);
    const partial = resultSchema.safeParse(interruptedResult(evidence, category, now(), durationMs));
    const result = partial.success ? partial.data : {
      ...baseResult(probe, now()), durationMs, diagnosticCategory: category,
    };
    result.diagnosticContext.testStage ??= "execution";
    telemetry.emit(isInconclusiveCategory(result.diagnosticCategory) ? "probe-execution-inconclusive" : "probe-execution-failed", {
      cycleId: cycle.cycleId,
      testId: probe.id,
      category: result.diagnosticCategory,
    });
    return result;
  } finally {
    cancelExecution();
    deadline?.dispose();
  }
}

/** Starts concurrent Exchange journeys under shared request permits and bounded other-service workers. */
async function executeProbes(
  config: Config, dependencies: RunnerDependencies, cycle: CycleContext, stopOtherProbes: AbortController,
) {
  const results: SyntheticResult[] = [];
  const telemetryErrors: unknown[] = [];
  let nextProbeIndex = 0;
  const runProbeAt = (index: number) => {
    if (config.EXECUTION_MODE === "live") {
      const probe = config.probes[index];
      return probe ? runSingleProbe(probe, config, dependencies, cycle, dependencies.handler) : undefined;
    }
    const probe = config.probes[index];
    return probe ? runSingleProbe(probe, config, dependencies, cycle, simulate) : undefined;
  };
  const runNextProbes = async () => {
    while (nextProbeIndex < config.probes.length && !cycle.externalSignal?.aborted) {
      const result = await runProbeAt(nextProbeIndex++);
      if (!result) break;
      results.push(result);

      // Output errors must not be turned into a second, fabricated probe result.
      try { dependencies.results.record(result, config.EXECUTION_MODE); }
      catch (error) {
        telemetryErrors.push(error);
        dependencies.telemetry.emit("result-output-failed", { cycleId: cycle.cycleId, category: categoryOf(error) });
      }
    }
  };
  const exchange = config.probes.every(probe => probeServices[probe.type].service === "exchange");
  const concurrency = exchange ? config.probes.length : Math.min(config.MAX_CONCURRENT_PROBES, config.probes.length);
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

/** Publishes settled results independently of the execution deadline, within a bounded report window. */
async function publishCycleResults(
  config: Config, dependencies: RunnerDependencies, cycle: CycleResults,
  telemetryErrors: unknown[],
): Promise<void> {
  const complete = cycle.results.length === config.probes.length;
  if (!complete) {
    dependencies.telemetry.emit("service-cycle-incomplete", {
      cycleId: cycle.cycleId, expectedAttempts: config.probes.length, settledAttempts: cycle.results.length,
    });
  }
  if (cycle.results.length) {
    const exchange = config.probes.every(probe => probeServices[probe.type].service === "exchange");
    const deadline = AbortSignal.timeout(exchange ? EXCHANGE_PUBLICATION_TIMEOUT_MS : PUBLICATION_TIMEOUT_MS);
    const signal = cycle.signal ? AbortSignal.any([cycle.signal, deadline]) : deadline;
    await withAbort(signal, async () => dependencies.publishResults?.({ ...cycle, signal }));
  }
  if (telemetryErrors.length) throw telemetryErrors[0];
}

/** Reports runner capacity separately from Exchange availability for each configured user group. */
function reportExchangeCapacity(
  config: Config, dependencies: RunnerDependencies, cycle: CycleContext, results: SyntheticResult[],
  before: Map<string, PermitMeasurements>,
): void {
  const after = dependencies.exchangeRequests!.snapshot();
  const groups = dependencies.capacityGroups ?? [{ id: "ungrouped", displayName: "Ungrouped", targetIds: config.probes.map(probe => probe.id) }];
  for (const group of groups) {
    const members = new Set(group.targetIds);
    const probes = config.probes.filter(probe => members.has(probe.id));
    if (!probes.length) continue;
    const settled = results.filter(result => members.has(result.testId));
    const mailboxes = new Set(probes.flatMap(probe => probe.mailbox ? [probe.mailbox.toLowerCase()] : []));
    const permits = [...mailboxes].reduce((sum, mailbox) => {
      const current = after.get(mailbox);
      const prior = before.get(mailbox);
      return {
        requests: sum.requests + (current?.requests ?? 0) - (prior?.requests ?? 0),
        waitedRequests: sum.waitedRequests + (current?.waitedRequests ?? 0) - (prior?.waitedRequests ?? 0),
        waitMs: sum.waitMs + (current?.waitMs ?? 0) - (prior?.waitMs ?? 0),
      };
    }, { requests: 0, waitedRequests: 0, waitMs: 0 });
    dependencies.telemetry.emit("exchange-cycle-capacity", {
      cycleId: cycle.cycleId, groupId: group.id, group: group.displayName,
      intervalSeconds: EXCHANGE_INTERVAL_SECONDS, executionTimeoutMs: config.PROBE_TIMEOUT_MS,
      expectedAttempts: probes.length,
      startedAttempts: probes.filter(probe => cycle.startedAttempts.has(`${probe.type}:${probe.id}`)).length,
      completedAttempts: settled.length,
      timedOutAttempts: settled.filter(result => result.diagnosticCategory === "delivery-timeout").length,
      inconclusiveAttempts: settled.filter(result => isInconclusiveCategory(result.diagnosticCategory)).length,
      graphRequests: permits.requests, permitWaitRequests: permits.waitedRequests, permitWaitMs: permits.waitMs,
      interpretation: "runner-capacity-not-exchange-availability",
    });
  }
}

/** Settles one nonoverlapping service batch, then publishes in the selected reporting mode. */
export async function runCycle(
  config: Config,
  dependencies: RunnerDependencies,
  externalSignal?: AbortSignal,
) {
  const exchange = config.probes.every(probe => probeServices[probe.type].service === "exchange");
  if (exchange) dependencies = {
    ...dependencies,
    exchangeRequests: dependencies.exchangeRequests ?? new GraphRequestPermits(
      config.EXCHANGE_MAX_CONCURRENT_REQUESTS, config.EXCHANGE_MAX_CONCURRENT_REQUESTS_PER_MAILBOX,
    ),
  };
  const permitStart = dependencies.exchangeRequests?.snapshot();
  const { telemetry } = dependencies;
  const cycleId = randomUUID();
  const cycleStartedAt = performance.now();
  const stopOtherProbes = new AbortController();
  const deadline = new AbortController();
  const cancelCycle = schedule(config.CYCLE_TIMEOUT_MS, () => deadline.abort(new IntegrationError("cancelled")));
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
    const cycle: CycleContext = { cycleId, startedAt: cycleStartedAt, signal: cycleSignal, externalSignal, startedAttempts: new Set() };
    const { results, telemetryErrors } = await executeProbes(config, dependencies, cycle, stopOtherProbes);
    if (exchange) reportExchangeCapacity(config, dependencies, cycle, results, permitStart!);

    stage = "reporting";
    await publishCycleResults(config, dependencies, {
      cycleId, results, ...(dependencies.publicationSignal ? { signal: dependencies.publicationSignal } : {}),
    }, telemetryErrors);
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
  } finally { cancelCycle(); }
}
