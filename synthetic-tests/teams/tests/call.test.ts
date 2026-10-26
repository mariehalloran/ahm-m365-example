import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../../utils/src/graph.js";
import { AuthenticatedHttp } from "../../utils/src/http.js";
import { resultSchema, reportedResult, type Probe } from "../../utils/src/contracts.js";
import { TeamsCallOperations } from "../../utils/src/teams-call-operations.js";
import { teamsCallProbe } from "../src/call.js";
import { simulate } from "../../utils/src/probes.js";

const probe: Probe = {
  id: "teams-test-call", type: "teams-call", cohort: "teams-global",
  tenantId: "11111111-1111-4111-8111-111111111111",
  meetingThreadId: "19:meeting_test@thread.v2",
  organizerUserId: "22222222-2222-4222-8222-222222222222",
  peerBotClientId: "55555555-5555-4555-8555-555555555555",
};
const primaryClientId = "66666666-6666-4666-8666-666666666666";
const chainId = "77777777-7777-4777-8777-777777777777";
const operationId = "33333333-3333-4333-8333-333333333333";
function fixture(options: {
  uncertainCreate?: boolean; earlyTermination?: boolean; deleteFailure?: boolean; terminateFailure?: boolean;
  abortOnRead?: boolean; unanswered?: boolean; failFirstDelete?: boolean; acceptedOnly?: boolean;
  failedPlayback?: boolean; wrongCall?: boolean; wrongOperation?: boolean; wrongContext?: boolean;
  delayedCompletion?: boolean; terminateDuringPlayback?: boolean; completedResponseOnly?: boolean;
  peerCreateFailure?: boolean; peerUnanswered?: boolean; peerDeleteFailure?: boolean;
  missingRoster?: boolean; wrongRoster?: boolean; emptyPeerRoster?: boolean; lobbyPeer?: boolean;
  duplicateCallId?: boolean; mismatchedChains?: boolean; peerRosterFailure?: boolean;
  primaryCreateForbidden?: boolean; peerCreateUncertain?: boolean; abortAfterPrimaryCreate?: boolean;
  failedAuthentication?: "primary" | "peer"; missingPlayback?: "primary" | "peer"; wrongAudience?: boolean;
  wrongMeeting?: "thread" | "organizer" | "tenant" | "organizer-tenant"; primaryDeleteFailure?: boolean;
} = {}) {
  let clock = 0, playing = false;
  const deletedCalls = new Set<string>();
  let deleteAttempts = 0;
  const pendingNotifications = new Map<string, () => void>();
  const controller = new AbortController();
  const operations = new TeamsCallOperations(() => clock);
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const peer = new Headers(init?.headers).get("authorization") === "Bearer fake-peer-token";
    const id = peer && !options.duplicateCallId ? "peer-call" : "owned-call";
    const deleted = deletedCalls.has(id);
    if (path.endsWith("/participants")) {
      if (peer && options.peerRosterFailure) return new Response(null, { status: 403 });
      return Response.json({ value: options.missingRoster || (peer && options.emptyPeerRoster) ? [] : [
        { id: "participant-primary", isInLobby: false, info: { identity: { application: { id: primaryClientId } } } },
        { id: "participant-peer", isInLobby: options.lobbyPeer ?? false, info: { identity: {
          application: { id: options.wrongRoster ? operationId : probe.peerBotClientId },
        } } },
      ] });
    }
    if (init?.method === "POST" && path.endsWith("/playPrompt")) {
      playing = true;
      const body = JSON.parse(String(init.body)) as { clientContext: string };
      // Each leg gets its own notify keyed by its own clientContext; a single shared callback would
      // let the second leg's POST silently overwrite the first leg's pending completion.
      const notify = () => {
        // Use this leg's own call id (owned-call or peer-call); a wrong/hardcoded id here would make
        // the peer leg's accept() correlation silently miss (entry.callId mismatch) and time out.
        const resource = `/communications/calls/${options.wrongCall ? "other-call" : id}/operations/${options.wrongOperation ? "other-operation" : operationId}`;
        const botClientId = peer ? probe.peerBotClientId! : primaryClientId;
        const otherBotClientId = peer ? primaryClientId : probe.peerBotClientId!;
        operations.accept({ value: [{
          changeType: "deleted", resourceUrl: resource,
          resourceData: {
            "@odata.type": "#microsoft.graph.playPromptOperation", "@odata.id": resource,
            clientContext: options.wrongContext ? "44444444-4444-4444-8444-444444444444" : body.clientContext,
            status: options.failedPlayback ? "failed" : "completed",
            resultInfo: { code: options.failedPlayback ? 500 : 200 },
          },
        }] }, { botClientId: options.wrongAudience ? otherBotClientId : botClientId });
      };
      pendingNotifications.set(body.clientContext, notify);
      if (!options.acceptedOnly && !options.delayedCompletion && !options.completedResponseOnly &&
          options.missingPlayback !== (peer ? "peer" : "primary")) notify();
      return Response.json({
        "@odata.type": "#microsoft.graph.playPromptOperation", id: operationId,
        status: options.completedResponseOnly ? "completed" : "running", clientContext: body.clientContext, resultInfo: null,
      });
    }
    expect(path).toMatch(/^\/v1\.0\/communications\/calls(?:\/(?:owned-call|peer-call))?$/);
    if (init?.method === "POST") {
      if (options.uncertainCreate) throw new Error("ambiguous network outcome");
      if (!peer && options.primaryCreateForbidden) return Response.json({
        error: { code: "7504", message: "Insufficient enterprise application permissions." },
      }, { status: 403 });
      if (peer && options.peerCreateUncertain) throw new Error("ambiguous peer network outcome");
      if (peer && options.peerCreateFailure) return new Response(null, { status: 403 });
      return Response.json({
        id: peer && options.duplicateCallId ? "owned-call" : id,
        state: "establishing", callChainId: peer && options.mismatchedChains ? operationId : chainId,
      }, { status: 201 });
    }
    if (init?.method === "DELETE") {
      deleteAttempts++;
      expect(init.signal?.aborted).toBe(false);
      if (options.deleteFailure || (peer && options.peerDeleteFailure) || (!peer && options.primaryDeleteFailure) ||
          (options.failFirstDelete && deleteAttempts === 1)) return new Response(null, { status: 403 });
      deletedCalls.add(id);
      return new Response(null, { status: 204 });
    }
    if (options.abortOnRead && !deleted) controller.abort();
    return Response.json({
      id,
      state: deleted ? options.terminateFailure ? "established" : "terminated"
        : options.earlyTermination || (playing && options.terminateDuringPlayback) ? "terminated"
        : options.unanswered || (peer && options.peerUnanswered) ? "establishing" : "established",
      chatInfo: { threadId: options.wrongMeeting === "thread" ? "19:meeting_foreign@thread.v2" : probe.meetingThreadId },
      meetingInfo: {
        "@odata.type": "#microsoft.graph.organizerMeetingInfo",
        organizer: { user: {
          id: options.wrongMeeting === "organizer" ? operationId : probe.organizerUserId,
          tenantId: options.wrongMeeting === "organizer-tenant" ? operationId : probe.tenantId,
        } },
      },
      tenantId: options.wrongMeeting === "tenant" ? operationId : probe.tenantId,
    });
  });
  const graph = new GraphClient(new AuthenticatedHttp({
    getToken: async () => {
      if (options.failedAuthentication === "primary") throw new Error("primary managed identity token unavailable");
      return { token: "fake-bot-token", expiresOnTimestamp: Date.now() + 60000 };
    },
  }, "https://graph.microsoft.com/.default", { fetch: fetcher, attempts: 1 }));
  const peerGraph = new GraphClient(new AuthenticatedHttp({
    getToken: async () => {
      if (options.failedAuthentication === "peer") throw new Error("peer managed identity token unavailable");
      return { token: "fake-peer-token", expiresOnTimestamp: Date.now() + 60000 };
    },
  }, "https://graph.microsoft.com/.default", { fetch: fetcher, attempts: 1 }));
  const context = {
    config: {
      SYNTHETIC_SCENARIO: "healthy" as const, PROBE_TIMEOUT_MS: 45000, POLL_INTERVAL_MS: 250,
      TEAMS_CALLING_PLAYBACK_ENABLED: "true" as const,
      TEAMS_CALLING_ANSWER_TIMEOUT_SECONDS: 20, TEAMS_CALLING_PLAYBACK_TIMEOUT_SECONDS: 10,
      BOT_CLIENT_ID: primaryClientId, TEAMS_CALLING_PEER_CLIENT_ID: probe.peerBotClientId!,
      TEAMS_CLEANUP_ENABLED: "false" as const, TEAMS_CALLING_CALLBACK_URL: "https://approved.example.invalid/api/calls",
    },
    teamsCalling: graph, teamsCallingPeer: peerGraph, teamsCallOperations: operations, signal: controller.signal,
    telemetry: { emit: vi.fn((event: string) => {
      if (options.abortAfterPrimaryCreate && event === "teams-call-created") controller.abort();
    }) },
    now: () => clock, sleep: async (ms: number) => {
      clock += ms;
      if (options.delayedCompletion) for (const notify of pendingNotifications.values()) notify();
    },
  };
  return { context, fetcher };
}

