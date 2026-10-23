import { baseResult, type ProbeHandler } from "../../utils/src/probes.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../../utils/src/steps.js";
import { categoryOf, IntegrationError } from "../../utils/src/http.js";
import { callIdSchema, leaveCall, waitBeforeHangup } from "./call-steps.js";
import { z } from "zod";

export const teamsCallProbe: ProbeHandler = async (probe, context) => {
  const { config, signal, telemetry, teamsCalling: graph, now = Date.now } = context;
  const startedAt = now();
  const deadline = startedAt + config.PROBE_TIMEOUT_MS;
  const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(config.PROBE_TIMEOUT_MS)]);
  const result = baseResult(probe, startedAt);
  let id: string | undefined;
  let mutationAttempted = false;
  let disconnected = false;
  let phase: "wait" | "end" | "cleanup" = "wait";
  let lastStateDiagnostic = "";
  let stateDiagnostics = 0;
  const onState = (state: string, resultCode?: number, resultSubcode?: number) => {
    const key = `${phase}:${state}:${resultCode}:${resultSubcode}`;
    if (key === lastStateDiagnostic || stateDiagnostics >= 12) return;
    lastStateDiagnostic = key;
    stateDiagnostics++;
    telemetry.emit("teams-call-state-observed", {
      testId: result.testId, correlationId: result.correlationId,
      state, phase, elapsedMs: Math.max(0, now() - startedAt),
      ...(resultCode !== undefined ? { resultCode } : {}),
      ...(resultSubcode !== undefined ? { resultSubcode } : {}),
    });
  };
  const classify = (error: unknown) => signal.aborted ? "cancelled"
    : executionSignal.aborted ? "delivery-timeout" : categoryOf(error);
  try {
    result.diagnosticContext.testStage = "authentication";
    await measureStep(result, "authenticate", async () => {
      if (!graph || !probe.tenantId || !probe.callUserId ||
          !config.TEAMS_CALLING_CALLBACK_URL) throw new IntegrationError("configuration-failure");
      await graph.authenticate(executionSignal);
    }, now, classify);
    result.diagnosticContext.testStage = "send";
    await measureStep(result, "place-call", async () => {
      executionSignal.throwIfAborted();
      mutationAttempted = true;
      const created = await graph!.json("/communications/calls", z.object({ id: callIdSchema }), executionSignal, "POST", {
        "@odata.type": "#microsoft.graph.call",
        callbackUri: config.TEAMS_CALLING_CALLBACK_URL,
        requestedModalities: ["audio"],
        mediaConfig: { "@odata.type": "#microsoft.graph.serviceHostedMediaConfig" },
        targets: [{ identity: { user: { id: probe.callUserId } } }],
        tenantId: probe.tenantId,
      }, false);
      id = created.id;
    }, now, classify);
    result.diagnosticContext.testStage = "poll";
    await measureStep(result, "wait-before-hangup", async () => {
      const waitUntil = now() + (config.TEAMS_CALLING_WAIT_SECONDS ?? 10) * 1000;
      if (waitUntil >= deadline) throw new IntegrationError("delivery-timeout");
      await waitBeforeHangup(graph!, id!, executionSignal, waitUntil,
        Math.min(config.POLL_INTERVAL_MS, 250), now, context.sleep, onState);
    }, now, classify);
    result.success = true;
  } catch (error) {
    journeyFailure(result, error, telemetry);
    if (mutationAttempted && !id) telemetry.emit("teams-call-unknown-creation-outcome", {
      testId: result.testId, correlationId: result.correlationId, category: result.diagnosticCategory,
    });
  } finally {
    // Leaving a call is never governed by the message-retention setting.
    const teardownDeadline = now() + 9000;
    const teardownSignal = AbortSignal.timeout(10000);
    try {
      if (id && graph) {
        phase = "end";
        const ownedId = id;
        const calling = graph;
        try {
          await measureStep(result, "end-call", async () => {
            await leaveCall(calling, ownedId, AbortSignal.any([teardownSignal, AbortSignal.timeout(4000)]),
              Math.min(teardownDeadline, now() + 3500), Math.min(config.POLL_INTERVAL_MS, 250), now, context.sleep, onState);
            disconnected = true;
            telemetry.emit("teams-call-disconnected", { testId: result.testId, correlationId: result.correlationId, phase: "business" });
          }, now);
        } catch (error) { journeyFailure(result, error, telemetry); }
      }
    } finally {
      phase = "cleanup";
      await cleanupStep(result, mutationAttempted && !disconnected, async cleanupSignal => {
        if (!graph || !id) throw new IntegrationError("cleanup-failure");
        await leaveCall(graph, id, AbortSignal.any([cleanupSignal, teardownSignal]), teardownDeadline,
          Math.min(config.POLL_INTERVAL_MS, 250), now, context.sleep, onState);
        telemetry.emit("teams-call-disconnected", { testId: result.testId, correlationId: result.correlationId, phase: "cleanup" });
      }, telemetry, now);
    }
  }
  if (result.success) result.diagnosticContext.testStage = "complete";
  return finishJourney(result, startedAt, now);
};
