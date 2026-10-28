import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";
import { resultSchema, reportedResult, type Probe } from "../../utils/src/contracts.js";
import { createTeamsCallProbe, teamsCallProbe } from "../src/call.js";
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
const otherId = "33333333-3333-4333-8333-333333333333";

function fixture(options: {
  uncertainCreate?: boolean; earlyTermination?: boolean; deleteFailure?: boolean; terminateFailure?: boolean;
  abortOnRead?: boolean; unanswered?: boolean; failFirstDelete?: boolean;
  peerCreateFailure?: boolean; peerUnanswered?: boolean; peerDeleteFailure?: boolean;
  missingRoster?: boolean; wrongRoster?: boolean; emptyPeerRoster?: boolean; lobbyPeer?: boolean;
  duplicateCallId?: boolean; mismatchedChains?: boolean; peerRosterFailure?: boolean;
  primaryCreateForbidden?: boolean; peerCreateUncertain?: boolean; abortAfterPrimaryCreate?: boolean;
  failedAuthentication?: "primary" | "peer";
  wrongMeeting?: "thread" | "organizer" | "tenant" | "organizer-tenant"; primaryDeleteFailure?: boolean;
  promotedPeerChain?: boolean; cleanupChainChange?: boolean;
  droppedLeg?: "primary" | "peer";
} = {}) {
  let clock = 0;
  const deletedCalls = new Set<string>();
  let deleteAttempts = 0;
  const readCounts = new Map<string, number>();
  const controller = new AbortController();
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
          application: { id: options.wrongRoster ? otherId : probe.peerBotClientId },
        } } },
      ] });
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
        resultInfo: null,
        state: "establishing", callChainId: peer && (options.mismatchedChains || options.promotedPeerChain) ? otherId : chainId,
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
    const reads = (readCounts.get(id) ?? 0) + 1;
    readCounts.set(id, reads);
    return Response.json({
      id,
      resultInfo: null,
      callChainId: deleted && options.cleanupChainChange ? otherId
        : peer && options.promotedPeerChain && reads === 1 ? otherId
        : peer && options.mismatchedChains ? otherId : chainId,
      state: deleted ? options.terminateFailure ? "established" : "terminated"
        : options.earlyTermination || (options.droppedLeg === (peer ? "peer" : "primary") && reads > 2) ? "terminated"
        : options.unanswered || (peer && (options.peerUnanswered || (options.promotedPeerChain && reads < 3))) ? "establishing" : "established",
      chatInfo: { threadId: options.wrongMeeting === "thread" ? "19:meeting_foreign@thread.v2" : probe.meetingThreadId },
      meetingInfo: {
        "@odata.type": "#microsoft.graph.organizerMeetingInfo",
        organizer: { user: {
          id: options.wrongMeeting === "organizer" ? otherId : probe.organizerUserId,
          tenantId: options.wrongMeeting === "organizer-tenant" ? otherId : probe.tenantId,
        } },
      },
      tenantId: options.wrongMeeting === "tenant" ? otherId : probe.tenantId,
    });
  });
  const graph = new GraphClient({
    getToken: async () => {
      if (options.failedAuthentication === "primary") throw new Error("primary managed identity token unavailable");
      return { token: "fake-bot-token", expiresOnTimestamp: Date.now() + 60000 };
    },
  }, { fetch: fetcher, attempts: 1 });
  const peerGraph = new GraphClient({
    getToken: async () => {
      if (options.failedAuthentication === "peer") throw new Error("peer managed identity token unavailable");
      return { token: "fake-peer-token", expiresOnTimestamp: Date.now() + 60000 };
    },
  }, { fetch: fetcher, attempts: 1 });
  const context = {
    config: {
      SYNTHETIC_SCENARIO: "healthy" as const, PROBE_TIMEOUT_MS: 45000, POLL_INTERVAL_MS: 250,
      TEAMS_CALLING_ANSWER_TIMEOUT_SECONDS: 20,
      BOT_CLIENT_ID: primaryClientId, TEAMS_CALLING_PEER_CLIENT_ID: probe.peerBotClientId!,
      TEAMS_CLEANUP_ENABLED: "false" as const, TEAMS_CALLING_CALLBACK_URL: "https://approved.example.invalid/api/calls",
    },
    teamsCalling: graph, teamsCallingPeer: peerGraph, signal: controller.signal,
    telemetry: { emit: vi.fn((event: string) => {
      if (options.abortAfterPrimaryCreate && event === "teams-call-created") controller.abort();
    }) },
    now: () => clock, sleep: async (ms: number) => { clock += ms; },
  };
  return { context, fetcher };
}