describe("answered service-hosted audio playback and verified disconnection", () => {
  it.each(["primary", "peer"] as const)("requires real %s authentication before attempting either meeting mutation", async leg => {
    const { context, fetcher } = fixture({ failedAuthentication: leg });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("authentication-failure");
    expect(result.steps.find(step => step.name === "place-call")?.status).toBe("skipped");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports a primary 403 as unhealthy permission evidence without retrying, aliasing scope or inventing a call", async () => {
    const { context, fetcher } = fixture({ primaryCreateForbidden: true });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("permission-failure");
    expect(result.diagnosticContext.httpStatus).toBe(403);
    expect(result.steps.find(step => step.name === "place-call")?.status).toBe("failed");
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("skipped");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(context.telemetry.emit).not.toHaveBeenCalledWith("teams-call-created", expect.anything());
  });
  it("keeps an ambiguous peer join unresolved while independently deleting and verifying the known primary", async () => {
    const { context, fetcher } = fixture({ peerCreateUncertain: true });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(false);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => String(url))).toEqual([
      "https://graph.microsoft.com/v1.0/communications/calls/owned-call",
    ]);
    expect(context.telemetry.emit).toHaveBeenCalledWith("teams-call-unknown-creation-outcome", expect.anything());
  });
  it("persists the primary's owned ID before diagnostics/cancellation and tears it down on a fresh signal", async () => {
    const { context, fetcher } = fixture({ abortAfterPrimaryCreate: true });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("cancelled");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "DELETE", "GET"]);
    expect(context.telemetry.emit).toHaveBeenCalledWith("teams-call-created", expect.objectContaining({
      leg: "primary", ownedCallId: "owned-call",
    }));
    expect(context.telemetry.emit).toHaveBeenCalledWith("teams-call-disconnected", expect.objectContaining({
      leg: "primary", ownedCallId: "owned-call",
    }));
  });
  it.each(["thread", "organizer", "tenant", "organizer-tenant"] as const)(
    "never substitutes wrong %s metadata for evidence of the dedicated meeting, and still ends both calls", async field => {
      const { context, fetcher } = fixture({ wrongMeeting: field });
      const result = resultSchema.parse(await teamsCallProbe(probe, context));
      expect(result.success).toBe(false);
      expect(result.steps.find(step => step.name === "verify-meeting-metadata")?.status).toBe("failed");
      expect(result.steps.find(step => step.name === "verify-participants")?.status).toBe("skipped");
      expect(result.steps.find(step => step.name === "play-audio")?.status).toBe("skipped");
      expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
      expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
    },
  );
  it.each(["primary", "peer"] as const)("does not call playback complete when only the other leg completes (%s missing)", async leg => {
    const { context, fetcher } = fixture({ missingPlayback: leg });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(false);
    expect(result.steps.find(step => step.name === "play-audio")).toMatchObject({
      status: "failed", diagnosticCategory: "delivery-timeout",
    });
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
  });
  it("rejects otherwise correlated playback callbacks authenticated for the other bot's leg", async () => {
    const { context } = fixture({ wrongAudience: true });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(false);
    expect(result.steps.find(step => step.name === "play-audio")).toMatchObject({
      status: "failed", diagnosticCategory: "delivery-timeout",
    });
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
  });
  it.each(["missingRoster", "wrongRoster", "emptyPeerRoster", "lobbyPeer", "peerRosterFailure"] as const)(
    "never plays with %s; both independently owned calls are disconnected", async failure => {
      const { context, fetcher } = fixture({ [failure]: true });
      const result = resultSchema.parse(await teamsCallProbe(probe, context));
      expect(result.success).toBe(false);
      expect(result.steps.find(step => step.name === "verify-participants")?.status).toBe("failed");
      expect(result.steps.find(step => step.name === "play-audio")?.status).toBe("skipped");
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) =>
        new URL(String(url)).pathname)).toEqual([
        "/v1.0/communications/calls/owned-call", "/v1.0/communications/calls/peer-call",
      ]);
      expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    },
  );
  it.each(["peerCreateFailure", "peerUnanswered", "duplicateCallId", "mismatchedChains"] as const)(
    "fails %s without orphaning the primary or starting playback", async failure => {
      const { context, fetcher } = fixture({ [failure]: true });
      const result = resultSchema.parse(await teamsCallProbe(probe, context));
      expect(result.success).toBe(false);
      expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/owned-call") && init?.method === "DELETE")).toBe(true);
      expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/playPrompt"))).toBe(false);
      expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    },
  );
  it("retains both chain identifiers without creating per-leg/participant metric inventories", async () => {
    const { context } = fixture();
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.call).toEqual({
      callChainId: chainId, peerCallChainId: chainId, endedAt: new Date(0).toISOString(), resultCodes: [],
    });
    expect(JSON.stringify(reportedResult(result))).not.toContain(primaryClientId);
    expect(JSON.stringify(reportedResult(result))).not.toContain(probe.organizerUserId);
  });
  it("retries only the failed peer teardown, never allowing its failure to prevent primary teardown", async () => {
    const { context, fetcher } = fixture({ peerDeleteFailure: true });
    const result = await teamsCallProbe(probe, context);
    expect(result.success).toBe(false);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    const deletes = fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes.map(([url]) => String(url).split("/").at(-1))).toEqual(["owned-call", "peer-call", "peer-call"]);
  });
  it("still verifies peer termination independently when primary teardown fails twice", async () => {
    const { context, fetcher } = fixture({ primaryDeleteFailure: true });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(false);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")
      .map(([url]) => String(url).split("/").at(-1))).toEqual(["owned-call", "peer-call", "owned-call"]);
    expect(context.telemetry.emit).toHaveBeenCalledWith("teams-call-disconnected", expect.objectContaining({ leg: "peer" }));
  });
  it.each(["missing", "primary", "different"] as const)("requires the exact distinct peer selection: %s", async selection => {
    const { context, fetcher } = fixture();
    const config = { ...context.config, TEAMS_CALLING_PEER_CLIENT_ID:
      selection === "missing" ? undefined : selection === "primary" ? primaryClientId : operationId };
    const result = await teamsCallProbe(probe, { ...context, config });
    expect(result.diagnosticCategory).toBe("configuration-failure");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("joins both legs with matching organizer/top-level tenants, completes playback and leaves despite message retention", async () => {
    const { context, fetcher } = fixture({ delayedCompletion: true });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(true);
    expect(reportedResult(result).steps.map(step => step.name)).toEqual(["place-call", "wait-for-answer", "verify-meeting-metadata", "verify-participants", "play-audio", "end-call"]);
    expect(result.durationMs).toBe(250);
    expect(result.sendDurationMs).toBeUndefined();
    expect(result.publicationDurationMs).toBeUndefined();
    // 2 joins (one per leg) + 2 playback POSTs (both legs independently play the tone).
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(4);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
    expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe("GET");
    const joins = fetcher.mock.calls.filter(([input, init]) =>
      init?.method === "POST" && new URL(String(input)).pathname === "/v1.0/communications/calls");
    expect(joins).toHaveLength(2);
    for (const [, init] of joins) {
      expect(JSON.parse(String(init?.body))).toEqual({
        "@odata.type": "#microsoft.graph.call",
        callbackUri: context.config.TEAMS_CALLING_CALLBACK_URL, requestedModalities: ["audio"],
        mediaConfig: { "@odata.type": "#microsoft.graph.serviceHostedMediaConfig" },
        chatInfo: { threadId: probe.meetingThreadId, messageId: "0" },
        meetingInfo: { "@odata.type": "#microsoft.graph.organizerMeetingInfo",
          organizer: { user: { id: probe.organizerUserId, tenantId: probe.tenantId } }, allowConversationWithoutHost: true },
        tenantId: probe.tenantId,
      });
    }
    const playback = fetcher.mock.calls.find(([input]) => String(input).endsWith("/playPrompt"))!;
    expect(JSON.parse(String(playback[1]?.body))).toMatchObject({
      clientContext: result.correlationId,
      prompts: [{ "@odata.type": "#microsoft.graph.mediaPrompt", mediaInfo: {
        uri: "https://approved.example.invalid/media/test-tone.wav",
        resourceId: "c32d752e-a721-4bb0-941c-6b1a59bd7949",
      } }],
    });
    expect(context.telemetry.emit).toHaveBeenCalledWith("teams-call-playback-observed",
      expect.objectContaining({ operationId, correlationId: result.correlationId, status: "completed" }));
  });
  it.each(["earlyTermination", "abortOnRead", "unanswered"] as const)(
    "fails %s without playback but independently verifies hang-up", async failure => {
      const { context, fetcher } = fixture({ [failure]: true });
      const result = resultSchema.parse(await teamsCallProbe(probe, context));
      expect(result.success).toBe(false);
      expect(result.steps.find(step => step.name === "wait-for-answer")?.status).toBe("failed");
      expect(result.steps.find(step => step.name === "play-audio")?.status).toBe("skipped");
      expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
      expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
      expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/playPrompt"))).toBe(false);
      if (failure === "unanswered") {
        expect(result.diagnosticCategory).toBe("delivery-timeout");
        expect(result.durationMs).toBeGreaterThanOrEqual(20000);
      }
    },
  );
  it.each(["acceptedOnly", "completedResponseOnly", "wrongCall", "wrongOperation", "wrongContext"] as const)(
    "never turns %s into completed playback", async failure => {
      const { context } = fixture({ [failure]: true });
      const result = resultSchema.parse(await teamsCallProbe(probe, context));
      expect(result.success).toBe(false);
      expect(result.diagnosticCategory).toBe("delivery-timeout");
      expect(result.steps.find(step => step.name === "play-audio")).toMatchObject({ status: "failed", durationMs: 10000 });
      expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
    },
  );
  it.each(["failedPlayback", "terminateDuringPlayback"] as const)("fails %s and still hangs up", async failure => {
    const { context } = fixture({ [failure]: true });
    const result = await teamsCallProbe(probe, context);
    expect(result.success).toBe(false);
    expect(result.steps.find(step => step.name === "play-audio")).toMatchObject({ status: "failed", diagnosticCategory: "read-failure" });
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
  });
  it("handles a real completion callback racing ahead of the POST response", async () => {
    const { context } = fixture();
    expect((await teamsCallProbe(probe, context)).success).toBe(true);
  });
  it.each(["deleteFailure", "terminateFailure"] as const)("bounds cleanup after %s", async failure => {
    const { context, fetcher } = fixture({ [failure]: true });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(false);
    expect(result.steps.find(step => step.name === "play-audio")?.status).toBe("succeeded");
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("failed");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(4);
    expect(result.durationMs).toBeLessThanOrEqual(18000);
  });
  it("never retries uncertain creation or guesses a call ID", async () => {
    const { context, fetcher } = fixture({ uncertainCreate: true });
    const result = await teamsCallProbe(probe, context);
    expect(result.success).toBe(false);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("skipped");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not repair failed business hang-up when fallback cleanup succeeds", async () => {
    const { context, fetcher } = fixture({ failFirstDelete: true });
    const result = await teamsCallProbe(probe, context);
    expect(result.success).toBe(false);
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("failed");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(3);
  });
  it("requires the dedicated calling client and authenticated operation store, with no fallback", async () => {
    const { context, fetcher } = fixture();
    const { teamsCalling, teamsCallOperations, ...withoutCalling } = context;
    for (const supplied of [{ ...withoutCalling, graph: teamsCalling }, { ...withoutCalling, teamsCalling }]) {
      expect((await teamsCallProbe(probe, supplied)).diagnosticCategory).toBe("configuration-failure");
    }
    expect(fetcher).not.toHaveBeenCalled();
    teamsCallOperations.shutdown();
  });
  it("simulates the new business steps without network or recipient-heard claims", async () => {
    const { context, fetcher } = fixture();
    const result = resultSchema.parse(await simulate(probe, context));
    expect(result.success).toBe(true);
    expect(result.steps.find(step => step.name === "play-audio")?.status).toBe("succeeded");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
