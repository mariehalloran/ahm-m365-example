import { baseResult, type ProbeHandler } from "../../utils/src/execution/probes.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../../utils/src/execution/steps.js";
import { IntegrationError } from "../../utils/src/integrations/http.js";
import { createListItem, deleteOwnedListItem, readListItem, updateListItem, type ListAttempt } from "./list-steps.js";
import { verifySharePointList, verifySharePointSite } from "./targets.js";

/** Completes the persisted list-item lifecycle and retains business evidence through bounded cleanup. */
export const sharePointListProbe: ProbeHandler<"sharepoint-list-item"> = async (probe, context) => {
  const { signal, telemetry, now = Date.now } = context;
  const startedAt = now();
  const result = context.result ?? baseResult(probe, startedAt);
  const attempt: ListAttempt = { probe, correlationId: result.correlationId, mutationAttempted: false };
  try {
    result.diagnosticContext.testStage = "authentication";
    const graph = await measureStep(result, "authenticate", async () => {
      if (!context.graph) throw new IntegrationError("collector-failure");
      await context.graph.authenticate(signal);
      return context.graph;
    }, now);
    result.diagnosticContext.testStage = "execution";
    await verifySharePointSite(graph, probe, signal);
    await verifySharePointList(graph, probe, signal);
    await measureStep(result, "create-list-item", () => createListItem(graph, attempt, signal), now);
    await measureStep(result, "read-list-item", () => readListItem(graph, attempt, 1, signal), now);
    await measureStep(result, "update-list-item", () => updateListItem(graph, attempt, signal), now);
    await measureStep(result, "verify-list-item", () => readListItem(graph, attempt, 2, signal), now);
    await measureStep(result, "delete-list-item", () => deleteOwnedListItem(graph, attempt, signal), now);
    result.success = true;
    result.diagnosticContext.testStage = "complete";
  } catch (error) {
    journeyFailure(result, error, telemetry);
  } finally {
    context.executionComplete?.();
    await cleanupStep(result, attempt.mutationAttempted, cleanupSignal => {
      if (!context.graph) throw new IntegrationError("collector-failure");
      return deleteOwnedListItem(context.graph, attempt, cleanupSignal);
    }, telemetry, context.config.CLEANUP_TIMEOUT_MS, now);
  }
  return finishJourney(result, startedAt, now);
};
