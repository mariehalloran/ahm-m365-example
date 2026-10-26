import { setTimeout as delay } from "node:timers/promises";
import { probeServices, testTypes, type Telemetry } from "./contracts.js";
import type { ServiceConfig } from "./service-config.js";

export interface ExecutionLane {
  name: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  journeys: string[];
}

export function executionLanes(service: Pick<ServiceConfig, "type" | "intervalSeconds" | "timeoutSeconds" | "executionLanes">): ExecutionLane[] {
  if (service.executionLanes) return service.executionLanes;
  const journeys = testTypes.filter(type => probeServices[type].service === service.type).map(type => probeServices[type].journey);
  if (service.type === "exchange") return [
    { name: "mail", intervalSeconds: service.intervalSeconds, timeoutSeconds: service.timeoutSeconds, journeys: ["send-receive-mail"] },
    { name: "extended", intervalSeconds: 300, timeoutSeconds: service.timeoutSeconds, journeys: journeys.filter(name => name !== "send-receive-mail") },
  ];
  return [{ name: service.type, intervalSeconds: service.intervalSeconds, timeoutSeconds: service.timeoutSeconds, journeys }];
}

export async function runExecutionLanes(
  lanes: ExecutionLane[], execute: (lane: ExecutionLane) => Promise<void>,
  options: {
    signal: AbortSignal; telemetry: Telemetry; once?: boolean;
    now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const origin = now();
  const outcomes = await Promise.allSettled(lanes.map(async lane => {
    const interval = lane.intervalSeconds * 1000;
    let slot = 0;
    while (!options.signal.aborted) {
      options.telemetry.emit("execution-lane-started", { lane: lane.name, slot });
      try { await execute(lane); }
      catch (error) {
        options.telemetry.emit("execution-lane-failed", { lane: lane.name, slot });
        if (options.once) throw error;
      }
      if (options.once || options.signal.aborted) return;
      slot++;
      const skipped = Math.max(0, Math.ceil((now() - origin - slot * interval) / interval));
      if (skipped) {
        options.telemetry.emit("service-slots-skipped", { lane: lane.name, skipped, firstSlot: slot, intervalSeconds: lane.intervalSeconds });
        slot += skipped;
      }
      try { await sleep(Math.max(0, origin + slot * interval - now()), options.signal); }
      catch (error) { if (!options.signal.aborted) throw error; }
    }
  }));
  const failures = [...new Set(outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []))];
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Multiple service worker operations failed");
}
