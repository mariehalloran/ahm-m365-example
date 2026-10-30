import { setTimeout as delay } from "node:timers/promises";
import { probeServices, testTypes, type Telemetry } from "../contracts.js";
import type { ServiceConfig } from "../configuration/service-config.js";
import { EXCHANGE_INTERVAL_SECONDS, JOURNEY_TIMEOUT_SECONDS } from "./budgets.js";

export interface ExecutionLane {
  name: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  journeys: string[];
  alignToInterval?: boolean;
}

/** Keeps all Exchange journeys on one aligned two-minute lane and other service/provider lanes independent. */
export function executionLanes(service: Pick<ServiceConfig, "type" | "intervalSeconds" | "timeoutSeconds" | "executionLanes">): ExecutionLane[] {
  const journeys = testTypes.filter(type => probeServices[type].service === service.type).map(type => probeServices[type].journey);
  if (service.type !== "exchange") {
    return service.executionLanes ?? [{ name: service.type, intervalSeconds: service.intervalSeconds, timeoutSeconds: service.timeoutSeconds, journeys }];
  }
  return [{
    name: "exchange", intervalSeconds: EXCHANGE_INTERVAL_SECONDS, timeoutSeconds: JOURNEY_TIMEOUT_SECONDS,
    journeys, alignToInterval: true,
  }];
}

/** Awaits each lane's batch before its next slot, skipping missed slots instead of catching up. */
export async function runExecutionLanes(
  lanes: ExecutionLane[], execute: (lane: ExecutionLane) => Promise<void>,
  options: {
    signal: AbortSignal; telemetry: Telemetry; once?: boolean;
    now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const origin = now();
  const outcomes = await Promise.allSettled(lanes.map(async lane => {
    const interval = lane.intervalSeconds * 1000;
    const laneOrigin = lane.alignToInterval && !options.once ? Math.ceil(origin / interval) * interval : origin;
    if (laneOrigin > now()) {
      try { await sleep(laneOrigin - now(), options.signal); }
      catch (error) { if (!options.signal.aborted) throw error; }
    }
    let slot = 0;
    let lastStartedSlot = -1;
    while (!options.signal.aborted) {
      if (lane.alignToInterval && !options.once) {
        slot = Math.max(slot, Math.floor((now() - laneOrigin) / interval));
        if (slot <= lastStartedSlot || now() < laneOrigin + slot * interval) {
          const nextSlot = Math.max(slot, lastStartedSlot + 1);
          try { await sleep(Math.max(0, laneOrigin + nextSlot * interval - now()), options.signal); }
          catch (error) { if (!options.signal.aborted) throw error; }
          continue;
        }
      }
      lastStartedSlot = slot;
      options.telemetry.emit("execution-lane-started", { lane: lane.name, slot });
      try { await execute(lane); }
      catch (error) {
        options.telemetry.emit("execution-lane-failed", { lane: lane.name, slot });
        if (options.once) throw error;
      }
      if (options.once || options.signal.aborted) return;
      slot++;
      const skipped = Math.max(0, Math.ceil((now() - laneOrigin - slot * interval) / interval));
      if (skipped) {
        options.telemetry.emit("service-slots-skipped", { lane: lane.name, skipped, firstSlot: slot, intervalSeconds: lane.intervalSeconds });
        slot += skipped;
      }
      try { await sleep(Math.max(0, laneOrigin + slot * interval - now()), options.signal); }
      catch (error) { if (!options.signal.aborted) throw error; }
    }
  }));
  const failures = [...new Set(outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []))];
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Multiple service worker operations failed");
}
