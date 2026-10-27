import { setTimeout as delay } from "node:timers/promises";
import { ConfigurationError } from "./config.js";
import type { Telemetry } from "./contracts.js";
import type { GraphClient } from "./graph.js";
import { categoryOf, IntegrationError } from "./http.js";
import type { CallQualityCycle, CallQualitySample, CycleResults } from "./health-reports.js";
import { collectCallQuality } from "./teams-call-quality.js";
import type { ServiceConfig } from "./service-config.js";

async function collectWithinWindow(
  cycle: CycleResults, graph: GraphClient | undefined, settings: { maxWaitSeconds: number; pollIntervalSeconds: number },
  telemetry: Telemetry, signal: AbortSignal, now: () => number = Date.now,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = async (ms, signal) => { await delay(ms, undefined, { signal }); },
  retryEmptyRecords = false,
): Promise<CallQualityCycle> {
  const calls = cycle.results.filter(result => result.testType === "teams-call");
  const knownCalls = [...new Set(calls.flatMap(result =>
    [result.call?.callChainId, result.call?.peerCallChainId].filter((id): id is string => Boolean(id))))];
  const samples = new Map<string, CallQualitySample>(knownCalls.map(callChainId => [callChainId, { status: "pending", callChainId }]));
  const deadline = now() + settings.maxWaitSeconds * 1000;
  const bounded = AbortSignal.timeout(settings.maxWaitSeconds * 1000);
  const collectionSignal = AbortSignal.any([signal, bounded]);
  const pending = () => knownCalls.filter(id => {
    const sample = samples.get(id);
    return sample?.status === "pending" || (retryEmptyRecords && sample?.status === "available" &&
      Object.keys(sample.observation.metrics).length === 0);
  });
  while (pending().length && now() < deadline && !collectionSignal.aborted) {
    const ids = pending();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, ids.length) }, async () => {
      while (next < ids.length && now() < deadline && !collectionSignal.aborted) {
        const callChainId = ids[next++]!;
        try {
          if (!graph) throw new IntegrationError("configuration-failure");
          const observation = await collectCallQuality(graph, callChainId, collectionSignal);
          if (observation) {
            const previous = samples.get(callChainId);
            if (previous?.status === "available" && observation.version < previous.observation.version) continue;
            samples.set(callChainId, { status: "available", observation });
            if (retryEmptyRecords && !Object.keys(observation.metrics).length &&
                (previous?.status !== "available" || previous.observation.version !== observation.version)) {
              telemetry.emit("teams-call-quality-record-empty", {
                cycleId: cycle.cycleId, callChainId, version: observation.version, audioStreamCount: observation.audioStreamCount,
              });
            }
          }
        } catch (error) {
          const category = bounded.aborted && !signal.aborted ? "delivery-timeout" : categoryOf(error);
          samples.set(callChainId, {
            status: "failed", callChainId, category,
            ...(error instanceof IntegrationError && error.status !== undefined ? { httpStatus: error.status } : {}),
          });
          telemetry.emit("teams-call-quality-failed", {
            cycleId: cycle.cycleId, callChainId, category,
            ...(error instanceof IntegrationError && error.status !== undefined ? { httpStatus: error.status } : {}),
          });
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

export async function collectCycleCallQuality(
  cycle: CycleResults, graph: GraphClient | undefined, settings: ServiceConfig["teamsCallQuality"],
  telemetry: Telemetry, signal: AbortSignal, now: () => number = Date.now,
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<CallQualityCycle> {
  return collectWithinWindow(cycle, graph, settings, telemetry, signal, now, sleep);
}

export const audioQualityCollectionDefaults = { maxWaitSeconds: 150 * 60, pollIntervalSeconds: 60 } as const;

export function audioQualityCollectionSettings(options: { maxWaitSeconds?: number; pollIntervalSeconds?: number }) {
  const settings = {
    maxWaitSeconds: options.maxWaitSeconds ?? audioQualityCollectionDefaults.maxWaitSeconds,
    pollIntervalSeconds: options.pollIntervalSeconds ?? audioQualityCollectionDefaults.pollIntervalSeconds,
  };
  if (!Number.isInteger(settings.maxWaitSeconds) || settings.maxWaitSeconds < 1 || settings.maxWaitSeconds > 180 * 60 ||
      !Number.isInteger(settings.pollIntervalSeconds) || settings.pollIntervalSeconds < 1 ||
      settings.pollIntervalSeconds > Math.min(300, settings.maxWaitSeconds)) {
    throw new ConfigurationError("Audio feasibility readback must be bounded to 1-10800 seconds with 1-300 second polling within the budget");
  }
  return settings;
}

/** A finite pilot owns its actual IDs only until this invocation exits. */
export async function collectAudioFeasibilityQuality(
  cycle: CycleResults, graph: GraphClient | undefined,
  options: { acknowledgeTenantWideCallRecords: boolean; maxWaitSeconds?: number; pollIntervalSeconds?: number },
  telemetry: Telemetry, signal: AbortSignal, now: () => number = Date.now,
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<CallQualityCycle> {
  if (options.acknowledgeTenantWideCallRecords !== true) {
    throw new ConfigurationError("Audio feasibility readback requires explicit acknowledgement of tenant-wide CallRecords.Read.All");
  }
  const calls = cycle.results.filter(result => result.testType === "teams-call");
  if (calls.length !== 1 || !calls[0]!.success || !calls[0]!.call?.endedAt ||
      calls[0]!.diagnosticContext.cleanupSucceeded !== true) {
    throw new ConfigurationError("Audio feasibility readback requires one successful pilot with both calls ended and cleanup verified");
  }
  const settings = audioQualityCollectionSettings(options);
  return collectWithinWindow(cycle, graph, settings, telemetry, signal, now, sleep, true);
}
