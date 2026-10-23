import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../../utils/src/graph.js";
import { AuthenticatedHttp, IntegrationError } from "../../utils/src/http.js";
import { TeamsUserClient } from "../../utils/src/teams-user.js";
import type { TeamsUserCredential } from "../../utils/src/teams-user-auth.js";
import { teamsProbe, teamsReplyProbe } from "../src/journey.js";
import { resultSchema, type Probe } from "../../utils/src/contracts.js";

const userId = "22222222-2222-4222-8222-222222222222";
const probe: Probe = {
  id: "teams-user-001", type: "teams-channel-reply", cohort: "teams-global",
  tenantId: "11111111-1111-4111-8111-111111111111",
  teamId: "33333333-3333-4333-8333-333333333333", channelId: "standard-channel",
  userPrincipalName: "test@example.invalid",
};

function fixture(options: { cleanupEnabled?: boolean; wrongAuthor?: boolean; cleanupFailure?: boolean; ambiguousReply?: boolean; missingCache?: boolean; wrongReadAuthor?: boolean; claimsChallenge?: boolean } = {}) {
  let parentMarker = "", replyMarker = "";
  const deleted = new Set<string>();
  let clock = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    if (options.claimsChallenge) return new Response(null, {
      status: 401, headers: { "WWW-Authenticate": 'Bearer error="insufficient_claims", claims="test-only"' },
    });
    if (method === "POST" && url.endsWith("/softDelete")) {
      if (!(options.cleanupFailure && url.includes("/replies/"))) deleted.add(url.slice(0, -"/softDelete".length));
      return new Response(null, { status: options.cleanupFailure && url.includes("/replies/") ? 403 : 204 });
    }
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as { body: { contentType: string; content: string } };
      if (url.endsWith("/replies")) {
        replyMarker = body.body.content;
        if (options.ambiguousReply) throw new Error("network lost after mutation");
      } else { parentMarker = body.body.content; }
      return Response.json({
        id: url.endsWith("/replies") ? "reply-1" : "parent-1",
        from: { user: { id: options.wrongAuthor ? probe.teamId : userId } },
      }, { status: 201 });
    }
    const reply = url.includes("/replies");
    if (/\/(?:parent|reply)-1$/.test(url)) return Response.json({
      id: reply ? "reply-1" : "parent-1",
      deletedDateTime: deleted.has(url) ? new Date().toISOString() : null,
      body: { contentType: "text", content: reply ? replyMarker : parentMarker },
      from: { user: { id: options.wrongReadAuthor ? probe.teamId : userId } },
    });
    return Response.json({ value: [{
      id: reply ? "reply-1" : "parent-1", body: { contentType: "text", content: reply ? replyMarker : parentMarker },
      from: { user: { id: options.wrongReadAuthor ? probe.teamId : userId } },
    }] });
  });
  const credential = {
    userId, getToken: vi.fn(async () => {
      if (options.missingCache) throw new IntegrationError("reauthentication-required");
      return { token: "fake-unit-test-value", expiresOnTimestamp: Date.now() + 3600000 };
    }),
  } as unknown as TeamsUserCredential;
  const graph = new GraphClient(new AuthenticatedHttp(credential, "unused", { fetch: fetcher }));
  const client = new TeamsUserClient(graph, credential);
  const context = {
    config: {
      SYNTHETIC_SCENARIO: "healthy" as const, PROBE_TIMEOUT_MS: 1000, POLL_INTERVAL_MS: 10,
      TEAMS_CLEANUP_ENABLED: options.cleanupEnabled === false ? "false" as const : "true" as const,
    },
    graph, teamsBot: client, signal: new AbortController().signal,
    telemetry: { emit: vi.fn() }, now: () => clock++,
    sleep: async (ms: number) => { clock += ms; },
  };
  return { fetcher, context };
}

