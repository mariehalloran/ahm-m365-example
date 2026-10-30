import type { DiagnosticCategory, SyntheticResult } from "../../utils/src/contracts.js";
import { categoryOf } from "../../utils/src/integrations/http.js";
import { baseResult, type ProbeHandler } from "../../utils/src/execution/probes.js";
import {
  cleanupStep,
  finishJourney,
  journeyFailure,
  measureStep,
} from "../../utils/src/execution/steps.js";
import {
  authenticate,
  cleanup,
  confirmDelivery,
  createDraft,
  sendMessage,
  type MailAttempt,
} from "./steps.js";

/**
 * Classifies errors encountered during the Exchange mail-flow journey based on
 * whether the message has already been sent and which stage was executing.
 */
function classifyMailFlowError(
  error: unknown,
  result: SyntheticResult,
  sent: boolean,
): DiagnosticCategory {
  const category = categoryOf(error);
  if (category === "cancelled" && sent) {
    return "delivery-timeout";
  }
  if (category === "graph-unavailable") {
    if (result.diagnosticContext.testStage === "send") {
      return "send-failure";
    }
    return "read-failure";
  }
  return category;
}

/**
 * Executes the Exchange self-addressed mail-flow probe by creating a draft,
 * sending it to the same mailbox, polling the inbox for delivery, and cleaning up.
 */
export const exchangeProbe: ProbeHandler<"exchange-mail-flow"> = async (probe, context) => {
  const { config, signal, telemetry } = context;
  const startedAt = Date.now();
  const result = baseResult(probe, startedAt);
  const attempt: MailAttempt = {
    mailbox: probe.mailbox,
    correlationId: result.correlationId,
    ownedMessageIds: new Set(),
    mutationAttempted: false,
  };
  let sent = false;

  /**
   * Maps step failures to the mail-flow diagnostic category for the current stage.
   */
  function classify(error: unknown): DiagnosticCategory {
    return classifyMailFlowError(error, result, sent);
  }

  try {
    result.diagnosticContext.testStage = "authentication";
    const graph = await measureStep(
      result,
      "authenticate",
      () => authenticate(context.graph, signal),
      Date.now,
      classify,
    );
    result.diagnosticContext.authenticationDurationMs = Math.max(
      0,
      Date.now() - startedAt,
    );

    result.diagnosticContext.testStage = "send";
    const draftId = await measureStep(
      result,
      "create-draft",
      () => createDraft(graph, attempt, signal),
      Date.now,
      classify,
    );

    const sendStarted = Date.now();
    try {
      await measureStep(
        result,
        "send",
        () => sendMessage(graph, attempt, draftId, signal),
        Date.now,
        classify,
      );
    } finally {
      result.sendDurationMs = Math.max(0, Date.now() - sendStarted);
    }
    sent = true;

    result.diagnosticContext.testStage = "poll";
    await measureStep(
      result,
      "confirm-delivery",
      () =>
        confirmDelivery(
          graph,
          attempt,
          signal,
          startedAt + config.PROBE_TIMEOUT_MS,
          config.POLL_INTERVAL_MS,
        ),
      Date.now,
      classify,
    );
    result.deliveryDurationMs = Math.max(0, Date.now() - sendStarted);
    result.success = true;
    result.diagnosticContext.testStage = "delivery-confirmed";
  } catch (error) {
    journeyFailure(result, error, telemetry);
  } finally {
    context.executionComplete?.();
    const cleanupEnabled = config.EXCHANGE_CLEANUP_ENABLED !== "false";
    await cleanupStep(
      result,
      attempt.mutationAttempted,
      (cleanupSignal) => cleanup(context.graph!, attempt, cleanupSignal),
      telemetry,
      Date.now,
      cleanupEnabled,
    );
  }

  return finishJourney(result, startedAt);
};
