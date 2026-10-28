import type { TokenCredential } from "@azure/identity";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { resultSchema, type Probe } from "../../utils/src/contracts.js";
import { GraphClient, graphBase } from "../../utils/src/graph.js";
import { AuthenticatedHttp, IntegrationError } from "../../utils/src/http.js";
import { TeamsBotClient, validateTeamsServiceUrl } from "../../utils/src/teams.js";
import { teamsConversationProbe as teamsProbe } from "../src/conversation.js";
import { teamsJourneyDefinitions } from "../src/catalog.js";
import { authenticate, cleanup, confirmPublication, postMessage, type ChannelAttempt } from "../src/steps.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const applicationId = "33333333-3333-4333-8333-333333333333";
const channelId = "19:dedicated-synthetic@thread.tacv2";
const serviceUrl = "https://smba.trafficmanager.net/teams/";
const graphScope = "https://graph.microsoft.com/.default";
const botScope = "https://api.botframework.com/.default";
const conversationId = "19:conversation@thread.tacv2;messageid=123";
const activityId = "activity/123?owned";
const replyId = "reply/456?owned";
const messagesPath = `/teams/${teamId}/channels/${encodeURIComponent(channelId)}/messages`;
const repliesPath = `${messagesPath}/graph-message-id-not-bot-activity-id/replies`;
const probe: Probe = { id: "teams-001", type: "teams-channel-message", cohort: "teams-global", tenantId, teamId, channelId, serviceUrl };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const message = (marker: string, author = applicationId) => ({
  id: "graph-message-id-not-bot-activity-id",
  deletedDateTime: null,
  body: { contentType: "html", content: `<p>${marker}</p>` },
  from: { application: { id: author } },
});
const nextLink = (token: string) => `${graphBase}${messagesPath}?$top=50&$skiptoken=${token}`;

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: string | undefined;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null | undefined;
}
interface ReadState { poll: number; page: number; marker: string; url: URL }
interface RunOptions {
  cleanupEnabled?: boolean;
  target?: Probe;
  timeoutMs?: number;
  deliveryAfter?: number;
  sendMs?: number;
  readMs?: number;
  cleanupMs?: number;
  authenticationMs?: number;
  authenticationFailure?: "graph" | "bot";
  createStatus?: number;
  createBody?: unknown;
  invalidCreateJson?: boolean;
  createNetworkFailure?: boolean;
  cleanupStatus?: number;
  replyStatus?: number;
  replyNetworkFailure?: boolean;
  attempts?: number;
  onRead?: (state: ReadState) => Response | Promise<Response>;
  onReplyRead?: (state: ReadState) => Response | Promise<Response>;
  controller?: AbortController;
  onCreate?: () => void;
  onCleanup?: (signal: AbortSignal | null | undefined) => void | Promise<void>;
}

