import { randomUUID } from "node:crypto";
import { probeServices, type Probe, type Scenario, type SyntheticResult, type Telemetry } from "./contracts.js";
import type { GraphClient } from "./graph.js";
import type { TeamsBotClient } from "./teams.js";

export interface ProbeContext {
  config: {
    SYNTHETIC_SCENARIO: Scenario;
    PROBE_TIMEOUT_MS: number;
    POLL_INTERVAL_MS: number;
  };
  signal: AbortSignal;
  graph?: GraphClient;
  teamsBot?: TeamsBotClient;
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
    targetService: probeServices[probe.type].target,
    success: false,
    durationMs: 0,
    observedAt: new Date(now).toISOString(),
    correlationId: randomUUID(),
    steps: [],
    diagnosticCategory: null,
    diagnosticContext: { ...(probe.region ? { region: probe.region } : {}) },
  };
}

export const simulate: ProbeHandler = async (probe, { config, now = Date.now }) => {
  const result = baseResult(probe, now());
  const scenario = probe.scenario ?? config.SYNTHETIC_SCENARIO;
  result.success = scenario === "healthy" || scenario === "slow" || scenario === "stale";
  result.durationMs = scenario === "slow" ? 30000 : scenario === "timeout" ? 65000 : 3200;
  if (probe.type === "exchange-mail-flow" || probe.type === "teams-channel-message") {
    result.sendDurationMs = 200;
  }
  if (probe.type === "exchange-mail-flow" && result.success) {
    result.deliveryDurationMs = result.durationMs;
  }
  if (probe.type === "teams-channel-message" && result.success) {
    result.publicationDurationMs = result.durationMs;
  }
  if (probe.type === "sharepoint-file") {
    result.uploadDurationMs = 200;
    result.readDurationMs = result.durationMs - 500;
  }
  result.diagnosticCategory = scenario === "failed"
    ? probe.type === "sharepoint-file" ? "read-failure" : "send-failure"
    : scenario === "timeout" ? "delivery-timeout" : null;
  result.diagnosticContext.testStage = "simulated";
  result.diagnosticContext.cleanupSucceeded = true;
  if (scenario === "stale") {
    result.observedAt = new Date(now() - 30 * 60 * 1000).toISOString();
  }
  const metadata = probeServices[probe.type];
  const failedStep = scenario === "failed"
    ? probe.type === "exchange-mail-flow" ? "send" : probe.type === "teams-channel-message" ? "post-message" : "read-file"
    : scenario === "timeout"
      ? probe.type === "exchange-mail-flow" ? "confirm-delivery" : probe.type === "teams-channel-message" ? "confirm-publication" : "read-file"
      : undefined;
  let blocked = false;
  result.steps = metadata.steps.map(name => {
    const common = { name, observedAt: result.observedAt };
    if (blocked && name !== "cleanup") return { ...common, status: "skipped", reason: "prerequisite-failed" };
    const durationMs = name === failedStep && scenario === "failed" && name !== "read-file"
      ? result.durationMs - (probe.type === "exchange-mail-flow" ? 400 : 200)
      : name.startsWith("confirm-") || name === "read-file"
      ? result.durationMs - (probe.type === "exchange-mail-flow" ? 600 : probe.type === "teams-channel-message" ? 400 : 500)
      : name === "send" || name === "post-message" || name === "create-draft" || name === "upload-file" ? 200 : 100;
    if (name === failedStep) {
      blocked = true;
      return { ...common, status: "failed", durationMs, diagnosticCategory: result.diagnosticCategory! };
    }
    return { ...common, status: "succeeded", durationMs };
  });
  const stepDuration = (name: string) => {
    const step = result.steps.find(step => step.name === name);
    return step && step.status !== "skipped" ? step.durationMs : 0;
  };
  if (probe.type !== "sharepoint-file") {
    result.sendDurationMs = stepDuration(probe.type === "exchange-mail-flow" ? "send" : "post-message");
  }
  if (probe.type === "exchange-mail-flow" && result.success) {
    result.deliveryDurationMs = stepDuration("send") + stepDuration("confirm-delivery");
  }
  if (probe.type === "teams-channel-message" && result.success) {
    result.publicationDurationMs = stepDuration("post-message") + stepDuration("confirm-publication");
  }
  return result;
};
