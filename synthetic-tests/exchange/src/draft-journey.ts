import { baseResult, type ProbeHandler } from "../../utils/src/probes.js";
import {
  cleanupStep,
  finishJourney,
  journeyFailure,
  measureStep,
} from "../../utils/src/steps.js";
import { deleteDraft, readDraft, updateDraft } from "./draft-steps.js";
import {
  authenticate,
  cleanup,
  createDraft,
  type MailAttempt,
} from "./steps.js";

export const exchangeDraftProbe: ProbeHandler<"exchange-draft"> = async (probe, context) => {
  const { signal, telemetry, now = Date.now } = context;
  const startedAt = now();
  const result = baseResult(probe, startedAt);
  const attempt: MailAttempt = {
    mailbox: probe.mailbox,
    correlationId: result.correlationId,
    ownedMessageIds: new Set(),
    mutationAttempted: false,
  };
  try {
    result.diagnosticContext.testStage = "authentication";
    const graph = await measureStep(
      result,
      "authenticate",
      () => authenticate(context.graph, signal),
      now,
    );
    result.diagnosticContext.authenticationDurationMs = Math.max(
      0,
      now() - startedAt,
    );
    result.diagnosticContext.testStage = "execution";
    const draftId = await measureStep(
      result,
      "create-draft",
      () => createDraft(graph, attempt, signal),
      now,
    );
    await measureStep(
      result,
      "read-initial-draft",
      () => readDraft(graph, attempt, draftId, signal, false),
      now,
    );
    await measureStep(
      result,
      "update-draft",
      () => updateDraft(graph, attempt, draftId, signal),
      now,
    );
    result.diagnosticContext.testStage = "download";
    await measureStep(
      result,
      "read-draft",
      () => readDraft(graph, attempt, draftId, signal),
      now,
    );
    await measureStep(
      result,
      "delete-draft",
      () => deleteDraft(graph, attempt, draftId, signal),
      now,
      () => "cleanup-failure",
    );
    result.success = true;
    result.diagnosticContext.testStage = "complete";
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
      context.config.EXCHANGE_CLEANUP_ENABLED !== "false",
    );
  }
  return finishJourney(result, startedAt, now);
};
