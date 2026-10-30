import { categoryOf } from "../../utils/src/http.js";
import { baseResult, type ProbeHandler } from "../../utils/src/probes.js";
import {
  cleanupStep,
  finishJourney,
  journeyFailure,
  measureStep,
} from "../../utils/src/steps.js";
import {
  authenticate,
  cleanup,
  confirmDelivery,
  createDraft,
  sendMessage,
  type MailAttempt,
} from "./steps.js";

export const exchangeProbe: ProbeHandler<"exchange-mail-flow"> = async (probe, context) => {
  const { config, signal, telemetry, now = Date.now } = context;
  const startedAt = now();
  const result = baseResult(probe, startedAt);
  const attempt: MailAttempt = {
    mailbox: probe.mailbox,
    correlationId: result.correlationId,
    ownedMessageIds: new Set(),
    mutationAttempted: false,
  };
  let sent = false;
  const classify = (error: unknown) => {
    const category = categoryOf(error);
    if (category === "cancelled" && sent) return "delivery-timeout";
    if (category === "graph-unavailable")
      return result.diagnosticContext.testStage === "send"
        ? "send-failure"
        : "read-failure";
    return category;
  };
  try {
    result.diagnosticContext.testStage = "authentication";
    const graph = await measureStep(
      result,
      "authenticate",
      () => authenticate(context.graph, signal),
      now,
      classify,
    );
    result.diagnosticContext.authenticationDurationMs = Math.max(
      0,
      now() - startedAt,
    );
    result.diagnosticContext.testStage = "send";
    const draftId = await measureStep(
      result,
      "create-draft",
      () => createDraft(graph, attempt, signal),
      now,
      classify,
    );
    const sendStarted = now();
    try {
      await measureStep(
        result,
        "send",
        () => sendMessage(graph, attempt, draftId, signal),
        now,
        classify,
      );
    } finally {
      result.sendDurationMs = Math.max(0, now() - sendStarted);
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
          now,
          context.sleep,
        ),
      now,
      classify,
    );
    result.deliveryDurationMs = Math.max(0, now() - sendStarted);
    result.success = true;
    result.diagnosticContext.testStage = "delivery-confirmed";
  } catch (error) {
    journeyFailure(result, error, telemetry);
  } finally {
    context.executionComplete?.();
    await cleanupStep(
      result,
      attempt.mutationAttempted,
      (cleanupSignal) => cleanup(context.graph!, attempt, cleanupSignal),
      telemetry,
      now,
      config.EXCHANGE_CLEANUP_ENABLED !== "false",
      context.clock,
    );
  }
  return finishJourney(result, startedAt, now);
};
