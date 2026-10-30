import { randomUUID } from "node:crypto";
import { probeServices, type Probe, type Scenario, type StepName, type SyntheticResult, type Telemetry, type TestType } from "../contracts.js";
import type { GraphFileOperations, GraphOperations } from "../integrations/graph.js";
import type { TeamsBotOperations } from "../integrations/teams.js";
import { IntegrationError } from "../integrations/http.js";
import type { LiveProbeFor } from "../configuration/resolved-probes.js";

export interface ProbeContext {
  config: {
    SYNTHETIC_SCENARIO: Scenario;
    PROBE_TIMEOUT_MS: number;
    POLL_INTERVAL_MS: number;
    TEAMS_CLEANUP_ENABLED?: "true" | "false";
    EXCHANGE_CLEANUP_ENABLED?: "true" | "false";
    TEAMS_CALLING_CALLBACK_URL?: string | undefined;
    TEAMS_CALLING_ANSWER_TIMEOUT_SECONDS?: number;
  };
  signal: AbortSignal;
  graph?: GraphFileOperations;
  teamsBot?: TeamsBotOperations;
  teamsCalling?: GraphOperations;
  teamsCallingPeer?: GraphOperations;
  telemetry: Telemetry;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  executionComplete?: () => void;
}
export type ProbeHandler<Type extends TestType = TestType> =
  (probe: LiveProbeFor<Type>, context: ProbeContext) => Promise<SyntheticResult>;
type ProbeHandlers = { [Type in TestType]?: ProbeHandler<Type> };

export function dispatchProbeHandlers(handlers: ProbeHandlers): ProbeHandler {
  const invoke = <Type extends TestType>(type: Type, probe: LiveProbeFor<Type>, context: ProbeContext) => {
    const handler = handlers[type];
    if (!handler) throw new IntegrationError("collector-failure");
    return handler(probe, context);
  };
  return (probe, context) => invoke(probe.type, probe, context);
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
    diagnosticContext: {
      ...(probe.region ? { region: probe.region } : {}),
      ...(probe.botPairId ? { botPairId: probe.botPairId } : {}),
    },
  };
}

export const simulate = async (
  probe: Probe, { config, telemetry, now = Date.now }: ProbeContext,
): Promise<SyntheticResult> => {
  const result = baseResult(probe, now());
  const metadata = probeServices[probe.type];
  const retainArtifacts = (metadata.service === "teams" && probe.type !== "teams-call" && config.TEAMS_CLEANUP_ENABLED === "false") ||
    (metadata.service === "exchange" && probe.type !== "exchange-recurring-calendar" && config.EXCHANGE_CLEANUP_ENABLED === "false");
  const orderedSteps: readonly StepName[] = metadata.steps;
  const scenario = probe.scenario ?? config.SYNTHETIC_SCENARIO;
  result.success = scenario === "healthy" || scenario === "slow" || scenario === "stale";
  result.durationMs = scenario === "slow" ? 30000 : scenario === "timeout" ? 65000 : 3200;
  result.diagnosticCategory = scenario === "failed"
    ? metadata.service === "onedrive" || probe.type === "exchange-draft" ? "read-failure" : "send-failure"
    : scenario === "timeout" ? "delivery-timeout" : null;
  result.diagnosticContext.testStage = "simulated";
  if (!retainArtifacts) result.diagnosticContext.cleanupSucceeded = true;
  if (scenario === "stale") {
    result.observedAt = new Date(now() - 30 * 60 * 1000).toISOString();
  }
  const failureSteps = {
    "exchange-mail-flow": "send", "exchange-draft": "update-draft",
    "exchange-attachment": "send-attachment", "exchange-reply": "reply-mail",
    "exchange-recurring-calendar": "update-event",
    "teams-channel-message": "post-message", "teams-call": "place-call",
    "onedrive-roundtrip": "verify-file-hash", "onedrive-appfolder": "update-app-data", "onedrive-versions": "read-prior-version",
  } as const;
  const completionSteps = {
    "exchange-mail-flow": "confirm-delivery", "exchange-draft": "read-draft",
    "exchange-attachment": "verify-attachment", "exchange-reply": "confirm-reply-mail",
    "exchange-recurring-calendar": "verify-event",
    "teams-channel-message": "confirm-reply", "teams-call": "end-call",
    "onedrive-roundtrip": "verify-file-hash", "onedrive-appfolder": "update-app-data", "onedrive-versions": "read-prior-version",
  } as const;
  const failedStep = scenario === "failed" ? failureSteps[probe.type]
    : scenario === "timeout" ? completionSteps[probe.type] : undefined;
  const longStep = failedStep ?? completionSteps[probe.type];
  const baseline = (name: StepName) => ["authenticate", "cleanup"].includes(name) ? 100 : 200;
  const fixedDuration = orderedSteps.reduce((sum, name) =>
    sum + (name === longStep || (name === "cleanup" && retainArtifacts) ||
      (failedStep && name !== "cleanup" && orderedSteps.indexOf(name) > orderedSteps.indexOf(failedStep)) ? 0 : baseline(name)), 0);
  let blocked = false;
  result.steps = orderedSteps.map(name => {
    const common = { name, observedAt: result.observedAt };
    if (name === "restore-version" && !probe.restoreVersion) return { ...common, status: "skipped", reason: "variant-disabled" };
    if (name === "cleanup" && retainArtifacts) return { ...common, status: "skipped", reason: "cleanup-disabled" };
    if (blocked && name !== "cleanup") return { ...common, status: "skipped", reason: "prerequisite-failed" };
    const durationMs = name === longStep ? Math.max(0, result.durationMs - fixedDuration) : baseline(name);
    if (name === failedStep) {
      blocked = true;
      return { ...common, status: "failed", durationMs, diagnosticCategory: result.diagnosticCategory! };
    }
    return { ...common, status: "succeeded", durationMs };
  });
  if (retainArtifacts) telemetry.emit(`${metadata.service}-cleanup-disabled`, {
    testId: result.testId, correlationId: result.correlationId, mode: "simulation",
    mutationAttempted: false, simulation: true,
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
  const sendStep = probe.type === "teams-channel-message"
    ? "post-message"
    : probe.type === "exchange-mail-flow" ? "send" : undefined;
  if (sendStep) {
    const measured = stepDuration(sendStep);
    if (measured !== undefined) result.sendDurationMs = measured;
  }
  if (probe.type === "exchange-mail-flow" && result.success) {
    result.deliveryDurationMs = confirmedDuration("send", "confirm-delivery");
  }
  if (metadata.service === "teams" && result.success && sendStep) {
    result.publicationDurationMs = confirmedDuration(sendStep, "confirm-publication");
  }
  return result;
};
