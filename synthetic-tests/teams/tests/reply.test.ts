import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { resultSchema, type Probe } from "../../utils/src/contracts.js";
import { GraphClient, graphBase } from "../../utils/src/graph.js";
import { AuthenticatedHttp } from "../../utils/src/http.js";
import { TeamsBotClient } from "../../utils/src/teams.js";
import { teamsReplyProbe } from "../src/journey.js";
import { cleanupReply, postReply, type ChannelReplyAttempt } from "../src/steps.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const applicationId = "33333333-3333-4333-8333-3333333333ab";
const channelId = "19:dedicated-synthetic@thread.tacv2";
const serviceUrl = "https://smba.trafficmanager.net/teams/";
const conversationId = "19:conversation@thread.tacv2;messageid=123";
const rootActivityId = "root/123?owned";
const replyActivityId = "reply/456?owned";
const graphRootId = "graph-root/789?not-a-bot-id";
const messagesPath = `/teams/${teamId}/channels/${encodeURIComponent(channelId)}/messages`;
const repliesPath = `${messagesPath}/${encodeURIComponent(graphRootId)}/replies`;
const activityUrl = (id: string) =>
  `${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(id)}`;
const probe: Probe = {
  id: "teams-reply-001", type: "teams-channel-reply", cohort: "teams-reply",
  tenantId, teamId, channelId, serviceUrl,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const message = (marker: string, id = graphRootId) => ({
  id, deletedDateTime: null,
  body: { contentType: "html", content: `<p>${marker}</p>` },
  from: { application: { id: applicationId } },
});
const nextLink = (path: string, token: string) => `${graphBase}${path}?$top=50&$skiptoken=${token}`;

interface Call {
  url: string;
  method: string;
  body?: string;
  signal: AbortSignal | null | undefined;
  redirect: RequestRedirect | undefined;
  authorization: string | null;
}
interface ReadState {
  marker: string;
  rootMarker: string;
  replyMarker: string;
  poll: number;
  page: number;
}
interface RunOptions {
  timeoutMs?: number;
  authenticationMs?: number;
  rootMs?: number;
  replyMs?: number;
  readMs?: number;
  cleanupMs?: number;
  authenticationFailure?: "graph" | "bot";
  rootStatus?: number;
  rootBody?: unknown;
  replyStatus?: number;
  replyBody?: unknown;
  invalidReplyJson?: boolean;
  replyNetworkFailure?: boolean;
  attempts?: number;
  controller?: AbortController;
  onPost?: (activity: "root" | "reply") => void;
  onRootRead?: (state: ReadState) => Response;
  onReplyRead?: (state: ReadState) => Response;
  cleanupStatus?: Partial<Record<"root" | "reply", number>>;
  onCleanup?: (activity: "root" | "reply", signal: AbortSignal | null | undefined) => void | Promise<void>;
}

async function run(options: RunOptions = {}) {
  let clock = Date.parse("2026-10-21T10:00:00Z");
  let rootMarker = "";
  let replyMarker = "";
  const reads = { root: { poll: 0, page: 0 }, reply: { poll: 0, page: 0 } };
  const calls: Call[] = [];
  const scopes: { identity: string; scope: string | string[] }[] = [];
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
      url: String(url), method,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      signal: init?.signal, redirect: init?.redirect,
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    if (String(url) === `${serviceUrl}v3/conversations` && method === "POST") {
      clock += options.rootMs ?? 30;
      rootMarker = JSON.parse(String(init?.body)).activity.text;
      options.onPost?.("root");
      return json(options.rootBody === undefined ? { id: conversationId, activityId: rootActivityId } : options.rootBody, options.rootStatus ?? 201);
    }
    if (String(url) === activityUrl(rootActivityId) && method === "POST") {
      clock += options.replyMs ?? 40;
      replyMarker = JSON.parse(String(init?.body)).text;
      options.onPost?.("reply");
      if (options.replyNetworkFailure) throw new Error("connection lost after send");
      if (options.invalidReplyJson) return new Response("not JSON", { status: 201 });
      return json(options.replyBody === undefined ? { id: replyActivityId } : options.replyBody, options.replyStatus ?? 201);
    }
    if (url.hostname === "graph.microsoft.com" && method === "GET") {
      const activity = url.pathname === `/v1.0${messagesPath}` ? "root"
        : url.pathname === `/v1.0${repliesPath}` ? "reply" : undefined;
      if (!activity) throw new Error("Unexpected Graph collection");
      clock += options.readMs ?? 20;
      const state = reads[activity];
      if (!url.searchParams.has("$skiptoken")) { state.poll++; state.page = 0; }
      state.page++;
      const marker = activity === "root" ? rootMarker : replyMarker;
      const callback = activity === "root" ? options.onRootRead : options.onReplyRead;
      return callback?.({ ...state, marker, rootMarker, replyMarker }) ??
        json({ value: [message(marker, activity === "root" ? graphRootId : "graph-reply-id")] });
    }
    if (url.hostname === "smba.trafficmanager.net" && method === "DELETE") {
      const activity = String(url) === activityUrl(rootActivityId) ? "root"
        : String(url) === activityUrl(replyActivityId) ? "reply" : undefined;
      if (!activity) throw new Error("Attempt to delete an unowned activity");
      clock += options.cleanupMs ?? 10;
      await options.onCleanup?.(activity, init?.signal);
      return new Response(null, { status: options.cleanupStatus?.[activity] ?? 204 });
    }
    throw new Error("Unexpected HTTP request");
  });
  const httpOptions = {
    fetch: fetcher, attempts: options.attempts ?? 1,
    sleep: async (ms: number, signal: AbortSignal) => { signal.throwIfAborted(); clock += ms; },
  };
  const graph = new GraphClient(new AuthenticatedHttp(credential("graph"), "https://graph.microsoft.com/.default", httpOptions));
  const teamsBot = new TeamsBotClient(new AuthenticatedHttp(credential("bot"), "https://api.botframework.com/.default", httpOptions), applicationId);
  const result = await teamsReplyProbe(probe, {
    config: { SYNTHETIC_SCENARIO: "healthy", PROBE_TIMEOUT_MS: options.timeoutMs ?? 1000, POLL_INTERVAL_MS: 100 },
    graph, teamsBot, signal: controller.signal, telemetry, now: () => clock,
    sleep: async (ms, signal) => { signal.throwIfAborted(); clock += ms; },
  });
  expect(resultSchema.safeParse(result).success).toBe(true);
  expect(result.steps.map(step => step.name)).toEqual(["authenticate", "post-message", "post-reply", "confirm-reply", "cleanup"]);
  return { result, calls, scopes, telemetry, rootMarker, replyMarker };
}