async function run(options: RunOptions = {}) {
  let clock = Date.parse("2026-10-19T10:00:00Z");
  let marker = "";
  let replyMarker = "";
  let polls = 0;
  let replyPolls = 0;
  let page = 0;
  const calls: Call[] = [];
  const scopes: { identity: "graph" | "bot"; scope: string | string[] }[] = [];
  const telemetry = { emit: vi.fn() };
  const controller = options.controller ?? new AbortController();
  const credential = (identity: "graph" | "bot"): TokenCredential => {
    let authenticated = false;
    return {
      getToken: async scope => {
        scopes.push({ identity, scope });
        if (!authenticated) clock += (options.authenticationMs ?? 0) / 2;
        authenticated = true;
        if (options.authenticationFailure === identity) throw new Error("private credential details");
        return { token: `${identity}-test-token`, expiresOnTimestamp: Date.now() + 60000 };
      },
    };
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      url: String(url), method, authorization: new Headers(init?.headers).get("Authorization"),
      body: typeof init?.body === "string" ? init.body : undefined,
      redirect: init?.redirect, signal: init?.signal,
    });
    if (url.hostname === "smba.trafficmanager.net" && method === "POST") {
      clock += options.sendMs ?? 30;
      if (url.pathname !== "/teams/v3/conversations") {
        replyMarker = z.object({ text: z.string() }).parse(JSON.parse(String(init?.body))).text;
        if (options.replyNetworkFailure) throw new Error("connection lost after reply");
        return json({ id: replyId }, options.replyStatus ?? 201);
      }
      marker = z.object({ activity: z.object({ text: z.string() }) }).parse(JSON.parse(String(init?.body))).activity.text;
      options.onCreate?.();
      if (options.createNetworkFailure) throw new Error("connection lost after send");
      if (options.invalidCreateJson) return new Response("not JSON", { status: 201 });
      return json(options.createBody === undefined ? { id: conversationId, activityId } : options.createBody, options.createStatus ?? 201);
    }
    if (url.hostname === "smba.trafficmanager.net" && method === "DELETE") {
      clock += options.cleanupMs ?? 10;
      await options.onCleanup?.(init?.signal);
      return new Response(null, { status: options.cleanupStatus ?? 204 });
    }
    if (url.hostname === "graph.microsoft.com" && method === "GET") {
      clock += options.readMs ?? 20;
      if (url.pathname.endsWith("/replies")) {
        if (!url.searchParams.has("$skiptoken")) { replyPolls++; page = 0; }
        page++;
        return options.onReplyRead?.({ poll: replyPolls, page, marker: replyMarker, url }) ??
          json({ value: [{ ...message(replyMarker), id: "graph-reply-id" }] });
      }
      if (!url.searchParams.has("$skiptoken")) { polls++; page = 0; }
      page++;
      return options.onRead?.({ poll: polls, page, marker, url }) ??
        json({ value: polls >= (options.deliveryAfter ?? 1) ? [message(marker)] : [] });
    }
    throw new Error("Unexpected HTTP request");
  });
  const httpOptions = {
    fetch: fetcher, attempts: options.attempts ?? 1,
    sleep: async (ms: number, signal: AbortSignal) => { signal.throwIfAborted(); clock += ms; },
  };
  const graph = new GraphClient(credential("graph"), httpOptions);
  const teamsBot = new TeamsBotClient(new AuthenticatedHttp(credential("bot"), botScope, httpOptions), applicationId);
  const result = await teamsProbe(options.target ?? probe, {
    config: {
      SYNTHETIC_SCENARIO: "healthy", PROBE_TIMEOUT_MS: options.timeoutMs ?? 1000, POLL_INTERVAL_MS: 100,
      TEAMS_CLEANUP_ENABLED: options.cleanupEnabled === false ? "false" : "true",
    },
    graph, teamsBot, signal: controller.signal, telemetry, now: () => clock,
    sleep: async (ms, signal) => { signal.throwIfAborted(); clock += ms; },
  });
  expect(resultSchema.safeParse(result).success).toBe(true);
  expect(result.steps.map(step => step.name)).toEqual(teamsJourneyDefinitions["teams-channel-message"].steps);
  return { result, calls, scopes, telemetry, marker, polls, fetcher };
}

