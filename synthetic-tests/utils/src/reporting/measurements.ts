import {
  isInconclusiveCategory, isReportedStep, journeyStepEntities, observedGraphServerErrors, probeServices,
  type DiagnosticCategory, type HttpResponseDiagnostics, type StepResult, type SyntheticResult,
} from "../contracts.js";

export interface MeasurementSample extends Partial<HttpResponseDiagnostics> {
  success: boolean | null;
  durationMs: number;
  observedAt: string;
  diagnosticCategory?: DiagnosticCategory;
  cleanupFailed?: boolean;
  cleanupFailure?: SyntheticResult["diagnosticContext"]["cleanupFailure"];
  detail?: string;
  observedGraphServerErrorCount: number;
  interruptionCategory?: "cancelled" | "cleanup-failure";
}
export interface SyntheticMeasurement extends MeasurementSample {
  entityName: string;
  journey: string;
  kind: "journey" | "step" | "call-phase";
  step: string;
}

/** Keeps each measurement's own HTTP evidence; explicit zero disables the legacy status fallback. */
function httpEvidence(evidence: Pick<SyntheticResult["diagnosticContext"],
  "httpStatus" | "serviceErrorCode" | "requestId" | "retryAfter" | "observedGraphServerErrorCount"
>) {
  return {
    ...(evidence.httpStatus === undefined ? {} : { httpStatus: evidence.httpStatus }),
    ...(evidence.serviceErrorCode ? { serviceErrorCode: evidence.serviceErrorCode } : {}),
    ...(evidence.requestId ? { requestId: evidence.requestId } : {}),
    ...(evidence.retryAfter ? { retryAfter: evidence.retryAfter } : {}),
    observedGraphServerErrorCount: observedGraphServerErrors(evidence),
  };
}

/** Retains executed-step evidence without assigning a binary sample to an inconclusive action. */
function stepSample(
  step: Exclude<StepResult, { status: "skipped" }>, durationMs = step.durationMs,
): MeasurementSample {
  const evidence = httpEvidence(step);
  return {
    success: evidence.observedGraphServerErrorCount > 0 ? false
      : step.status === "succeeded" ? true : isInconclusiveCategory(step.diagnosticCategory) ? null : false,
    durationMs, observedAt: step.observedAt, ...evidence,
    ...(step.status === "failed" ? {
      diagnosticCategory: step.diagnosticCategory,
      ...(step.detail !== undefined ? { detail: step.detail } : {}),
    } : evidence.observedGraphServerErrorCount > 0 ? { diagnosticCategory: "graph-unavailable" } : {}),
  };
}

/** Projects the journey and only executed business actions, including observed call phases. */
export function resultMeasurements(result: SyntheticResult): SyntheticMeasurement[] {
  const journey = probeServices[result.testType];
  const steps = result.steps.filter(step => isReportedStep(step.name));
  const failed = steps.find(step => step.status === "failed");
  const evidence = httpEvidence(result.diagnosticContext);
  const measurements: SyntheticMeasurement[] = [{
    entityName: journey.entityName, journey: journey.journey, kind: "journey", step: "",
    success: evidence.observedGraphServerErrorCount > 0 ? false
      : isInconclusiveCategory(result.diagnosticCategory) ? null : result.success,
    durationMs: result.durationMs, observedAt: result.observedAt, ...evidence,
    ...(result.diagnosticCategory ? { diagnosticCategory: result.diagnosticCategory }
      : evidence.observedGraphServerErrorCount > 0 ? { diagnosticCategory: "graph-unavailable" } : {}),
    ...(result.diagnosticContext.interruptionCategory ? { interruptionCategory: result.diagnosticContext.interruptionCategory } : {}),
    ...(result.diagnosticContext.cleanupSucceeded === false ? { cleanupFailed: true } : {}),
    ...(result.diagnosticContext.cleanupFailure ? { cleanupFailure: result.diagnosticContext.cleanupFailure } : {}),
    ...(failed?.detail !== undefined ? { detail: failed.detail }
      : result.diagnosticCategory === "cleanup-failure" && result.diagnosticContext.cleanupFailure?.detail
        ? { detail: result.diagnosticContext.cleanupFailure.detail } : {}),
  }];
  for (const step of steps) {
    if (step.status === "skipped") continue;
    measurements.push({
      entityName: `${journey.entityName}-${journeyStepEntities[result.testType]?.[step.name] ?? step.name}`,
      journey: journey.journey, kind: "step", step: step.name, ...stepSample(step),
    });
  }
  if (result.testType === "teams-call") {
    const placed = steps.find(step => step.name === "place-call");
    for (const [phase, name] of [["connection", "wait-for-answer"], ["disconnection", "end-call"]] as const) {
      const step = steps.find(step => step.name === name);
      if (!step || step.status === "skipped") continue;
      const submissionMs = phase === "connection" && placed && placed.status !== "skipped" ? placed.durationMs : 0;
      measurements.push({
        entityName: journey.entityName, journey: journey.journey, kind: "call-phase", step: phase,
        ...stepSample(step, step.durationMs + submissionMs),
      });
    }
  }
  return measurements;
}
