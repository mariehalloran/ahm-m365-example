import { categoryOf, IntegrationError } from "../../utils/src/http.js";
import { baseResult, type ProbeHandler } from "../../utils/src/probes.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../../utils/src/steps.js";
import { authenticate, cleanup, confirmPublication, postMessage, type ChannelAttempt } from "./steps.js";

export const teamsProbe: ProbeHandler = async (probe, context) => {
  const { config, signal, telemetry, now = Date.now } = context;
  const startedAt = now();
  const deadline = startedAt + config.PROBE_TIMEOUT_MS;
  const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(config.PROBE_TIMEOUT_MS)]);
  const result = baseResult(probe, startedAt);
  const attempt: ChannelAttempt = {
    serviceUrl: probe.serviceUrl ?? "", tenantId: probe.tenantId ?? "",
    teamId: probe.teamId ?? "", channelId: probe.channelId ?? "",
    marker: `AHM synthetic ${result.correlationId}`, mutationAttempted: false,
  };
  const classify = (error: unknown) => {
    const category = categoryOf(error);
    if (signal.aborted) return "cancelled";
    if (executionSignal.aborted) return result.diagnosticContext.testStage === "poll" ? "read-failure" : "delivery-timeout";
    if (category === "graph-unavailable") return result.diagnosticContext.testStage === "send" ? "send-failure" : "read-failure";
    return category;
  };
  try {
    result.diagnosticContext.testStage = "authentication";
    const { graph, bot } = await measureStep(result, "authenticate", async () => {
      const clients = await authenticate(context.graph, context.teamsBot, attempt, executionSignal);
      if (now() >= deadline) throw new IntegrationError("delivery-timeout");
      return clients;
    }, now, classify);
    result.diagnosticContext.authenticationDurationMs = Math.max(0, now() - startedAt);
    result.diagnosticContext.testStage = "send";
    const sendStartedAt = now();
    try {
      await measureStep(result, "post-message", () => postMessage(bot, attempt, executionSignal), now, classify);
    } finally { result.sendDurationMs = Math.max(0, now() - sendStartedAt); }
    result.diagnosticContext.testStage = "poll";
    await measureStep(result, "confirm-publication", () => confirmPublication(
      graph, bot.applicationId, attempt, executionSignal, deadline, config.POLL_INTERVAL_MS, now, context.sleep,
    ), now, classify);
    result.publicationDurationMs = Math.max(0, now() - sendStartedAt);
    result.success = true;
    result.diagnosticContext.testStage = "complete";
  } catch (error) {
    journeyFailure(result, error, telemetry);
  } finally {
    await cleanupStep(result, attempt.mutationAttempted,
      cleanupSignal => cleanup(context.teamsBot!, attempt, cleanupSignal), telemetry, now);
  }
  return finishJourney(result, startedAt, now);
};
