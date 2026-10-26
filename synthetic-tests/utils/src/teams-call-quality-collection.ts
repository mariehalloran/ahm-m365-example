import { setTimeout as delay } from "node:timers/promises";
import type { Telemetry } from "./contracts.js";
import type { GraphClient } from "./graph.js";
import { categoryOf, IntegrationError } from "./http.js";
import type { CallQualityCycle, CallQualitySample, CycleResults } from "./health-reports.js";
import { collectCallQuality } from "./teams-call-quality.js";
import type { ServiceConfig } from "./service-config.js";

export async function collectCycleCallQuality(
  cycle: CycleResults, graph: GraphClient | undefined, settings: ServiceConfig["teamsCallQuality"],
  telemetry: Telemetry, signal: AbortSignal, now: () => number = Date.now,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = async (ms, signal) => { await delay(ms, undefined, { signal }); },
): Promise<CallQualityCycle> {
  const calls = cycle.results.filter(result => result.testType === "teams-call");
  const knownCalls = [...new Set(calls.flatMap(result =>
    [result.call?.callChainId, result.call?.peerCallChainId].filter((id): id is string => Boolean(id))))];
  const samples = new Map<string, CallQualitySample>(knownCalls.map(callChainId => [callChainId, { status: "pending", callChainId }]));
  const deadline = now() + settings.maxWaitSeconds * 1000;
  const bounded = AbortSignal.timeout(settings.maxWaitSeconds * 1000);
  const collectionSignal = AbortSignal.any([signal, bounded]);
  const pending = () => knownCalls.filter(id => samples.get(id)?.status === "pending");
  while (pending().length && now() < deadline && !collectionSignal.aborted) {
    const ids = pending();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, ids.length) }, async () => {
      while (next < ids.length && now() < deadline && !collectionSignal.aborted) {
        const callChainId = ids[next++]!;
        try {
          if (!graph) throw new IntegrationError("configuration-failure");
          const observation = await collectCallQuality(graph, callChainId, collectionSignal);
          if (observation) samples.set(callChainId, { status: "available", observation });
        } catch (error) {
          const category = bounded.aborted && !signal.aborted ? "delivery-timeout" : categoryOf(error);
          samples.set(callChainId, {
            status: "failed", callChainId, category,
            ...(error instanceof IntegrationError && error.status !== undefined ? { httpStatus: error.status } : {}),
          });
          telemetry.emit("teams-call-quality-failed", { cycleId: cycle.cycleId, callChainId, category });
        }
      }
    }));
    const remaining = deadline - now();
    if (!pending().length || remaining <= 0 || collectionSignal.aborted) break;
    try { await sleep(Math.min(settings.pollIntervalSeconds * 1000, remaining), collectionSignal); }
    catch (error) {
      if (!collectionSignal.aborted) throw error;
    }
  }
  if (signal.aborted) signal.throwIfAborted();
  const result: CallQualityCycle = {
    cycleId: cycle.cycleId, collectedAt: new Date(now()).toISOString(),
    callQuality: [
      ...samples.values(),
      ...calls.filter(result => !result.call?.callChainId && !result.call?.peerCallChainId)
        .map((): CallQualitySample => ({ status: "unavailable" })),
    ],
  };
  telemetry.emit("teams-call-quality-collected", { ...result });
  return result;
}
