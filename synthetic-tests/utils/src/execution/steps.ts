import {
  isInconclusiveCategory, maxStepDetailLength, observedGraphServerErrors, probeServices,
  type DiagnosticCategory, type HttpResponseDiagnostics, type StepName, type SyntheticResult, type Telemetry,
} from "../contracts.js";
import { categoryOf, IntegrationError, withAbort } from "../integrations/http.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { StepResult } from "../contracts.js";

interface StepObserver {
  completed(result: SyntheticResult, name: StepName): Promise<void>;
  category(category: DiagnosticCategory, error?: unknown): DiagnosticCategory;
  requestPermits?: { started(): void; waitingCancelled(): void };
  result?: SyntheticResult;
}
interface StepContext {
  observer?: StepObserver;
  attempt?: { result: SyntheticResult; firstServerError?: HttpResponseDiagnostics };
  step?: { response?: HttpResponseDiagnostics; observedGraphServerErrorCount: number };
}
const stepObserver = new AsyncLocalStorage<StepContext>();

/**
 * Node async context scopes callbacks to each concurrently executing journey without changing
 * result objects or plumbing a reporting transport through every Graph operation.
 */
export function withStepObserver<T>(observer: StepObserver, operation: () => Promise<T>): Promise<T> {
  if (observer.result) observer.result.diagnosticContext.observedGraphServerErrorCount ??= 0;
  return stepObserver.run({
    observer, ...(observer.result ? { attempt: { result: observer.result } } : {}),
  }, operation);
}

/** Captures the current attempt's actual-request observer when a shared permit waiter is created. */
export function requestPermitObserver() {
  return stepObserver.getStore()?.observer?.requestPermits;
}

/** Captures Graph headers before body reads, retries or request-permit cleanup can discard them. */
export function observeGraphResponse(diagnostics: HttpResponseDiagnostics): void {
  const context = stepObserver.getStore();
  if (!context?.attempt) return;
  const serverError = diagnostics.httpStatus >= 500 && diagnostics.httpStatus <= 599;
  if (context.step) {
    if (serverError) context.step.observedGraphServerErrorCount++;
    const previous = context.step.response;
    if (!previous || previous.httpStatus < 500 || previous.httpStatus > 599) context.step.response = diagnostics;
  }
  const { result } = context.attempt;
  result.diagnosticContext.observedGraphServerErrorCount =
    (result.diagnosticContext.observedGraphServerErrorCount ?? 0) + (serverError ? 1 : 0);
  if (serverError) context.attempt.firstServerError ??= diagnostics;
  if (context.attempt.firstServerError) Object.assign(result.diagnosticContext, context.attempt.firstServerError);
}

/** Copies only safe metadata from an integration error onto the action that actually received it. */
function errorDiagnostics(error: unknown): Partial<HttpResponseDiagnostics> {
  return error instanceof IntegrationError ? {
    ...error.response, ...(error.status === undefined ? {} : { httpStatus: error.status }),
  } : {};
}

/** Keeps a step's first 5xx ahead of later successful retries while refreshing safe parsed metadata. */
function stepEvidence(context: StepContext, error?: unknown) {
  if (context.attempt?.firstServerError) {
    Object.assign(context.attempt.result.diagnosticContext, context.attempt.firstServerError);
  }
  const response = context.step?.response;
  const diagnostic = errorDiagnostics(error);
  return {
    ...(response && response.httpStatus >= 500 && response.httpStatus <= 599 ? response
      : diagnostic.httpStatus === undefined ? response : diagnostic),
    observedGraphServerErrorCount: context.step?.observedGraphServerErrorCount ?? 0,
  };
}

/** An actual Graph 5xx makes the attempt conclusive without hiding an enclosing interruption. */
export function retainGraphServerFailure(result: SyntheticResult): SyntheticResult {
  if (observedGraphServerErrors(result.diagnosticContext) > 0) {
    result.success = false;
    if (result.diagnosticCategory === "cancelled" || result.diagnosticCategory === "cleanup-failure") {
      result.diagnosticContext.interruptionCategory ??= result.diagnosticCategory;
    }
    if (!result.diagnosticCategory || isInconclusiveCategory(result.diagnosticCategory)) {
      result.diagnosticCategory = "graph-unavailable";
    }
  }
  return result;
}

/** Records the action before awaiting its independent reporting callback. */
async function recordStep(result: SyntheticResult, step: StepResult): Promise<void> {
  result.steps.push(step);
  await stepObserver.getStore()?.observer?.completed(result, step.name);
}

/**
 * Runs one probe step and records step timing and diagnostics on the result object.
 */