describe("Teams same-bot channel and thread roundtrip", () => {
  it.each([true, false])("honors the cleanup toggle after correct-author bot readback (enabled=%s)", async cleanupEnabled => {
    const { result, calls, telemetry } = await run({ cleanupEnabled });
    expect(result.success).toBe(true);
    expect(result.steps.find(step => step.name === "confirm-reply")?.status).toBe("succeeded");
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(cleanupEnabled ? 2 : 0);
    expect(result.steps.find(step => step.name === "confirm-publication")?.status).toBe("succeeded");
    if (cleanupEnabled) {
      expect(result.steps.at(-1)?.status).toBe("succeeded");
      expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
      expect(telemetry.emit).not.toHaveBeenCalledWith("teams-cleanup-disabled", expect.anything());
    } else {
      expect(result.steps.at(-1)).toMatchObject({ name: "cleanup", status: "skipped", reason: "cleanup-disabled" });
      expect(result.diagnosticContext).not.toHaveProperty("cleanupSucceeded");
      expect(telemetry.emit).toHaveBeenCalledWith("teams-cleanup-disabled", expect.objectContaining({ mode: "live", mutationAttempted: true }));
    }
  });
  it("retains bot messages after failed correct-author readback without attempting cleanup", async () => {
    const { result, calls } = await run({
      cleanupEnabled: false, onRead: ({ marker }) => json({ value: [message(marker, tenantId)] }),
    });
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("read-failure");
    expect(calls.some(call => call.method === "DELETE")).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ status: "skipped", reason: "cleanup-disabled" });
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
  });
  it("does not report a completed channel journey from root publication alone", async () => {
    const { result, calls } = await run({ timeoutMs: 250, onReplyRead: () => json({ value: [] }) });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout" });
    expect(result.steps.find(step => step.name === "confirm-publication")?.status).toBe("succeeded");
    expect(result.steps.find(step => step.name === "post-reply")?.status).toBe("succeeded");
    expect(result.steps.find(step => step.name === "confirm-reply")?.status).toBe("failed");
    expect(result.publicationDurationMs).toBeUndefined();
    expect(calls.filter(call => call.method === "POST")).toHaveLength(2);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
  });
  it.each(["wrong-author", "wrong-correlation", "deleted"] as const)(
    "fails the complete journey when reply evidence has %s", async mismatch => {
      const { result } = await run({ timeoutMs: 250, onReplyRead: ({ marker }) => {
        const item = message(marker, mismatch === "wrong-author" ? tenantId : applicationId);
        if (mismatch === "wrong-correlation") item.body.content += " extra";
        return json({ value: [{ ...item, ...(mismatch === "deleted" ? { deletedDateTime: "2026-10-26T00:00:00Z" } : {}) }] });
      } });
      expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout" });
      expect(result.steps.find(step => step.name === "confirm-reply")?.status).toBe("failed");
    },
  );
  it("does not retry an ambiguous reply or claim root deletion proved unknown reply cleanup", async () => {
    const { result, calls } = await run({ replyNetworkFailure: true, attempts: 3 });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "send-failure" });
    expect(result.steps.find(step => step.name === "post-reply")?.status).toBe("failed");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(2);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(1);
  });
  it("allows every named action to run directly against the existing strict HTTP clients", async () => {
    const urls: string[] = [];
    const marker = "AHM synthetic 11111111-1111-4111-8111-111111111111";
    const credential: TokenCredential = { getToken: async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 60000 }) };
    const fetcher: typeof fetch = async (url, init) => {
      urls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (init?.method === "POST") return json({ id: conversationId, activityId }, 201);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ value: [message(marker)] });
    };
    const graph = new GraphClient(credential, { fetch: fetcher });
    const bot = new TeamsBotClient(new AuthenticatedHttp(credential, botScope, { fetch: fetcher }), applicationId);
    const attempt: ChannelAttempt = { tenantId, teamId, channelId, serviceUrl, marker, mutationAttempted: false };
    const signal = new AbortController().signal;
    expect(await authenticate(graph, bot, attempt, signal)).toEqual({ graph, bot });
    await postMessage(bot, attempt, signal);
    await confirmPublication(graph, applicationId, attempt, signal, 2000, 10, () => 1000);
    await cleanup(bot, attempt, signal);
    expect(urls).toEqual([
      `POST ${serviceUrl}v3/conversations`, `GET ${graphBase}${messagesPath}?$top=50`,
      `DELETE ${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`,
    ]);
  });
  it("uses the documented new-channel-thread body, separate audiences and exact owned activity cleanup", async () => {
    const { result, calls, scopes, telemetry, marker } = await run();
    expect(result).toMatchObject({ success: true, targetService: "Microsoft Teams", diagnosticCategory: null });
    expect(result.steps.map(step => [step.name, step.status])).toEqual([
      ["authenticate", "succeeded"], ["post-message", "succeeded"], ["confirm-publication", "succeeded"],
      ["post-reply", "succeeded"], ["confirm-reply", "succeeded"],
      ["cleanup", "succeeded"],
    ]);
    expect(result.diagnosticContext).toMatchObject({ testStage: "complete", cleanupSucceeded: true });
    expect(telemetry.emit).toHaveBeenCalledWith("teams-channel-roundtrip-observed",
      expect.objectContaining({ evidence: "persisted-bot-root-and-reply" }));
    expect(marker).toBe(`AHM synthetic ${result.correlationId}`);
    expect(calls.map(call => [call.method, call.url])).toEqual([
      ["POST", `${serviceUrl}v3/conversations`],
      ["GET", `${graphBase}${messagesPath}?$top=50`],
      ["POST", `${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`],
      ["GET", `${graphBase}${repliesPath}?$top=50`],
      ["DELETE", `${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(replyId)}`],
      ["DELETE", `${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`],
    ]);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      isGroup: true, bot: { id: `28:${applicationId}` },
      channelData: { tenant: { id: tenantId }, team: { id: teamId }, channel: { id: channelId } },
      activity: { type: "message", textFormat: "plain", text: marker },
    });
    expect(JSON.parse(calls[2]?.body ?? "")).toMatchObject({
      type: "message", text: `AHM synthetic reply ${result.correlationId}`,
      from: { id: `28:${applicationId}` }, replyToId: activityId,
    });
    expect(scopes.every(call => String(call.scope) === (call.identity === "graph" ? graphScope : botScope))).toBe(true);
    for (const call of calls) {
      expect(call.authorization).toBe(new URL(call.url).hostname === "graph.microsoft.com" ? "Bearer graph-test-token" : "Bearer bot-test-token");
      if (new URL(call.url).hostname === "smba.trafficmanager.net") expect(call.redirect).toBe("error");
    }
    const emitted = JSON.stringify({ result, events: telemetry.emit.mock.calls });
    for (const secret of [tenantId, teamId, channelId, applicationId, conversationId, activityId, marker, "test-token"]) {
      expect(emitted).not.toContain(secret);
    }
  });

  it("isolates authentication and post failures without recording unexecuted publication as a failure", async () => {
    const auth = await run({ authenticationFailure: "bot" });
    expect(auth.result.steps.map(step => step.status)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    expect(auth.calls).toEqual([]);
    const post = await run({ createStatus: 403 });
    expect(post.result.steps.map(step => step.status)).toEqual(["succeeded", "failed", "skipped", "skipped", "skipped", "failed"]);
    expect(post.calls.every(call => call.method === "POST")).toBe(true);
    expect(post.result.steps.at(-1)).toMatchObject({ diagnosticCategory: "cleanup-failure" });
  });
  it("separates authentication, request, confirmed publication and total cleanup durations", async () => {
    const { result } = await run({ authenticationMs: 100, sendMs: 30, readMs: 20, cleanupMs: 40, deliveryAfter: 3 });
    expect(result.diagnosticContext.authenticationDurationMs).toBe(100);
    expect(result.sendDurationMs).toBe(30);
    expect(result.publicationDurationMs).toBe(290);
    expect(result.durationMs).toBe(520);
  });

  it("times out unconfirmed publication and cleans up the accepted activity", async () => {
    const { result, calls } = await run({ deliveryAfter: 100, timeoutMs: 350 });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout", durationMs: 360 });
    expect(result.publicationDurationMs).toBeUndefined();
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(result.steps.map(step => step.status)).toEqual(["succeeded", "succeeded", "failed", "skipped", "skipped", "succeeded"]);
  });

  it.each(["graph", "bot"] as const)("authenticates %s before mutation, without cleanup queries on failure", async authenticationFailure => {
    const { result, calls } = await run({ authenticationFailure });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "authentication-failure" });
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(result.sendDurationMs).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it.each([
    [403, "permission-failure"], [429, "graph-throttling"], [503, "send-failure"],
    [302, "send-failure"], [202, "send-failure"], [404, "send-failure"],
  ] as const)("does not resend a failed/ambiguous create (%s)", async (createStatus, category) => {
    const { result, calls, telemetry } = await run({ createStatus, attempts: 3 });
    expect(result).toMatchObject({ success: false, diagnosticCategory: category, sendDurationMs: 30 });
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(result.publicationDurationMs).toBeUndefined();
    expect(calls.map(call => call.method)).toEqual(["POST"]);
    expect(telemetry.emit).toHaveBeenCalledWith("probe-cleanup-failed", expect.objectContaining({ category: "cleanup-failure" }));
  });

  it("does not resend a connection-lost POST or claim cleanup without returned IDs", async () => {
    const { result, calls } = await run({ createNetworkFailure: true, attempts: 3 });
    expect(result.diagnosticCategory).toBe("send-failure");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it.each([
    null, [], {}, { id: conversationId }, { id: "", activityId }, { id: 42, activityId },
    { id: conversationId, activityId: " " }, { id: conversationId, activityId: ".." },
    { id: "x".repeat(2049), activityId }, { id: conversationId, activityId: "\nunsafe" },
  ])("fails malformed create identifiers without using Graph IDs for cleanup: %j", async createBody => {
    const { result, calls } = await run({ createBody });
    expect(result.diagnosticCategory).toBe("malformed-response");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(calls.map(call => call.method)).toEqual(["POST"]);
  });

  it("rejects a create response that is not JSON", async () => {
    const { result } = await run({ invalidCreateJson: true });
    expect(result.diagnosticCategory).toBe("malformed-response");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
  });

  it("ignores response-supplied service URLs and only uses encoded returned IDs", async () => {
    const { result, calls } = await run({
      createBody: { id: conversationId, activityId, serviceUrl: "https://attacker.invalid/" },
    });
    expect(result.steps.find(step => step.name === "confirm-publication")?.status).toBe("succeeded");
    expect(calls.every(call => ["smba.trafficmanager.net", "graph.microsoft.com"].includes(new URL(call.url).hostname))).toBe(true);
    expect(calls.at(-1)?.url).toBe(`${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`);
  });

  it("does not query or mutate after cancellation before authentication", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, calls, scopes } = await run({ controller });
    expect(result.diagnosticCategory).toBe("cancelled");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(calls).toEqual([]);
    expect(scopes).toEqual([]);
  });

  it("treats a caller's arbitrary abort reason as cancellation and independently cleans known IDs", async () => {
    const controller = new AbortController();
    const { result, calls } = await run({
      controller,
      onRead: ({ marker }) => {
        controller.abort(new Error("private cancellation reason"));
        return json({ value: [message(marker)] });
      },
    });
    expect(result.diagnosticCategory).toBe("cancelled");
    expect(result.publicationDurationMs).toBeUndefined();
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(calls.at(-1)?.method).toBe("DELETE");
  });

  it.each([
    [403, "permission-failure"], [429, "graph-throttling"], [503, "read-failure"],
  ] as const)("categorizes Graph read status %s and still deletes through Bot Connector", async (status, category) => {
    const { result, calls } = await run({ onRead: () => new Response(null, { status }) });
    expect(result.diagnosticCategory).toBe(category);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(calls.at(-1)?.method).toBe("DELETE");
  });

  it.each([
    { value: "not a list" },
    { value: [{ id: "broken" }] },
    { value: [], "@odata.nextLink": 7 },
  ])("rejects malformed Graph JSON: %j", async body => {
    const { result } = await run({ onRead: () => json(body) });
    expect(result.diagnosticCategory).toBe("malformed-response");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
  });

  it("rejects a Graph response that is not JSON and still cleans up", async () => {
    const { result } = await run({ onRead: () => new Response("not JSON") });
    expect(result.diagnosticCategory).toBe("malformed-response");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
  });

  it.each(["wrong-author", "wrong-correlation", "deleted", "html-injection", "human"] as const)(
    "does not confirm a %s message", async mismatch => {
      const { result } = await run({
        timeoutMs: 250,
        onRead: ({ marker }) => {
          const item = message(marker);
          if (mismatch === "wrong-author") item.from.application.id = tenantId;
          if (mismatch === "wrong-correlation") item.body.content += " other text";
          if (mismatch === "html-injection") item.body.content = `<script>${marker}</script>`;
          return json({ value: [{
            ...item,
            ...(mismatch === "deleted" ? { deletedDateTime: "2026-10-19T10:00:00Z" } : {}),
            ...(mismatch === "human" ? { from: { user: { id: applicationId }, application: null } } : {}),
          }] });
        },
      });
      expect(result.success).toBe(false);
      expect(result.diagnosticCategory).toBe("delivery-timeout");
    },
  );

  it("reads bounded pages and accepts a plain-text message from the expected bot", async () => {
    const { result, calls } = await run({
      onRead: ({ page, marker }) => page === 1
        ? json({ value: [], "@odata.nextLink": nextLink("page-two") })
        : json({ value: [{ ...message(marker), body: { contentType: "text", content: marker } }] }),
    });
    expect(result.steps.find(step => step.name === "confirm-publication")?.status).toBe("succeeded");
    expect(calls.filter(call => call.method === "GET" && !call.url.includes("/replies")).map(call => call.url)).toEqual([
      `${graphBase}${messagesPath}?$top=50`, nextLink("page-two"),
    ]);
  });

  it.each([false, true])("accepts Graph's literal ':'/'@' next-link pathname (found on first page=%s)", async firstPage => {
    const { result, calls } = await run({
      onRead: ({ page, marker }) => page === 1
        ? json({
          value: [
            ...Array.from({ length: firstPage ? 49 : 50 }, (_, index) => message(`unrelated ${index}`)),
            ...(firstPage ? [message(marker)] : []),
          ],
          "@odata.nextLink": `${graphBase}${messagesPath.replace(/%3A/gi, ":").replace(/%40/gi, "@")}?$top=50&$skiptoken=${"x".repeat(608)}`,
        })
        : json({ value: [message(marker)] }),
    });
    expect(result.steps.find(step => step.name === "confirm-publication")?.status).toBe("succeeded");
    const reads = calls.filter(call => call.method === "GET" && !call.url.includes("/replies"));
    expect(reads).toHaveLength(firstPage ? 1 : 2);
    expect(reads.every(call => new URL(call.url).pathname === `/v1.0${messagesPath}`)).toBe(true);
  });

  it("bounds each no-match scan to five pages and times out rather than reporting healthy or scanning indefinitely", async () => {
    const { result, calls } = await run({
      onRead: ({ page }) => json({ value: [], "@odata.nextLink": nextLink(`page-${page + 1}`) }),
    });
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("delivery-timeout");
    const reads = calls.filter(call => call.method === "GET");
    expect(reads).toHaveLength(25);
    expect(reads.filter(call => !new URL(call.url).searchParams.has("$skiptoken"))).toHaveLength(5);
    expect(reads.every(call => {
      const token = new URL(call.url).searchParams.get("$skiptoken");
      return token === null || ["page-2", "page-3", "page-4", "page-5"].includes(token);
    })).toBe(true);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
  });
  it("restarts a bounded scan while the new bot post is absent from Graph's initial collection snapshot", async () => {
    const { result, calls } = await run({
      onRead: ({ poll, page, marker }) => poll === 1
        ? json({ value: [], "@odata.nextLink": nextLink(`page-${page + 1}`) })
        : json({ value: [message(marker)] }),
    });
    expect(result.success).toBe(true);
    expect(result.steps.find(step => step.name === "confirm-publication")?.status).toBe("succeeded");
    expect(result.steps.find(step => step.name === "confirm-reply")?.status).toBe("succeeded");
    expect(calls.filter(call => call.method === "GET" && !call.url.includes("/replies"))).toHaveLength(6);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
  });

  it("follows the 5508-character continuation token observed in live Graph responses", async () => {
    const token = "x".repeat(5508);
    const { result, calls } = await run({
      onRead: ({ page, marker }) => page === 1
        ? json({ value: [], "@odata.nextLink": nextLink(token) })
        : json({ value: [message(marker)] }),
    });
    expect(result.steps.find(step => step.name === "confirm-publication")?.status).toBe("succeeded");
    expect(calls.filter(call => call.method === "GET" && !call.url.includes("/replies")).map(call => call.url)).toEqual([
      `${graphBase}${messagesPath}?$top=50`, nextLink(token),
    ]);
  });

  it("follows a continuation token far beyond the old 8192-character bound, as Graph's token grows with channel history", async () => {
    const token = "x".repeat(30000);
    const { result, calls } = await run({
      onRead: ({ page, marker }) => page === 1
        ? json({ value: [], "@odata.nextLink": nextLink(token) })
        : json({ value: [message(marker)] }),
    });
    expect(result.steps.find(step => step.name === "confirm-publication")?.status).toBe("succeeded");
    expect(calls.filter(call => call.method === "GET" && !call.url.includes("/replies")).map(call => call.url)).toEqual([
      `${graphBase}${messagesPath}?$top=50`, nextLink(token),
    ]);
  });

  it("confirms first-page evidence even when the continuation link is long, and rejects an absurd one without requesting it", async () => {
    const long = await run({ onRead: ({ marker }) => json({ value: [message(marker)], "@odata.nextLink": nextLink("x".repeat(30000)) }) });
    expect(long.result.steps.find(step => step.name === "confirm-publication")?.status).toBe("succeeded");
    const absurd = await run({ onRead: ({ marker }) => json({ value: [message(marker)], "@odata.nextLink": nextLink("x".repeat(70000)) }) });
    expect(absurd.result.diagnosticCategory).toBe("malformed-response");
    expect(absurd.calls.filter(call => call.method === "GET" && !call.url.includes("/replies"))).toHaveLength(1);
    expect(absurd.result.diagnosticContext.cleanupSucceeded).toBe(true);
  });

  it.each([
    `${graphBase}${messagesPath}?$top=51&$skiptoken=unfollowed`,
    `${graphBase}${messagesPath}?$skiptoken=${"x".repeat(4097)}`,
  ])("confirms actual first-page bot evidence without following irrelevant continuation metadata: %s", async link => {
    const { result, calls } = await run({
      onRead: ({ marker }) => json({ value: [message(marker)], "@odata.nextLink": link }),
    });
    expect(result.steps.find(step => step.name === "confirm-publication")?.status).toBe("succeeded");
    expect(calls.filter(call => call.method === "GET" && !call.url.includes("/replies")).map(call => call.url)).toEqual([
      `${graphBase}${messagesPath}?$top=50`,
    ]);
  });

  it("rejects pagination cycles", async () => {
    const { result, calls } = await run({ onRead: () => json({ value: [], "@odata.nextLink": nextLink("same-page") }) });
    expect(result.diagnosticCategory).toBe("read-failure");
    expect(calls.filter(call => call.method === "GET")).toHaveLength(2);
  });

  it.each([
    `https://attacker.invalid/v1.0${messagesPath}?$skiptoken=x`,
    `http://graph.microsoft.com/v1.0${messagesPath}?$skiptoken=x`,
    `https://graph.microsoft.com:443/v1.0${messagesPath}?$skiptoken=x`,
    `https://user@graph.microsoft.com/v1.0${messagesPath}?$skiptoken=x`,
    `${graphBase}/users?$skiptoken=x`,
    `${graphBase}${messagesPath.replace(teamId, tenantId)}?$skiptoken=x`,
    `${graphBase}${messagesPath.replace(encodeURIComponent(channelId), "19:other@thread.tacv2")}?$skiptoken=x`,
    `${graphBase}${messagesPath.replace("%3A", "%2F")}?$skiptoken=x`,
    `${graphBase}${messagesPath.replace("%3A", "%5C")}?$skiptoken=x`,
    `${graphBase}${messagesPath.replace("%3A", "%253A")}?$skiptoken=x`,
    `${graphBase}${messagesPath}/../messages?$skiptoken=x`,
    `${graphBase}${messagesPath}/%2e%2e/messages?$skiptoken=x`,
    `${graphBase}${messagesPath}?$skiptoken=x#fragment`,
    `${graphBase}${messagesPath}?$filter=anything&$skiptoken=x`,
    `${graphBase}${messagesPath}?$expand=replies&$skiptoken=x`,
    `${graphBase}${messagesPath}?$skiptoken=x&$skiptoken=y`,
    `${graphBase}${messagesPath}?$top=51&$skiptoken=x`,
    `${graphBase}${messagesPath}?$top=50`,
  ])("never follows an unsafe/out-of-scope nextLink: %s", async link => {
    const { result, calls } = await run({ onRead: () => json({ value: [], "@odata.nextLink": link }) });
    expect(result.diagnosticCategory).toBe("read-failure");
    expect(calls.filter(call => call.method === "GET")).toHaveLength(1);
  });

  it("does not confirm a message returned after the search deadline", async () => {
    const { result } = await run({ timeoutMs: 50, sendMs: 30, readMs: 30 });
    expect(result.diagnosticCategory).toBe("read-failure");
    expect(result.publicationDurationMs).toBeUndefined();
  });

  it("fails the completed journey when owned reply and root cleanup fail", async () => {
    const { result } = await run({ cleanupStatus: 403 });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "cleanup-failure", sendDurationMs: 30, durationMs: 120 });
    expect(result.publicationDurationMs).toBe(50);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
  });

  it("accepts an already absent owned activity as successful idempotent cleanup", async () => {
    const { result } = await run({ cleanupStatus: 404 });
    expect(result.success).toBe(true);
    expect(result.steps.find(step => step.name === "confirm-publication")?.status).toBe("succeeded");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
  });

  it("retries only idempotent cleanup and bounds it independently of a cancelled caller", async () => {
    const controller = new AbortController();
    let cleanupSignal: AbortSignal | null | undefined;
    const { result, calls } = await run({
      controller, attempts: 3, onCreate: () => controller.abort(),
      cleanupStatus: 503, onCleanup: signal => { cleanupSignal = signal; },
    });
    expect(result.diagnosticCategory).toBe("cancelled");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
    expect(calls.filter(call => call.method === "GET")).toHaveLength(0);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(3);
    expect(cleanupSignal).toBeInstanceOf(AbortSignal);
    expect(cleanupSignal?.aborted).toBe(false);
    expect(cleanupSignal).not.toBe(controller.signal);
  });

  it("reports cancelled bounded cleanup without replacing a preceding read failure", async () => {
    const { result } = await run({
      onRead: () => new Response(null, { status: 403 }),
      onCleanup: () => { throw new DOMException("cancelled cleanup", "AbortError"); },
    });
    expect(result.diagnosticCategory).toBe("permission-failure");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
  });

  it("terminates cleanup at its independent ten-second budget after caller cancellation", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("test deadline", "TimeoutError")), ms);
      return controller.signal;
    });
    try {
      const controller = new AbortController();
      let cleanupAborted = false;
      const pending = run({
        controller,
        onCreate: () => controller.abort(),
        onCleanup: async signal => {
          if (!signal) throw new Error("missing bounded cleanup signal");
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => { cleanupAborted = true; reject(signal.reason); }, { once: true });
          });
        },
      });
      await vi.advanceTimersByTimeAsync(9999);
      expect(cleanupAborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const { result, calls } = await pending;
      expect(timeout).toHaveBeenCalledWith(10000);
      expect(cleanupAborted).toBe(true);
      expect(result.diagnosticCategory).toBe("cancelled");
      expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
      expect(calls.map(call => call.method)).toEqual(["POST", "DELETE"]);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("approved Bot Connector base", () => {
  it.each(["teams", "amer", "emea", "apac"])("normalizes the public-cloud %s base", region => {
    expect(validateTeamsServiceUrl(`https://smba.trafficmanager.net/${region}`)).toBe(`https://smba.trafficmanager.net/${region}/`);
  });

  it.each([
    "http://smba.trafficmanager.net/teams/",
    "https://smba.trafficmanager.net.evil.invalid/teams/",
    "https://attacker.invalid/teams/",
    "https://user:password@smba.trafficmanager.net/teams/",
    "https://smba.trafficmanager.net:443/teams/",
    "https://smba.trafficmanager.net/teams/?x=1",
    "https://smba.trafficmanager.net/teams/#fragment",
    "https://smba.trafficmanager.net/amer/../teams/",
    "https://smba.trafficmanager.net/%74eams/",
    "https://smba.trafficmanager.net/teams/../teams/",
    "https://smba.trafficmanager.net/teams\\",
    "https://smba.trafficmanager.net/unknown/",
    "https://graph.microsoft.com/v1.0/",
  ])("rejects an unapproved base before token acquisition or requests: %s", async unsafe => {
    const token = vi.fn<TokenCredential["getToken"]>(async () => ({ token: "bot-test-token", expiresOnTimestamp: Date.now() + 60000 }));
    const fetcher = vi.fn<typeof fetch>();
    const bot = new TeamsBotClient(new AuthenticatedHttp({ getToken: token }, botScope, { fetch: fetcher }), applicationId);
    expect(() => validateTeamsServiceUrl(unsafe)).toThrow(IntegrationError);
    await expect(bot.createChannelPost(unsafe, tenantId, teamId, channelId, "marker", new AbortController().signal)).rejects.toMatchObject({ category: "collector-failure" });
    await expect(bot.deleteMessage(unsafe, conversationId, activityId, new AbortController().signal)).rejects.toMatchObject({ category: "collector-failure" });
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    const { result, calls, scopes } = await run({ target: { ...probe, serviceUrl: unsafe } });
    expect(result.diagnosticCategory).toBe("collector-failure");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(calls).toEqual([]);
    expect(scopes).toEqual([]);
  });
});