describe("Teams bot root / thread reply / Graph readback / owned cleanup", () => {
  it("requires a known owned root before directly replying or cleaning up", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const credential: TokenCredential = { getToken: async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 60000 }) };
    const bot = new TeamsBotClient(new AuthenticatedHttp(credential, "https://api.botframework.com/.default", { fetch: fetcher }), applicationId);
    const attempt: ChannelReplyAttempt = {
      tenantId, teamId, channelId, serviceUrl, marker: "root marker", replyMarker: "reply marker",
      mutationAttempted: false, replyMutationAttempted: false,
    };
    const signal = new AbortController().signal;
    await expect(postReply(bot, attempt, signal)).rejects.toMatchObject({ category: "send-failure" });
    await expect(cleanupReply(bot, attempt, signal)).rejects.toMatchObject({ category: "cleanup-failure" });
    expect(attempt.replyMutationAttempted).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("confirms the exact bot reply under a correlated Graph root, using distinct Bot IDs for deletion", async () => {
    const { result, calls, scopes, telemetry, rootMarker, replyMarker } = await run();
    expect(result).toMatchObject({
      success: true, diagnosticCategory: null, testType: "teams-channel-reply", targetService: "Microsoft Teams",
      diagnosticContext: { cleanupSucceeded: true, testStage: "complete" },
    });
    expect(result.steps.every(step => step.status === "succeeded")).toBe(true);
    expect(rootMarker).toBe(`AHM synthetic ${result.correlationId}`);
    expect(replyMarker).toBe(`AHM synthetic reply ${result.correlationId}`);
    expect(calls.map(call => [call.method, call.url])).toEqual([
      ["POST", `${serviceUrl}v3/conversations`],
      ["POST", activityUrl(rootActivityId)],
      ["GET", `${graphBase}${messagesPath}?$top=50`],
      ["GET", `${graphBase}${repliesPath}?$top=50`],
      ["DELETE", activityUrl(replyActivityId)],
      ["DELETE", activityUrl(rootActivityId)],
    ]);
    expect(JSON.parse(calls[1]?.body ?? "")).toMatchObject({ type: "message", textFormat: "plain", text: replyMarker });
    for (const call of calls) {
      expect(call.redirect).toBe("error");
      expect(call.authorization).toBe(new URL(call.url).hostname === "graph.microsoft.com" ? "Bearer graph-test-token" : "Bearer bot-test-token");
    }
    expect(scopes.every(call => call.scope === (call.identity === "graph"
      ? "https://graph.microsoft.com/.default" : "https://api.botframework.com/.default"))).toBe(true);
    const emitted = JSON.stringify({ result, events: telemetry.emit.mock.calls });
    for (const secret of [tenantId, teamId, channelId, applicationId, conversationId, rootActivityId, replyActivityId, rootMarker, replyMarker, "test-token"]) {
      expect(emitted).not.toContain(secret);
    }
  });

  it("measures reply send and confirmed publication separately from root setup, authentication and cleanup", async () => {
    const { result } = await run({
      authenticationMs: 100, rootMs: 60, replyMs: 30, readMs: 20, cleanupMs: 40,
      onReplyRead: ({ poll, marker }) => json({ value: poll >= 3 ? [message(marker)] : [] }),
    });
    expect(result.diagnosticContext.authenticationDurationMs).toBe(100);
    expect(result.sendDurationMs).toBe(30);
    expect(result.publicationDurationMs).toBe(310);
    expect(result.durationMs).toBe(550);
  });

  it.each(["root", "reply"] as const)("does not accept POST success as confirmed %s readback", async activity => {
    const options = { timeoutMs: 250, [activity === "root" ? "onRootRead" : "onReplyRead"]: () => json({ value: [] }) };
    const { result, calls } = await run(options);
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout" });
    expect(result.publicationDurationMs).toBeUndefined();
    expect(result.steps.map(step => step.status)).toEqual(["succeeded", "succeeded", "succeeded", "failed", "succeeded"]);
    if (activity === "root") expect(calls.some(call => call.url.includes("/replies"))).toBe(false);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
  });

  it.each(["root", "reply"] as const)("requires the %s marker, expected bot application and a nondeleted message", async activity => {
    for (const mismatch of ["author", "marker", "deleted", "human", "html"] as const) {
      const onRead = ({ marker }: ReadState) => {
        const item = message(marker);
        if (mismatch === "author") item.from.application.id = tenantId;
        if (mismatch === "marker") item.body.content += " additional text";
        if (mismatch === "html") item.body.content = `<script>${marker}</script>`;
        return json({ value: [{
          ...item,
          ...(mismatch === "deleted" ? { deletedDateTime: "2026-10-21T10:00:00Z" } : {}),
          ...(mismatch === "human" ? { from: { application: null, user: { id: applicationId } } } : {}),
        }] });
      };
      const { result, calls } = await run({ timeoutMs: 250, [activity === "root" ? "onRootRead" : "onReplyRead"]: onRead });
      expect(result.diagnosticCategory).toBe("delivery-timeout");
      if (activity === "root") expect(calls.some(call => call.url.includes("/replies"))).toBe(false);
    }
  });

  it("does not mistake the root marker or another reply from the same bot for this reply", async () => {
    const { result } = await run({
      timeoutMs: 250,
      onReplyRead: ({ rootMarker, replyMarker }) => json({ value: [message(rootMarker), message(`${replyMarker}-other`)] }),
    });
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("delivery-timeout");
  });

  it("accepts harmless HTML wrappers and case-insensitive application IDs without evaluating HTML", async () => {
    const { result } = await run({
      onReplyRead: ({ marker }) => json({ value: [{
        ...message(marker), body: { contentType: "html", content: `<DIV><p>${marker}</p><br /></DIV>` },
        from: { application: { id: applicationId.toUpperCase() } },
      }] }),
    });
    expect(result.success).toBe(true);
  });

  it("paginates each exact collection independently and caches the correlated root while awaiting the reply", async () => {
    const { result, calls } = await run({
      onRootRead: ({ page, marker }) => page === 1
        ? json({ value: [], "@odata.nextLink": nextLink(messagesPath, "root-page-2") })
        : json({ value: [message(marker)] }),
      onReplyRead: ({ poll, page, marker }) => page === 1
        ? json({ value: [], "@odata.nextLink": nextLink(repliesPath, "reply-page-2") })
        : json({ value: poll >= 2 ? [{ ...message(marker), body: { contentType: "text", content: marker } }] : [] }),
    });
    expect(result.success).toBe(true);
    expect(calls.filter(call => call.method === "GET").map(call => call.url)).toEqual([
      `${graphBase}${messagesPath}?$top=50`, nextLink(messagesPath, "root-page-2"),
      `${graphBase}${repliesPath}?$top=50`, nextLink(repliesPath, "reply-page-2"),
      `${graphBase}${repliesPath}?$top=50`, nextLink(repliesPath, "reply-page-2"),
    ]);
  });

  it.each(["root", "reply"] as const)("bounds the %s search at five pages", async activity => {
    const path = activity === "root" ? messagesPath : repliesPath;
    const { result, calls } = await run({
      [activity === "root" ? "onRootRead" : "onReplyRead"]: ({ page }: ReadState) =>
        json({ value: [], "@odata.nextLink": nextLink(path, `page-${page + 1}`) }),
    });
    expect(result.diagnosticCategory).toBe("read-failure");
    expect(calls.filter(call => call.method === "GET")).toHaveLength(activity === "root" ? 5 : 6);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
  });

  it("rejects reply pagination cycles", async () => {
    const { result, calls } = await run({
      onReplyRead: () => json({ value: [], "@odata.nextLink": nextLink(repliesPath, "same") }),
    });
    expect(result.diagnosticCategory).toBe("read-failure");
    expect(calls.filter(call => call.method === "GET")).toHaveLength(3);
  });

  it.each([
    `https://attacker.invalid/v1.0${repliesPath}?$skiptoken=x`,
    `http://graph.microsoft.com/v1.0${repliesPath}?$skiptoken=x`,
    `https://graph.microsoft.com:443/v1.0${repliesPath}?$skiptoken=x`,
    `https://user@graph.microsoft.com/v1.0${repliesPath}?$skiptoken=x`,
    `https://graph.microsoft.com/beta${repliesPath}?$skiptoken=x`,
    `${graphBase}${messagesPath}?$skiptoken=x`,
    `${graphBase}${messagesPath}/other-root/replies?$skiptoken=x`,
    `${graphBase}${repliesPath}/../replies?$skiptoken=x`,
    `${graphBase}${repliesPath}?$skiptoken=x#fragment`,
    `${graphBase}${repliesPath}?$expand=replies&$skiptoken=x`,
    `${graphBase}${repliesPath}?$skiptoken=x&$skiptoken=y`,
    `${graphBase}${repliesPath}?$top=51&$skiptoken=x`,
    `${graphBase}${repliesPath}?$top=50`,
  ])("never follows an unsafe or out-of-thread continuation: %s", async link => {
    const { result, calls } = await run({
      onReplyRead: ({ marker }) => json({ value: [message(marker)], "@odata.nextLink": link }),
    });
    expect(result.diagnosticCategory).toBe("read-failure");
    expect(calls.filter(call => call.method === "GET")).toHaveLength(2);
  });

  it.each([".", "..", " ", "\nunsafe"])("rejects a Graph root ID that could escape the replies path: %j", async id => {
    const { result, calls } = await run({ onRootRead: ({ marker }) => json({ value: [message(marker, id)] }) });
    expect(result.diagnosticCategory).toBe("read-failure");
    expect(calls.filter(call => call.method === "GET")).toHaveLength(1);
  });

  it("does not accept a reply returned after the deadline", async () => {
    const { result } = await run({ timeoutMs: 100, readMs: 20 });
    expect(result.diagnosticCategory).toBe("read-failure");
    expect(result.publicationDurationMs).toBeUndefined();
  });

  it.each(["graph", "bot"] as const)("skips all mutations and downstream steps after %s authentication failure", async authenticationFailure => {
    const { result, calls } = await run({ authenticationFailure });
    expect(result.diagnosticCategory).toBe("authentication-failure");
    expect(result.steps.map(step => step.status)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped"]);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(calls).toEqual([]);
  });

  it("does not reply or claim cleanup when root creation is ambiguous", async () => {
    const { result, calls } = await run({ rootBody: { id: conversationId } });
    expect(result.diagnosticCategory).toBe("malformed-response");
    expect(result.steps.map(step => step.status)).toEqual(["succeeded", "failed", "skipped", "skipped", "failed"]);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(result.sendDurationMs).toBeUndefined();
    expect(calls.map(call => call.method)).toEqual(["POST"]);
  });

  it("fails root API errors without retrying or executing downstream requests", async () => {
    const { result, calls } = await run({ rootStatus: 503, attempts: 3 });
    expect(result.diagnosticCategory).toBe("send-failure");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(calls.map(call => call.method)).toEqual(["POST"]);
  });

  it.each([
    [403, "permission-failure"], [429, "graph-throttling"], [503, "send-failure"],
    [302, "send-failure"], [202, "send-failure"], [404, "send-failure"],
  ] as const)("does not resend failed or ambiguous reply POST %s, but deletes the known root", async (replyStatus, category) => {
    const { result, calls, telemetry } = await run({ replyStatus, attempts: 3 });
    expect(result).toMatchObject({ success: false, diagnosticCategory: category, sendDurationMs: 40 });
    expect(result.steps.map(step => step.status)).toEqual(["succeeded", "succeeded", "failed", "skipped", "failed"]);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(calls.map(call => [call.method, call.url])).toEqual([
      ["POST", `${serviceUrl}v3/conversations`], ["POST", activityUrl(rootActivityId)], ["DELETE", activityUrl(rootActivityId)],
    ]);
    expect(telemetry.emit).toHaveBeenCalledWith("probe-cleanup-failed", expect.objectContaining({ category: "cleanup-failure" }));
  });

  it.each([null, [], {}, { id: "" }, { id: 42 }, { id: " " }, { id: ".." }, { id: "\nunsafe" }, { id: "x".repeat(2049) }])(
    "reports unknown reply cleanup for malformed response %j", async replyBody => {
      const { result, calls } = await run({ replyBody });
      expect(result.diagnosticCategory).toBe("malformed-response");
      expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
      expect(calls.filter(call => call.method === "DELETE").map(call => call.url)).toEqual([activityUrl(rootActivityId)]);
    },
  );

  it.each(["invalid-json", "connection-lost"] as const)("does not retry an ambiguous reply %s or invent its cleanup ID", async failure => {
    const { result, calls } = await run({
      attempts: 3, invalidReplyJson: failure === "invalid-json", replyNetworkFailure: failure === "connection-lost",
    });
    expect(result.diagnosticCategory).toBe(failure === "invalid-json" ? "malformed-response" : "send-failure");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(2);
    expect(calls.filter(call => call.method === "DELETE").map(call => call.url)).toEqual([activityUrl(rootActivityId)]);
  });

  it("ignores response-supplied service URLs for reply and cleanup", async () => {
    const { result, calls } = await run({ replyBody: { id: replyActivityId, serviceUrl: "https://attacker.invalid/" } });
    expect(result.success).toBe(true);
    expect(calls.every(call => ["smba.trafficmanager.net", "graph.microsoft.com"].includes(new URL(call.url).hostname))).toBe(true);
  });

  it.each(["root", "reply"] as const)("categorizes %s Graph failures and still deletes both known activities", async activity => {
    for (const [status, category] of [[403, "permission-failure"], [429, "graph-throttling"], [503, "read-failure"]] as const) {
      const { result, calls } = await run({
        [activity === "root" ? "onRootRead" : "onReplyRead"]: () => new Response(null, { status }),
      });
      expect(result.diagnosticCategory).toBe(category);
      expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
      expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
    }
  });

  it.each([{ value: "not a list" }, { value: [{ id: "broken" }] }, { value: [], "@odata.nextLink": 7 }])(
    "rejects malformed reply JSON %j and still cleans up", async body => {
      const { result } = await run({ onReplyRead: () => json(body) });
      expect(result.diagnosticCategory).toBe("malformed-response");
      expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    },
  );

  it("rejects a non-JSON reply readback response", async () => {
    const { result } = await run({ onReplyRead: () => new Response("not JSON") });
    expect(result.diagnosticCategory).toBe("malformed-response");
  });

  it.each(["root", "reply"] as const)("fails the journey for %s cleanup failure and attempts both known activities", async activity => {
    const { result, calls } = await run({ cleanupStatus: { [activity]: 403 } });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "cleanup-failure", sendDurationMs: 40, publicationDurationMs: 80 });
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(calls.filter(call => call.method === "DELETE").map(call => call.url)).toEqual([
      activityUrl(replyActivityId), activityUrl(rootActivityId),
    ]);
  });

  it("treats already absent owned activities as cleaned up", async () => {
    const { result } = await run({ cleanupStatus: { reply: 404, root: 404 } });
    expect(result.success).toBe(true);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
  });

  it("retries only idempotent cleanup and still attempts root deletion after reply retries fail", async () => {
    const { result, calls } = await run({ attempts: 3, cleanupStatus: { reply: 503 } });
    expect(result.diagnosticCategory).toBe("cleanup-failure");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(2);
    expect(calls.filter(call => call.method === "DELETE").map(call => call.url)).toEqual([
      activityUrl(replyActivityId), activityUrl(replyActivityId), activityUrl(replyActivityId), activityUrl(rootActivityId),
    ]);
  });

  it("does not execute any request after preauthentication cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, calls } = await run({ controller });
    expect(result.diagnosticCategory).toBe("cancelled");
    expect(calls).toEqual([]);
  });

  it.each(["root", "reply"] as const)("cleans known IDs independently after cancellation at %s POST", async activity => {
    const controller = new AbortController();
    const cleanupSignals: (AbortSignal | null | undefined)[] = [];
    const { result, calls } = await run({
      controller, onPost: posted => { if (posted === activity) controller.abort(new Error("private cancellation")); },
      onCleanup: (_activity, signal) => { cleanupSignals.push(signal); },
    });
    expect(result.diagnosticCategory).toBe("cancelled");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(calls.filter(call => call.method === "GET")).toHaveLength(0);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(activity === "root" ? 1 : 2);
    expect(cleanupSignals.every(signal => signal && !signal.aborted && signal !== controller.signal)).toBe(true);
    if (activity === "root") expect(result.sendDurationMs).toBeUndefined();
  });

  it("does not accept an exact reply returned after caller cancellation", async () => {
    const controller = new AbortController();
    const { result, calls } = await run({
      controller,
      onReplyRead: ({ marker }) => {
        controller.abort(new Error("private cancellation reason"));
        return json({ value: [message(marker)] });
      },
    });
    expect(result.diagnosticCategory).toBe("cancelled");
    expect(result.publicationDurationMs).toBeUndefined();
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
  });

  it("does not post a reply when root setup exhausted the journey budget", async () => {
    const { result, calls } = await run({ timeoutMs: 50, rootMs: 60 });
    expect(result.diagnosticCategory).toBe("delivery-timeout");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(result.sendDurationMs).toBeUndefined();
    expect(calls.map(call => call.method)).toEqual(["POST", "DELETE"]);
  });

  it("preserves a read failure when reply cleanup throws and still tries the root", async () => {
    const { result, calls } = await run({
      onReplyRead: () => new Response(null, { status: 403 }),
      onCleanup: activity => { if (activity === "reply") throw new DOMException("cancelled cleanup", "AbortError"); },
    });
    expect(result.diagnosticCategory).toBe("permission-failure");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
  });

  it("bounds all cleanup by an independent ten-second budget after caller cancellation", async () => {
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
        controller, onPost: activity => { if (activity === "reply") controller.abort(); },
        onCleanup: async (activity, signal) => {
          if (activity !== "reply") return;
          if (!signal) throw new Error("missing cleanup budget");
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => { cleanupAborted = true; reject(signal.reason); }, { once: true });
          });
        },
      });
      await vi.advanceTimersByTimeAsync(9999);
      expect(cleanupAborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const { result } = await pending;
      expect(timeout).toHaveBeenCalledWith(10000);
      expect(cleanupAborted).toBe(true);
      expect(result.diagnosticCategory).toBe("cancelled");
      expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});
