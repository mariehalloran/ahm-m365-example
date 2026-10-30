import {
  maxStepDetailLength, probeServices, type DiagnosticCategory, type StepName, type SyntheticResult, type Telemetry,
} from "../contracts.js";
import { categoryOf, IntegrationError } from "../integrations/http.js";

/**
 * Runs one probe step and records step timing and diagnostics on the result object.
 */
export async function measureStep<T>(
  result: SyntheticResult, name: StepName, operation: () => Promise<T>,
  now: () => number = Date.now,
  classify: (error: unknown) => DiagnosticCategory = categoryOf,
): Promise<T> {
  const started = now();
  try {
    const value = await operation();
    const finished = now();
    result.steps.push({
      name, status: "succeeded", observedAt: new Date(finished).toISOString(),
      durationMs: Math.max(0, finished - started),
    });
    return value;
  } catch (error) {
    const finished = now();
    result.steps.push({
      name, status: "failed", observedAt: new Date(finished).toISOString(),
      durationMs: Math.max(0, finished - started), diagnosticCategory: classify(error),
      ...(error instanceof IntegrationError && error.detail ? { detail: error.detail.slice(0, maxStepDetailLength) } : {}),
    });
    throw error;
  }
}

/**
 * Marks a probe result failed from a caught journey error and emits failure telemetry.
 */
export function journeyFailure(result: SyntheticResult, error: unknown, telemetry: Telemetry): void {
  const failed = result.steps.find(step => step.status === "failed");
  result.success = false;
  result.diagnosticCategory = failed?.status === "failed" ? failed.diagnosticCategory : categoryOf(error);
  if (error instanceof IntegrationError && error.status) result.diagnosticContext.httpStatus = error.status;
  telemetry.emit("probe-stage-failed", {
    testId: result.testId, correlationId: result.correlationId,
    step: failed?.name, category: result.diagnosticCategory,
    ...(error instanceof IntegrationError && error.detail ? { detail: error.detail } : {}),
  });
}

/**
 * Runs bounded cleanup for a journey and records cleanup status without hiding failures.
 */
export async function cleanupStep(
  result: SyntheticResult, mutationAttempted: boolean,
  operation: (signal: AbortSignal) => Promise<void>, telemetry: Telemetry,
  now: () => number = Date.now, enabled = true,
): Promise<void> {
  if (!enabled) {
    result.steps.push({ name: "cleanup", status: "skipped", observedAt: new Date(now()).toISOString(), reason: "cleanup-disabled" });
    telemetry.emit(`${probeServices[result.testType].service}-cleanup-disabled`, {
      testId: result.testId, correlationId: result.correlationId, mode: "live", mutationAttempted,
    });
    return;
  }
  if (!mutationAttempted) {
    result.steps.push({ name: "cleanup", status: "skipped", observedAt: new Date(now()).toISOString(), reason: "no-mutation" });
    result.diagnosticContext.cleanupSucceeded = true;
    return;
  }
  try {
    // Cleanup has its own budget, independent of the cancelled journey.
    await measureStep(result, "cleanup", () => operation(AbortSignal.timeout(10000)), now, () => "cleanup-failure");
    result.diagnosticContext.cleanupSucceeded = true;
  } catch {
    result.diagnosticContext.cleanupSucceeded = false;
    telemetry.emit("probe-cleanup-failed", {
      testId: result.testId, correlationId: result.correlationId, category: "cleanup-failure",
    });
    if (result.success) {
      result.success = false;
      result.diagnosticCategory = "cleanup-failure";
      result.diagnosticContext.testStage = "cleanup";
    }
  }
}

/**
 * Finalizes a journey result by setting observed/duration fields and filling skipped steps.
 */
export function finishJourney(result: SyntheticResult, startedAt: number, now: () => number = Date.now): SyntheticResult {
  result.observedAt = new Date(now()).toISOString();
  result.durationMs = Math.max(0, now() - startedAt);
  const order: readonly StepName[] = probeServices[result.testType].steps;
  for (const name of order) {
    if (!result.steps.some(step => step.name === name)) {
      result.steps.push({ name, status: "skipped", observedAt: result.observedAt, reason: "prerequisite-failed" });
    }
  }
  result.steps.sort((left, right) => order.indexOf(left.name) - order.indexOf(right.name));
  return result;
}