describe("delegated channel Graph journeys", () => {
  it.each([false, true])("retains user messages without softDelete/read reconciliation after successful readback (reply=%s)", async reply => {
    const { fetcher, context } = fixture({ cleanupEnabled: false });
    const result = await (reply ? teamsReplyProbe : teamsProbe)({
      ...probe, type: reply ? "teams-channel-reply" : "teams-channel-message",
    }, context);
    expect(resultSchema.parse(result).success).toBe(true);
    expect(result.steps.at(-1)).toMatchObject({ name: "cleanup", status: "skipped", reason: "cleanup-disabled" });
    expect(result.diagnosticContext).not.toHaveProperty("cleanupSucceeded");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(reply ? 2 : 1);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/softDelete"))).toBe(false);
    expect(fetcher.mock.calls.filter(([, init]) => !init?.method || init.method === "GET"))
      .toHaveLength(reply ? 2 : 1);
    expect(context.telemetry.emit).toHaveBeenCalledWith("teams-cleanup-disabled", expect.objectContaining({ mode: "live", mutationAttempted: true }));
  });
  it.each([false, true])("still fails wrong-author readback while retaining all created user content (reply=%s)", async reply => {
    const { fetcher, context } = fixture({ cleanupEnabled: false, wrongReadAuthor: true });
    const result = await (reply ? teamsReplyProbe : teamsProbe)({
      ...probe, type: reply ? "teams-channel-reply" : "teams-channel-message",
    }, context);
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("delivery-timeout");
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/softDelete"))).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ status: "skipped", reason: "cleanup-disabled" });
    expect(result.diagnosticContext).not.toHaveProperty("cleanupSucceeded");
  });
  it("does not reconcile or delete an ambiguous reply when retention is selected", async () => {
    const { fetcher, context } = fixture({ cleanupEnabled: false, ambiguousReply: true });
    const result = await teamsReplyProbe(probe, context);
    expect(result.success).toBe(false);
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(result.steps.at(-1)).toMatchObject({ status: "skipped", reason: "cleanup-disabled" });
  });
  it("does not claim retained content or executed cleanup when authentication failed before posting", async () => {
    const { fetcher, context } = fixture({ cleanupEnabled: false, missingCache: true });
    const result = await teamsReplyProbe(probe, context);
    expect(result.diagnosticCategory).toBe("reauthentication-required");
    expect(result.diagnosticContext).not.toHaveProperty("cleanupSucceeded");
    expect(fetcher).not.toHaveBeenCalled();
    expect(context.telemetry.emit).toHaveBeenCalledWith("teams-cleanup-disabled", expect.objectContaining({
      mutationAttempted: false,
    }));
  });
  it.each([false, true])("posts, reads expected user-authored content and soft-deletes only owned messages (reply=%s)", async reply => {
    const { fetcher, context } = fixture();
    const result = await (reply ? teamsReplyProbe : teamsProbe)({
      ...probe, type: reply ? "teams-channel-reply" : "teams-channel-message",
    }, context);
    expect(resultSchema.parse(result).success).toBe(true);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(result.publicationDurationMs).toBeGreaterThanOrEqual(result.sendDurationMs!);
    const mutations = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(mutations.map(([url]) => new URL(String(url)).pathname)).toEqual(reply ? [
      `/v1.0/teams/${probe.teamId}/channels/standard-channel/messages`,
      `/v1.0/teams/${probe.teamId}/channels/standard-channel/messages/parent-1/replies`,
      `/v1.0/teams/${probe.teamId}/channels/standard-channel/messages/parent-1/replies/reply-1/softDelete`,
      `/v1.0/teams/${probe.teamId}/channels/standard-channel/messages/parent-1/softDelete`,
    ] : [
      `/v1.0/teams/${probe.teamId}/channels/standard-channel/messages`,
      `/v1.0/teams/${probe.teamId}/channels/standard-channel/messages/parent-1/softDelete`,
    ]);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("https://graph.microsoft.com/v1.0/"))).toBe(true);
  });
  it("rejects a wrong actual posting author and never deletes an unverified ID", async () => {
    const { context, fetcher } = fixture({ wrongAuthor: true });
    const result = await teamsReplyProbe(probe, context);
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("authentication-failure");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it("requires the expected user on independently polled readback", async () => {
    const { context } = fixture({ wrongReadAuthor: true });
    const result = await teamsReplyProbe(probe, context);
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("delivery-timeout");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
  });
  it("attempts parent cleanup after reply cleanup fails, preserving action successes", async () => {
    const { context, fetcher } = fixture({ cleanupFailure: true });
    const result = await teamsReplyProbe(probe, context);
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("cleanup-failure");
    expect(result.steps.find(step => step.name === "confirm-reply")?.status).toBe("succeeded");
    expect(String(fetcher.mock.calls.filter(([, init]) => init?.method === "POST").at(-1)?.[0]))
      .toContain("/parent-1/softDelete");
  });
  it("does not retry uncertain reply POST or infer ownership from subsequent reads", async () => {
    const { context, fetcher } = fixture({ ambiguousReply: true });
    const result = await teamsReplyProbe(probe, context);
    expect(result.success).toBe(false);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(fetcher.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/replies"))).toHaveLength(1);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/replies/reply-1/softDelete"))).toBe(false);
  });
  it("publishes auth failure evidence with skipped actions when bootstrap is absent", async () => {
    const { context, fetcher } = fixture({ missingCache: true });
    const result = await teamsReplyProbe(probe, context);
    expect(resultSchema.parse(result).success).toBe(false);
    expect(result.diagnosticCategory).toBe("reauthentication-required");
    expect(result.steps.filter(step => ["post-message", "post-reply", "confirm-reply"].includes(step.name))
      .every(step => step.status === "skipped")).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("treats Graph claims challenges as monitoring auth failure without retry or bot fallback", async () => {
    const { context, fetcher } = fixture({ claimsChallenge: true });
    const result = await teamsReplyProbe(probe, context);
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("authentication-failure");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("insufficient_claims");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
  });
});
