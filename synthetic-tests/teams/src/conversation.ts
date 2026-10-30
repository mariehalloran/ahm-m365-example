import { categoryOf, IntegrationError } from "../../utils/src/integrations/http.js";
import { baseResult, type ProbeHandler } from "../../utils/src/execution/probes.js";
import {
  cleanupStep,
  finishJourney,
  journeyFailure,
  measureStep,
} from "../../utils/src/execution/steps.js";
import {
  authenticate,
  cleanupReply,
  confirmPublication,
  confirmReply,
  postMessage,
  postReply,
  type ChannelReplyAttempt,
} from "./steps.js";

export const teamsConversationProbe: ProbeHandler<"teams-channel-message"> = async (probe, context) => {
  const { config, signal, telemetry, now = Date.now } = context;
  const startedAt = now();
  const deadline = startedAt + config.PROBE_TIMEOUT_MS;
  const executionSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(config.PROBE_TIMEOUT_MS),
  ]);
  const result = baseResult(probe, startedAt);
  const attempt: ChannelReplyAttempt = {
    serviceUrl: probe.serviceUrl,
    tenantId: probe.tenantId,
    teamId: probe.teamId,
    channelId: probe.channelId,
    marker: `AHM synthetic ${result.correlationId}`,
    replyMarker: `AHM synthetic reply ${result.correlationId}`,
    mutationAttempted: false,
    replyMutationAttempted: false,
  };
  const classify = (error: unknown) => {
    if (signal.aborted) return "cancelled";
    if (executionSignal.aborted) return "delivery-timeout";
    const category = categoryOf(error);
    return category === "graph-unavailable"
      ? result.diagnosticContext.testStage === "send"
        ? "send-failure"
        : "read-failure"
      : category;
  };
  try {
    result.diagnosticContext.testStage = "authentication";
    const { graph, bot } = await measureStep(
      result,
      "authenticate",
      async () => {
        const authenticated = await authenticate(
          context.graph,
          context.teamsBot,
          attempt,
          executionSignal,
        );
        if (now() >= deadline) throw new IntegrationError("delivery-timeout");
        return authenticated;
      },
      now,
      classify,
    );
    result.diagnosticContext.authenticationDurationMs = Math.max(
      0,
      now() - startedAt,
    );
    result.diagnosticContext.testStage = "send";
    const sentAt = now();
    try {
      await measureStep(
        result,
        "post-message",
        () => postMessage(bot, attempt, executionSignal),
        now,
        classify,
      );
    } finally {
      if (attempt.mutationAttempted)
        result.sendDurationMs = Math.max(0, now() - sentAt);
    }
    result.diagnosticContext.testStage = "poll";
    await measureStep(
      result,
      "confirm-publication",
      () =>
        confirmPublication(
          graph,
          bot.applicationId,
          attempt,
          executionSignal,
          deadline,
          config.POLL_INTERVAL_MS,
          now,
          context.sleep,
        ),
      now,
      classify,
    );
    const publicationDurationMs = Math.max(0, now() - sentAt);
    result.diagnosticContext.testStage = "reply";
    await measureStep(
      result,
      "post-reply",
      () => postReply(bot, attempt, executionSignal),
      now,
      classify,
    );
    result.diagnosticContext.testStage = "poll";
    await measureStep(
      result,
      "confirm-reply",
      () =>
        confirmReply(
          graph,
          bot.applicationId,
          attempt,
          executionSignal,
          deadline,
          config.POLL_INTERVAL_MS,
          now,
          context.sleep,
        ),
      now,
      classify,
    );
    telemetry.emit("teams-channel-roundtrip-observed", {
      testId: result.testId,
      correlationId: result.correlationId,
      evidence: "persisted-bot-root-and-reply",
    });
    result.publicationDurationMs = publicationDurationMs;
    result.success = true;
    result.diagnosticContext.testStage = "complete";
  } catch (error) {
    journeyFailure(result, error, telemetry);
  } finally {
    await cleanupStep(
      result,
      attempt.mutationAttempted,
      (cleanupSignal) =>
        cleanupReply(context.teamsBot!, attempt, cleanupSignal),
      telemetry,
      now,
      config.TEAMS_CLEANUP_ENABLED !== "false",
    );
  }
  return finishJourney(result, startedAt, now);
};
