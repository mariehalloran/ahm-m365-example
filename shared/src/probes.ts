import { randomUUID } from "node:crypto";
import type { Probe, Scenario, SyntheticResult, Telemetry } from "./contracts.js";
import type { GraphClient } from "./graph.js";

export interface ProbeContext {
  config: {
    SYNTHETIC_SCENARIO: Scenario;
    PROBE_TIMEOUT_MS: number;
    POLL_INTERVAL_MS: number;
  };
  signal: AbortSignal;
  graph?: GraphClient;
  telemetry: Telemetry;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export type ProbeHandler = (probe: Probe, context: ProbeContext) => Promise<SyntheticResult>;

export function baseResult(probe: Probe, now: number): SyntheticResult {
  return {
    schemaVersion: "2.0",
    testType: probe.type,
    testId: probe.id,
    cohort: probe.cohort,
    targetService: probe.type === "exchange-mail-flow" ? "Exchange Online" : "SharePoint Online",
    success: false,
    durationMs: 0,
    observedAt: new Date(now).toISOString(),
    correlationId: randomUUID(),
    diagnosticCategory: null,
    diagnosticContext: { ...(probe.region ? { region: probe.region } : {}) },
  };
}

export const simulate: ProbeHandler = async (probe, { config, now = Date.now }) => {
  const result = baseResult(probe, now());
  const scenario = probe.scenario ?? config.SYNTHETIC_SCENARIO;
  result.success = scenario === "healthy" || scenario === "slow" || scenario === "stale";
  result.durationMs = scenario === "slow" ? 30000 : scenario === "timeout" ? 65000 : 3200;
  if (probe.type === "exchange-mail-flow" && result.success) {
    result.deliveryDurationMs = result.durationMs;
  }
  result.diagnosticCategory = scenario === "failed" ? "send-failure" : scenario === "timeout" ? "delivery-timeout" : null;
  result.diagnosticContext.testStage = "simulated";
  if (scenario === "stale") {
    result.observedAt = new Date(now() - 30 * 60 * 1000).toISOString();
  }
  return result;
};