describe("two-bot meeting connectivity and verified disconnection", () => {
  it.each(["failed", "cancelled"] as const)("independently ends both calls after a pilot hook is %s without adding business steps", async outcome => {
    const { context, fetcher } = fixture();
    const controller = new AbortController();
    const handler = createTeamsCallProbe(async call => {
      await call.verifyConnected(call.signal);
      if (outcome === "cancelled") controller.abort();
      throw new IntegrationError(outcome === "cancelled" ? "cancelled" : "read-failure");
    });
    const result = resultSchema.parse(await handler(probe, { ...context, signal: controller.signal }));
    expect(result.success).toBe(false);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(result.call?.endedAt).toBeDefined();
    expect(reportedResult(result).steps.map(step => step.name)).toEqual([
      "place-call", "wait-for-answer", "verify-meeting-metadata", "verify-participants", "end-call",
    ]);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
  });
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
      expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
      expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
    },
  );
  it.each(["missingRoster", "wrongRoster", "emptyPeerRoster", "lobbyPeer", "peerRosterFailure"] as const)(
    "fails %s without claiming meeting success; both independently owned calls are disconnected", async failure => {
      const { context, fetcher } = fixture({ [failure]: true });
      const result = resultSchema.parse(await teamsCallProbe(probe, context));
      expect(result.success).toBe(false);
      expect(result.steps.find(step => step.name === "verify-participants")?.status).toBe("failed");
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) =>
        new URL(String(url)).pathname)).toEqual([
        "/v1.0/communications/calls/owned-call", "/v1.0/communications/calls/peer-call",
      ]);
      expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    },
  );
  it.each(["peerCreateFailure", "peerUnanswered", "duplicateCallId", "mismatchedChains"] as const)(
    "fails %s without orphaning the primary", async failure => {
      const { context, fetcher } = fixture({ [failure]: true });
      const result = resultSchema.parse(await teamsCallProbe(probe, context));
      expect(result.success).toBe(false);
      expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/owned-call") && init?.method === "DELETE")).toBe(true);
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
  it("records the established conference chain when a peer's provisional join chain is promoted", async () => {
    const { context, fetcher } = fixture({ promotedPeerChain: true });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(true);
    expect(result.call).toMatchObject({ callChainId: chainId, peerCallChainId: chainId });
    expect(result.steps.find(step => step.name === "wait-for-answer")?.status).toBe("succeeded");
    expect(result.steps.find(step => step.name === "verify-meeting-metadata")?.status).toBe("succeeded");
    expect(result.steps.find(step => step.name === "verify-participants")?.status).toBe("succeeded");
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
    expect(context.telemetry.emit).toHaveBeenCalledWith("teams-call-chain-changed", expect.objectContaining({
      leg: "peer", state: "establishing", previousCallChainId: otherId, callChainId: chainId,
    }));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
  });
  it("does not mistake teardown chain metadata for failed termination or overwrite the established call-chain record", async () => {
    const { context, fetcher } = fixture({ cleanupChainChange: true });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(true);
    expect(result.call).toMatchObject({ callChainId: chainId, peerCallChainId: chainId });
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
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
      selection === "missing" ? undefined : selection === "primary" ? primaryClientId : otherId };
    const result = await teamsCallProbe(probe, { ...context, config });
    expect(result.diagnosticCategory).toBe("configuration-failure");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("joins and verifies both bots, then leaves without media uploads, playback or operation callbacks", async () => {
    const { context, fetcher } = fixture();
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(true);
    expect(reportedResult(result).steps.map(step => step.name)).toEqual(["place-call", "wait-for-answer", "verify-meeting-metadata", "verify-participants", "end-call"]);
    expect(result.durationMs).toBe(0);
    expect(result.sendDurationMs).toBeUndefined();
    expect(result.publicationDurationMs).toBeUndefined();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(fetcher.mock.calls.some(([url]) => /playPrompt|\/media\//.test(String(url)))).toBe(false);
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
  });
  it.each(["primary", "peer"] as const)("fails a dropped %s leg despite a stale complete roster, and still ends both calls", async leg => {
    const { context, fetcher } = fixture({ droppedLeg: leg });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(false);
    expect(result.steps.find(step => step.name === "wait-for-answer")?.status).toBe("succeeded");
    expect(result.steps.find(step => step.name === "verify-participants")).toMatchObject({
      status: "failed", diagnosticCategory: "read-failure",
    });
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
  });
  it.each(["earlyTermination", "abortOnRead", "unanswered"] as const)(
    "fails %s but independently verifies hang-up", async failure => {
      const { context, fetcher } = fixture({ [failure]: true });
      const result = resultSchema.parse(await teamsCallProbe(probe, context));
      expect(result.success).toBe(false);
      expect(result.steps.find(step => step.name === "wait-for-answer")?.status).toBe("failed");
      expect(result.steps.find(step => step.name === "verify-meeting-metadata")?.status).toBe("skipped");
      expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
      expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
      if (failure === "unanswered") {
        expect(result.diagnosticCategory).toBe("delivery-timeout");
        expect(result.durationMs).toBeGreaterThanOrEqual(20000);
      }
    },
  );
  it.each(["deleteFailure", "terminateFailure"] as const)("bounds cleanup after %s", async failure => {
    const { context, fetcher } = fixture({ [failure]: true });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(false);
    expect(result.steps.find(step => step.name === "verify-participants")?.status).toBe("succeeded");
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
  it("requires both distinct dedicated calling clients, with no generic Graph fallback", async () => {
    const { context, fetcher } = fixture();
    const { teamsCalling, teamsCallingPeer, ...withoutCalling } = context;
    for (const supplied of [
      { ...withoutCalling, graph: teamsCalling }, { ...withoutCalling, teamsCalling },
      { ...withoutCalling, teamsCallingPeer }, { ...withoutCalling, teamsCalling, teamsCallingPeer: teamsCalling },
    ]) {
      expect((await teamsCallProbe(probe, supplied)).diagnosticCategory).toBe("configuration-failure");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    undefined, "http://approved.example.invalid/api/calls",
    "https://approved.example.invalid/api/calls?media=other", "https://approved.example.invalid/arbitrary",
  ])("rejects an invalid callback URL before either bot joins: %s", async callbackUrl => {
    const { context, fetcher } = fixture();
    const result = await teamsCallProbe(probe, {
      ...context, config: { ...context.config, TEAMS_CALLING_CALLBACK_URL: callbackUrl },
    });
    expect(result.diagnosticCategory).toBe("configuration-failure");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("simulates the new business steps without network or recipient-heard claims", async () => {
    const { context, fetcher } = fixture();
    const result = resultSchema.parse(await simulate(probe, context));
    expect(result.success).toBe(true);
    expect(result.steps.find(step => step.name === "verify-participants")?.status).toBe("succeeded");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