export async function measureStep<T>(
  result: SyntheticResult, name: StepName, operation: () => Promise<T>,
  now: () => number = Date.now,
  classify: (error: unknown) => DiagnosticCategory = categoryOf,
): Promise<T> {
  const parent = stepObserver.getStore();
  result.diagnosticContext.observedGraphServerErrorCount ??= 0;
  const context: StepContext = {
    ...parent, attempt: parent?.attempt?.result === result ? parent.attempt : { result },
    step: { observedGraphServerErrorCount: 0 },
  };
  return stepObserver.run(context, async () => {
    const started = now();
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      const finished = now();
      const category = classify(error);
      await recordStep(result, {
        name, status: "failed", observedAt: new Date(finished).toISOString(),
        durationMs: Math.max(0, finished - started), diagnosticCategory: context.observer?.category(category, error) ?? category,
        ...stepEvidence(context, error),
        ...(error instanceof IntegrationError && error.detail ? { detail: error.detail.slice(0, maxStepDetailLength) } : {}),
      });
      throw error;
    }
    const finished = now();
    await recordStep(result, {
      name, status: "succeeded", observedAt: new Date(finished).toISOString(),
      durationMs: Math.max(0, finished - started), ...stepEvidence(context),
    });
    return value;
  });
}

/**
 * Retains genuine service failures ahead of later inconclusive errors and emits the observed outcome.
 */
export function journeyFailure(result: SyntheticResult, error: unknown, telemetry: Telemetry): void {
  const failures = result.steps.filter(step => step.status === "failed");
  const failed = failures.find(step => !isInconclusiveCategory(step.diagnosticCategory)) ?? failures[0];
  const previous = result.diagnosticCategory;
  result.success = false;
  result.diagnosticCategory = failed && !isInconclusiveCategory(failed.diagnosticCategory) ? failed.diagnosticCategory
    : previous && !isInconclusiveCategory(previous) ? previous : failed?.diagnosticCategory ?? categoryOf(error);
  if (observedGraphServerErrors(result.diagnosticContext) === 0) {
    Object.assign(result.diagnosticContext, errorDiagnostics(error));
  }
  retainGraphServerFailure(result);
  telemetry.emit(isInconclusiveCategory(result.diagnosticCategory) ? "probe-stage-inconclusive" : "probe-stage-failed", {
    testId: result.testId, correlationId: result.correlationId,
    step: failed?.name, category: result.diagnosticCategory,
    ...(error instanceof IntegrationError && error.detail ? { detail: error.detail } : {}),
    ...errorDiagnostics(error),
    observedGraphServerErrorCount: result.diagnosticContext.observedGraphServerErrorCount,
  });
}

/**
 * Runs bounded cleanup for a journey and records cleanup status without hiding failures.
 */
export async function cleanupStep(
  result: SyntheticResult, mutationAttempted: boolean,
  operation: (signal: AbortSignal) => Promise<void>, telemetry: Telemetry, cleanupTimeoutMs: number,
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
    const signal = AbortSignal.timeout(cleanupTimeoutMs);
    await measureStep(result, "cleanup", () => withAbort(signal, () => operation(signal)), now, () => "cleanup-failure");
    result.diagnosticContext.cleanupSucceeded = true;
  } catch (error) {
    result.diagnosticContext.cleanupSucceeded = false;
    const step = result.steps.find(step => step.name === "cleanup");
    const diagnostics = step && step.status !== "skipped" ? {
      ...(step.httpStatus === undefined ? {} : { httpStatus: step.httpStatus }),
      ...(step.serviceErrorCode ? { serviceErrorCode: step.serviceErrorCode } : {}),
      ...(step.requestId ? { requestId: step.requestId } : {}),
      ...(step.retryAfter ? { retryAfter: step.retryAfter } : {}),
      observedGraphServerErrorCount: step.observedGraphServerErrorCount,
    } : errorDiagnostics(error);
    result.diagnosticContext.cleanupFailure = {
      category: categoryOf(error),
      ...diagnostics,
      ...(error instanceof IntegrationError && error.detail ? { detail: error.detail.slice(0, maxStepDetailLength) } : {}),
    };
    telemetry.emit("probe-cleanup-failed", {
      testId: result.testId, correlationId: result.correlationId, category: "cleanup-failure",
      cause: categoryOf(error),
      ...diagnostics,
      ...(error instanceof IntegrationError && error.detail ? { detail: error.detail } : {}),
    });
    if (result.success) {
      result.success = false;
      result.diagnosticCategory = "cleanup-failure";
      result.diagnosticContext.testStage = "cleanup";
    }
    retainGraphServerFailure(result);
  }
}

/**
 * Finalizes a journey result by setting observed/duration fields and filling skipped steps.
 */
export function finishJourney(result: SyntheticResult, startedAt: number, now: () => number = Date.now): SyntheticResult {
  retainGraphServerFailure(result);
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
