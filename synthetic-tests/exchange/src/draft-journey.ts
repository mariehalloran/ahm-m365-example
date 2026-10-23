import { IntegrationError } from "../../utils/src/http.js";
import { baseResult, type ProbeHandler } from "../../utils/src/probes.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../../utils/src/steps.js";
import { readDraft, updateDraft } from "./draft-steps.js";
import { authenticate, cleanup, createDraft, type MailAttempt } from "./steps.js";

export const exchangeDraftProbe: ProbeHandler = async (probe, context) => {
  const { signal, telemetry, now = Date.now } = context;
  const startedAt = now();
  const result = baseResult(probe, startedAt);
  const attempt: MailAttempt = {
    mailbox: probe.mailbox ?? "", correlationId: result.correlationId,
    ownedMessageIds: new Set(), mutationAttempted: false,
  };
  try {
    result.diagnosticContext.testStage = "authentication";
    const graph = await measureStep(result, "authenticate", async () => {
      if (!probe.mailbox) throw new IntegrationError("collector-failure");
      return authenticate(context.graph, signal);
    }, now);
    result.diagnosticContext.authenticationDurationMs = Math.max(0, now() - startedAt);
    result.diagnosticContext.testStage = "execution";
    const draftId = await measureStep(result, "create-draft", () => createDraft(graph, attempt, signal), now);
    await measureStep(result, "update-draft", () => updateDraft(graph, attempt, draftId, signal), now);
    result.diagnosticContext.testStage = "download";
    await measureStep(result, "read-draft", () => readDraft(graph, attempt, draftId, signal), now);
    result.success = true;
    result.diagnosticContext.testStage = "complete";
  } catch (error) {
    journeyFailure(result, error, telemetry);
  } finally {
    await cleanupStep(result, attempt.mutationAttempted,
      cleanupSignal => cleanup(context.graph!, attempt, cleanupSignal), telemetry, now,
      context.config.EXCHANGE_CLEANUP_ENABLED !== "false");
  }
  return finishJourney(result, startedAt, now);
};
