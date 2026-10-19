import { randomUUID } from "node:crypto";
import type { Probe, Scenario, SyntheticResult, Telemetry } from "./contracts.js";
import type { GraphClient } from "./graph.js";

export interface ProbeContext {
  config: {
    REPORT_TTL_SECONDS: number;
    SYNTHETIC_SCENARIO: Scenario;
    UNHEALTHY_LATENCY_MS: number;
    POLL_INTERVAL_MS: number;
  };
  signal: AbortSignal;
  graph?: GraphClient;
  telemetry: Telemetry;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export type ProbeHandler = (probe: Probe, context: ProbeContext) => Promise<SyntheticResult>;

export function baseResult(probe: Probe, now: number, ttl: number): SyntheticResult {
  return {
    schemaVersion: "1.0", testType: probe.type, testId: probe.id, cohort: probe.cohort,
    targetService: probe.type === "exchange-mail-flow" ? "Exchange Online" : "SharePoint Online",
    success: false, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl * 1000).toISOString(),
    correlationId: randomUUID(), diagnosticCategory: null,
    diagnosticContext: { ...(probe.region ? { region: probe.region } : {}) },
  };
}

export const simulate: ProbeHandler = async (probe, { config, now = Date.now }) => {
  const result = baseResult(probe, now(), config.REPORT_TTL_SECONDS);
  const scenario = probe.scenario ?? config.SYNTHETIC_SCENARIO;
  result.success = scenario === "healthy" || scenario === "slow" || scenario === "stale";
  result.durationMs = scenario === "slow" ? 30000 : scenario === "timeout" ? 65000 : 3200;
  result.diagnosticCategory = scenario === "failed" ? "send-failure" : scenario === "timeout" ? "delivery-timeout" : null;
  result.diagnosticContext.testStage = "simulated";
  if (scenario === "stale") {
    result.observedAt = new Date(now() - 2 * config.REPORT_TTL_SECONDS * 1000).toISOString();
    result.expiresAt = new Date(now() - config.REPORT_TTL_SECONDS * 1000).toISOString();
  }
  return result;
};
