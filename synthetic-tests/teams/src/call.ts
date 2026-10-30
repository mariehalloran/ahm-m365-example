import { baseResult, type ProbeHandler } from "../../utils/src/probes.js";
import {
  cleanupStep,
  finishJourney,
  journeyFailure,
  measureStep,
} from "../../utils/src/steps.js";
import { categoryOf, IntegrationError } from "../../utils/src/http.js";
import {
  callIdSchema,
  leaveCall,
  verifyCallEstablished,
  verifyMeetingMetadata,
  verifyParticipants,
  waitForAnswer,
} from "./call-steps.js";
import { teamsCallingCallbackUrlSchema } from "../../utils/src/config.js";
import type { GraphOperations } from "../../utils/src/graph.js";
import { z } from "zod";

export interface ConnectedTeamsCall {
  primary: { graph: GraphOperations; id: string };
  peer: { graph: GraphOperations; id: string };
  signal: AbortSignal;
  deadline: number;
  verifyConnected: (signal: AbortSignal) => Promise<void>;
}
export type TeamsCallConnectedHook = (
  call: ConnectedTeamsCall,
) => Promise<void>;

export const createTeamsCallProbe =
  (onConnected?: TeamsCallConnectedHook): ProbeHandler<"teams-call"> =>
  async (probe, context) => {
    const { config, signal, telemetry, now = Date.now } = context;
    const startedAt = now();
    const deadline = startedAt + config.PROBE_TIMEOUT_MS;
    const executionSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(config.PROBE_TIMEOUT_MS),
    ]);
    const result = baseResult(probe, startedAt);
    result.call = { resultCodes: [] };
    const legs: {
      name: "primary" | "peer";
      graph: GraphOperations | undefined;
      id?: string;
      established: boolean;
      disconnected: boolean;
    }[] = [
      {
        name: "primary",
        graph: context.teamsCalling,
        established: false,
        disconnected: false,
      },
      {
        name: "peer",
        graph: context.teamsCallingPeer,
        established: false,
        disconnected: false,
      },
    ];
    let mutationAttempted = false;
    let unknownCreation = false;
    let phase = "join";
    let stateDiagnostics = 0;
    const onState =
      (leg: (typeof legs)[number]) =>
      (
        state: string,
        resultCode?: number,
        resultSubcode?: number,
        callChainId?: string,
      ) => {
        const field =
          leg.name === "primary" ? "callChainId" : "peerCallChainId";
        // A provisional join chain can become the conference chain during establishment.
        // Teardown metadata must not replace that record or prevent verified departure.
        if (callChainId && (state === "established" || !leg.established)) {
          callChainId = callChainId.toLowerCase();
          const previousCallChainId = result.call![field];
          result.call![field] = callChainId;
          if (
            previousCallChainId &&
            previousCallChainId !== callChainId &&
            stateDiagnostics < 24
          ) {
            telemetry.emit("teams-call-chain-changed", {
              testId: result.testId,
              correlationId: result.correlationId,
              leg: leg.name,
              phase,
              state,
              previousCallChainId,
              callChainId,
            });
          }
        }
        if (state === "established") leg.established = true;
        if (
          resultCode !== undefined &&
          !result.call!.resultCodes.includes(resultCode) &&
          result.call!.resultCodes.length < 12
        ) {
          result.call!.resultCodes.push(resultCode);
        }
        if (stateDiagnostics++ < 24)
          telemetry.emit("teams-call-state-observed", {
            testId: result.testId,
            correlationId: result.correlationId,
            leg: leg.name,
            state,
            phase,
            elapsedMs: Math.max(0, now() - startedAt),
            ...(resultCode !== undefined ? { resultCode } : {}),
            ...(resultSubcode !== undefined ? { resultSubcode } : {}),
          });
      };
    const classify = (error: unknown) =>
      signal.aborted
        ? "cancelled"
        : executionSignal.aborted || categoryOf(error) === "cancelled"
          ? "delivery-timeout"
          : categoryOf(error);
    const interval = Math.min(config.POLL_INTERVAL_MS, 250);
    const settleBoth = async (operations: Promise<unknown>[]) => {
      const settled = await Promise.allSettled(operations);
      const failure = settled.find((item) => item.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    };
    try {
      result.diagnosticContext.testStage = "authentication";
      await measureStep(
        result,
        "authenticate",
        async () => {
          if (
            legs.some((leg) => !leg.graph) ||
            legs[0]!.graph === legs[1]!.graph ||
            "callUserId" in probe ||
            probe.botClientId.toLowerCase() === probe.peerBotClientId.toLowerCase() ||
            !teamsCallingCallbackUrlSchema.safeParse(
              config.TEAMS_CALLING_CALLBACK_URL,
            ).success ||
            !config.TEAMS_CALLING_ANSWER_TIMEOUT_SECONDS
          ) {
            throw new IntegrationError("configuration-failure");
          }
          await settleBoth(
            legs.map((leg) => leg.graph!.authenticate(executionSignal)),
          );
        },
        now,
        classify,
      );
      result.diagnosticContext.testStage = "send";
      await measureStep(
        result,
        "place-call",
        async () => {
          for (const leg of legs) {
            executionSignal.throwIfAborted();
            mutationAttempted = true;
            unknownCreation = true;
            // Graph Create call, example 5: join scheduled meeting with service-hosted media.
            const created = await leg.graph!.json(
              "/communications/calls",
              z.object({
                id: callIdSchema,
                callChainId: z.unknown().optional(),
              }),
              executionSignal,
              "POST",
              {
                "@odata.type": "#microsoft.graph.call",
                callbackUri: config.TEAMS_CALLING_CALLBACK_URL,
                requestedModalities: ["audio"],
                mediaConfig: {
                  "@odata.type": "#microsoft.graph.serviceHostedMediaConfig",
                },
                chatInfo: { threadId: probe.meetingThreadId, messageId: "0" },
                meetingInfo: {
                  "@odata.type": "#microsoft.graph.organizerMeetingInfo",
                  organizer: {
                    user: {
                      id: probe.organizerUserId,
                      tenantId: probe.tenantId,
                    },
                  },
                  allowConversationWithoutHost: true,
                },
                tenantId: probe.tenantId,
              },
              false,
              "v1.0",
              16384,
            );
            leg.id = created.id;
            unknownCreation = false;
            telemetry.emit("teams-call-created", {
              testId: result.testId,
              correlationId: result.correlationId,
              leg: leg.name,
              ownedCallId: leg.id,
            });
            const chain = z
              .string()
              .uuid()
              .nullish()
              .safeParse(created.callChainId);
            if (!chain.success)
              throw new IntegrationError("malformed-response");
            onState(leg)(
              "establishing",
              undefined,
              undefined,
              chain.data ?? undefined,
            );
            if (leg.name === "peer" && leg.id === legs[0]!.id)
              throw new IntegrationError("read-failure");
          }
        },
        now,
        classify,
      );
      result.diagnosticContext.testStage = "poll";
      const joinDeadline = Math.min(
        now() + config.TEAMS_CALLING_ANSWER_TIMEOUT_SECONDS! * 1000,
        deadline - 1000,
      );
      await measureStep(
        result,
        "wait-for-answer",
        async () => {
          if (joinDeadline <= now())
            throw new IntegrationError("delivery-timeout");
          await settleBoth(
            legs.map((leg) =>
              waitForAnswer(
                leg.graph!,
                leg.id!,
                executionSignal,
                joinDeadline,
                interval,
                now,
                context.sleep,
                onState(leg),
              ),
            ),
          );
        },
        now,
        classify,
      );
      await measureStep(
        result,
        "verify-meeting-metadata",
        async () => {
          await settleBoth(
            legs.map((leg) =>
              verifyMeetingMetadata(
                leg.graph!,
                leg.id!,
                {
                  threadId: probe.meetingThreadId,
                  organizerUserId: probe.organizerUserId,
                  tenantId: probe.tenantId,
                },
                executionSignal,
              ),
            ),
          );
        },
        now,
        classify,
      );
      phase = "roster";
      await measureStep(
        result,
        "verify-participants",
        async () => {
          if (
            result.call!.callChainId &&
            result.call!.peerCallChainId &&
            result.call!.callChainId !== result.call!.peerCallChainId
          )
            throw new IntegrationError("read-failure");
          await settleBoth(
            legs.map(async (leg) => {
              await verifyParticipants(
                leg.graph!,
                leg.id!,
                [probe.botClientId, probe.peerBotClientId],
                executionSignal,
                joinDeadline,
                interval,
                now,
                context.sleep,
              );
              await waitForAnswer(
                leg.graph!,
                leg.id!,
                executionSignal,
                joinDeadline,
                interval,
                now,
                context.sleep,
                onState(leg),
              );
            }),
          );
        },
        now,
        classify,
      );
      if (onConnected) {
        phase = "pilot";
        await onConnected({
          primary: { graph: legs[0]!.graph!, id: legs[0]!.id! },
          peer: { graph: legs[1]!.graph!, id: legs[1]!.id! },
          signal: executionSignal,
          deadline,
          verifyConnected: (signal) =>
            settleBoth(
              legs.map((leg) =>
                verifyCallEstablished(
                  leg.graph!,
                  leg.id!,
                  AbortSignal.any([executionSignal, signal]),
                  onState(leg),
                ),
              ),
            ),
        });
        executionSignal.throwIfAborted();
      }
      result.success = true;
    } catch (error) {
      if (
        unknownCreation &&
        error instanceof IntegrationError &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      )
        unknownCreation = false;
      journeyFailure(result, error, telemetry);
      if (unknownCreation)
        telemetry.emit("teams-call-unknown-creation-outcome", {
          testId: result.testId,
          correlationId: result.correlationId,
          category: result.diagnosticCategory,
        });
    } finally {
      const disconnect = async (budgetMs: number) => {
        const attempts = await Promise.allSettled(
          legs
            .filter((leg) => leg.id && !leg.disconnected)
            .map(async (leg) => {
              await leaveCall(
                leg.graph!,
                leg.id!,
                AbortSignal.timeout(budgetMs),
                now() + budgetMs - 100,
                interval,
                now,
                context.sleep,
                onState(leg),
              );
              leg.disconnected = true;
              telemetry.emit("teams-call-disconnected", {
                testId: result.testId,
                correlationId: result.correlationId,
                phase,
                leg: leg.name,
                ownedCallId: leg.id,
              });
            }),
        );
        if (legs.every((leg) => leg.id && leg.disconnected))
          result.call!.endedAt = new Date(now()).toISOString();
        const failed = attempts.find(
          (attempt) => attempt.status === "rejected",
        );
        if (failed?.status === "rejected") throw failed.reason;
      };
      // Both owned legs get independent bounded teardown, even after cancellation or a failed peer join.
      if (legs.some((leg) => leg.id)) {
        phase = "end";
        try {
          await measureStep(result, "end-call", () => disconnect(4000), now);
        } catch (error) {
          journeyFailure(result, error, telemetry);
        }
      }
      phase = "cleanup";
      await cleanupStep(
        result,
        mutationAttempted &&
          (unknownCreation || legs.some((leg) => leg.id && !leg.disconnected)),
        async () => {
          await disconnect(5000);
          if (unknownCreation) throw new IntegrationError("cleanup-failure");
        },
        telemetry,
        now,
      );
    }
    if (result.success) result.diagnosticContext.testStage = "complete";
    return finishJourney(result, startedAt, now);
  };

export const teamsCallProbe = createTeamsCallProbe();
