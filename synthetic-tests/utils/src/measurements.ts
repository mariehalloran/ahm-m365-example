import {
  isReportedStep, journeyStepEntities, probeServices,
  type DiagnosticCategory, type StepResult, type SyntheticResult,
} from "./contracts.js";

export interface MeasurementSample {
  success: boolean;
  durationMs: number;
  observedAt: string;
  diagnosticCategory?: DiagnosticCategory;
  detail?: string;
}
export interface SyntheticMeasurement extends MeasurementSample {
  entityName: string;
  journey: string;
  kind: "journey" | "step" | "call-phase";
  step: string;
}

function stepSample(
  step: Exclude<StepResult, { status: "skipped" }>, durationMs = step.durationMs,
): MeasurementSample {
  return {
    success: step.status === "succeeded", durationMs, observedAt: step.observedAt,
    ...(step.status === "failed" ? {
      diagnosticCategory: step.diagnosticCategory,
      ...(step.detail !== undefined ? { detail: step.detail } : {}),
    } : {}),
  };
}

export function resultMeasurements(result: SyntheticResult): SyntheticMeasurement[] {
  const journey = probeServices[result.testType];
  const steps = result.steps.filter(step => isReportedStep(step.name));
  const failed = steps.find(step => step.status === "failed");
  const measurements: SyntheticMeasurement[] = [{
    entityName: journey.entityName, journey: journey.journey, kind: "journey", step: "",
    success: result.success, durationMs: result.durationMs, observedAt: result.observedAt,
    ...(result.diagnosticCategory ? { diagnosticCategory: result.diagnosticCategory } : {}),
    ...(failed?.detail !== undefined ? { detail: failed.detail } : {}),
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
