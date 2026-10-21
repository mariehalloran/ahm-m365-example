import { categoryOf, IntegrationError } from "../../utils/src/http.js";
import { baseResult, type ProbeHandler } from "../../utils/src/probes.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../../utils/src/steps.js";
import {
  authenticate, cleanup, cleanupReply, confirmPublication, confirmReply, postMessage, postReply, type ChannelReplyAttempt,
} from "./steps.js";

const channelProbe = (replyJourney: boolean): ProbeHandler => async (probe, context) => {
  const { config, signal, telemetry, now = Date.now } = context;
  const startedAt = now();
  const deadline = startedAt + config.PROBE_TIMEOUT_MS;
  const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(config.PROBE_TIMEOUT_MS)]);
  const result = baseResult(probe, startedAt);
  const attempt: ChannelReplyAttempt = {
    serviceUrl: probe.serviceUrl ?? "", tenantId: probe.tenantId ?? "",
    teamId: probe.teamId ?? "", channelId: probe.channelId ?? "",
    marker: `AHM synthetic ${result.correlationId}`, mutationAttempted: false,
    replyMarker: `AHM synthetic reply ${result.correlationId}`, replyMutationAttempted: false,
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
    if (replyJourney) {
      await measureStep(result, "post-message", () => postMessage(bot, attempt, executionSignal), now, classify);
    }
    const sendStartedAt = now();
    try {
      await measureStep(result, replyJourney ? "post-reply" : "post-message", async () => {
        if (replyJourney) {
          if (now() >= deadline) throw new IntegrationError("delivery-timeout");
          await postReply(bot, attempt, executionSignal);
        } else {
          await postMessage(bot, attempt, executionSignal);
        }
      }, now, classify);
    } finally {
      if (!replyJourney || attempt.replyMutationAttempted) result.sendDurationMs = Math.max(0, now() - sendStartedAt);
    }
    result.diagnosticContext.testStage = "poll";
    await measureStep(result, replyJourney ? "confirm-reply" : "confirm-publication", () => (replyJourney ? confirmReply : confirmPublication)(
      graph, bot.applicationId, attempt, executionSignal, deadline, config.POLL_INTERVAL_MS, now, context.sleep,
    ), now, classify);
    result.publicationDurationMs = Math.max(0, now() - sendStartedAt);
    result.success = true;
    result.diagnosticContext.testStage = "complete";
  } catch (error) {
    journeyFailure(result, error, telemetry);
  } finally {
    await cleanupStep(result, attempt.mutationAttempted,
      cleanupSignal => (replyJourney ? cleanupReply : cleanup)(context.teamsBot!, attempt, cleanupSignal), telemetry, now);
  }
  return finishJourney(result, startedAt, now);
};

export const teamsProbe = channelProbe(false);
export const teamsReplyProbe = channelProbe(true);
