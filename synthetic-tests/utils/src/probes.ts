import { randomUUID } from "node:crypto";
import { probeServices, type Probe, type Scenario, type StepName, type SyntheticResult, type Telemetry, type TestType } from "./contracts.js";
import type { GraphClient } from "./graph.js";
import type { TeamsBotClient } from "./teams.js";
import { IntegrationError } from "./http.js";

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

export function dispatchProbeHandlers(handlers: Partial<Record<TestType, ProbeHandler>>): ProbeHandler {
  return (probe, context) => {
    const handler = handlers[probe.type];
    if (!handler) throw new IntegrationError("collector-failure");
    return handler(probe, context);
  };
}

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
  const metadata = probeServices[probe.type];
  const orderedSteps: readonly StepName[] = metadata.steps;
  const scenario = probe.scenario ?? config.SYNTHETIC_SCENARIO;
  result.success = scenario === "healthy" || scenario === "slow" || scenario === "stale";
  result.durationMs = scenario === "slow" ? 30000 : scenario === "timeout" ? 65000 : 3200;
  result.diagnosticCategory = scenario === "failed"
    ? metadata.service === "sharepoint" || probe.type === "exchange-draft" ? "read-failure" : "send-failure"
    : scenario === "timeout" ? "delivery-timeout" : null;
  result.diagnosticContext.testStage = "simulated";
  result.diagnosticContext.cleanupSucceeded = true;
  if (scenario === "stale") {
    result.observedAt = new Date(now() - 30 * 60 * 1000).toISOString();
  }
  const failureSteps = {
    "exchange-mail-flow": "send", "exchange-draft": "update-draft",
    "teams-channel-message": "post-message", "teams-channel-reply": "post-reply",
    "sharepoint-file": "read-file", "sharepoint-rename": "rename-file",
  } as const;
  const completionSteps = {
    "exchange-mail-flow": "confirm-delivery", "exchange-draft": "read-draft",
    "teams-channel-message": "confirm-publication", "teams-channel-reply": "confirm-reply",
    "sharepoint-file": "read-file", "sharepoint-rename": "read-file",
  } as const;
  const failedStep = scenario === "failed" ? failureSteps[probe.type]
    : scenario === "timeout" ? completionSteps[probe.type] : undefined;
  const longStep = failedStep ?? completionSteps[probe.type];
  const baseline = (name: StepName) => ["authenticate", "cleanup", "verify-drive"].includes(name) ? 100 : 200;
  const fixedDuration = orderedSteps.reduce((sum, name) =>
    sum + (name === longStep || (failedStep && name !== "cleanup" && orderedSteps.indexOf(name) > orderedSteps.indexOf(failedStep)) ? 0 : baseline(name)), 0);
  let blocked = false;
  result.steps = orderedSteps.map(name => {
    const common = { name, observedAt: result.observedAt };
    if (blocked && name !== "cleanup") return { ...common, status: "skipped", reason: "prerequisite-failed" };
    const durationMs = name === longStep ? Math.max(0, result.durationMs - fixedDuration) : baseline(name);
    if (name === failedStep) {
      blocked = true;
      return { ...common, status: "failed", durationMs, diagnosticCategory: result.diagnosticCategory! };
    }
    return { ...common, status: "succeeded", durationMs };
  });
  const stepDuration = (name: string) => {
    const step = result.steps.find(step => step.name === name);
    return step && step.status !== "skipped" ? step.durationMs : undefined;
  };
  const confirmedDuration = (request: string, completion: string) => {
    const submitted = stepDuration(request);
    const confirmed = stepDuration(completion);
    if (submitted === undefined || confirmed === undefined) throw new IntegrationError("malformed-response");
    return submitted + confirmed;
  };
  const sendStep = metadata.service === "teams"
    ? probe.type === "teams-channel-reply" ? "post-reply" : "post-message"
    : probe.type === "exchange-mail-flow" ? "send" : undefined;
  if (sendStep) {
    const measured = stepDuration(sendStep);
    if (measured !== undefined) result.sendDurationMs = measured;
  }
  if (probe.type === "exchange-mail-flow" && result.success) {
    result.deliveryDurationMs = confirmedDuration("send", "confirm-delivery");
  }
  if (metadata.service === "teams" && result.success && sendStep) {
    result.publicationDurationMs = confirmedDuration(sendStep, completionSteps[probe.type]);
  }
  if (metadata.service === "sharepoint") {
    const upload = stepDuration("upload-file");
    const read = stepDuration("read-file");
    if (upload !== undefined) result.uploadDurationMs = upload;
    if (read !== undefined) result.readDurationMs = read;
  }
  return result;
};
