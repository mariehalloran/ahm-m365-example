import { baseResult, type ProbeHandler } from "../../utils/src/execution/probes.js";
import {
  cleanupStep,
  finishJourney,
  journeyFailure,
  measureStep,
} from "../../utils/src/execution/steps.js";
import { deleteDraft, readDraft, updateDraft } from "./draft-steps.js";
import {
  authenticate,
  cleanup,
  createDraft,
  type MailAttempt,
} from "./steps.js";

/**
 * Executes the Exchange draft lifecycle synthetic probe by creating, reading,
 * updating, re-reading, and deleting a draft message in the target mailbox.
 */
export const exchangeDraftProbe: ProbeHandler<"exchange-draft"> = async (probe, context) => {
  const { signal, telemetry } = context;
  const startedAt = Date.now();
  const result = context.result ?? baseResult(probe, startedAt);
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
    );
    result.diagnosticContext.authenticationDurationMs = Math.max(
      0,
      Date.now() - startedAt,
    );

    result.diagnosticContext.testStage = "execution";
    const draftId = await measureStep(
      result,
      "create-draft",
      () => createDraft(graph, attempt, signal),
    );
    await measureStep(
      result,
      "read-initial-draft",
      () => readDraft(graph, attempt, draftId, signal, false),
    );
    await measureStep(
      result,
      "update-draft",
      () => updateDraft(graph, attempt, draftId, signal),
    );

    result.diagnosticContext.testStage = "download";
    await measureStep(
      result,
      "read-draft",
      () => readDraft(graph, attempt, draftId, signal),
    );
    await measureStep(
      result,
      "delete-draft",
      () => deleteDraft(graph, attempt, draftId, signal),
    );

    result.success = true;
    result.diagnosticContext.testStage = "complete";
  } catch (error) {
    journeyFailure(result, error, telemetry);
  } finally {
    context.executionComplete?.();
    const cleanupEnabled = context.config.EXCHANGE_CLEANUP_ENABLED !== "false";
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
