import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../utils/src/config.js";
import { resultSchema, type Probe } from "../../utils/src/contracts.js";
import { GraphClient } from "../../utils/src/graph.js";
import { AuthenticatedHttp } from "../../utils/src/http.js";
import { exchangeProbe } from "../src/journey.js";
import { authenticate, cleanup, confirmDelivery, createDraft, sendMessage, type MailAttempt } from "../src/steps.js";

const credential: TokenCredential = { getToken: async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 100000 }) };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const mailbox = "dedicated-synthetic@example.invalid";
const exchange: Probe = { id: "exchange-001", cohort: "exchange-global", type: "exchange-mail-flow", mailbox };
const config = loadConfig({ PROBE_TIMEOUT_MS: "120000" });
const telemetry = { emit: vi.fn() };

async function exchangeRun(options: { deliveryAfter?: number; sendDurationMs?: number; fail?: "permission" | "send" | "read" | "cleanup" | "throttle"; authFail?: boolean; cleanupEnabled?: boolean } = {}) {
  let time = Date.parse("2026-10-16T20:00:00Z");
  let polls = 0;
  let sentSubject = "";
  const calls: { url: string; method: string }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: path, method });
    if (method === "POST" && path.endsWith("/messages")) {
      if (options.fail === "permission") return new Response(null, { status: 403 });
      if (options.fail === "throttle") return new Response(null, { status: 429 });
      sentSubject = JSON.parse(String(init?.body)).subject;
      return json({ id: "draft-immutable" });
    }
    if (path.endsWith("/send")) {
      time += options.sendDurationMs ?? 0;
      return new Response(null, { status: options.fail === "send" ? 503 : 202 });
    }
    if (path.includes("/mailFolders/inbox/")) {
      if (options.fail === "read") return new Response(null, { status: 503 });
      return json({ value: ++polls >= (options.deliveryAfter ?? 1) ? [{ id: "received-immutable" }] : [] });
    }
    if (method === "DELETE") return new Response(null, { status: options.fail === "cleanup" ? 403 : 204 });
    if (method === "GET" && path.includes("/messages?")) return json({ value: sentSubject ? [{ id: "sent-immutable" }] : [] });
    throw new Error("Unexpected Graph request");
  });
  const identity = options.authFail ? { getToken: async () => { throw new Error("private auth error"); } } : credential;
  const graph = new GraphClient(new AuthenticatedHttp(identity, "scope", { fetch: fetcher, attempts: 1 }));
  const result = await exchangeProbe(exchange, {
    config: { ...config, EXCHANGE_CLEANUP_ENABLED: options.cleanupEnabled === false ? "false" : "true" },
    graph, telemetry, signal: AbortSignal.timeout(10000), now: () => time,
    sleep: async ms => { time += ms; },
  });
  return { result, calls, sentSubject, time };
}

describe("Exchange send/poll/cleanup", () => {
  it.each([undefined, "send", "read"] as const)("retains all mail copies without cleanup/reconciliation after %s", async fail => {
    const { result, calls } = await exchangeRun({ cleanupEnabled: false, ...(fail ? { fail } : {}) });
    expect(resultSchema.safeParse(result).success).toBe(true);
    expect(result.success).toBe(fail === undefined);
    expect(result.steps.at(-1)).toMatchObject({ name: "cleanup", status: "skipped", reason: "cleanup-disabled" });
    expect(result.steps.at(-1)).not.toHaveProperty("durationMs");
    expect(result.diagnosticContext).not.toHaveProperty("cleanupSucceeded");
    expect(calls.some(call => call.method === "DELETE")).toBe(false);
    expect(calls.filter(call => call.method === "GET").every(call => call.url.includes("/mailFolders/inbox/"))).toBe(true);
    expect(telemetry.emit).toHaveBeenCalledWith("exchange-cleanup-disabled", expect.objectContaining({
      mode: "live", mutationAttempted: true,
    }));
  });
  it("exposes independently callable authentication, draft, send, delivery and cleanup actions", async () => {
    const calls: string[] = [];
    const graph = new GraphClient(new AuthenticatedHttp(credential, "https://graph.microsoft.com/.default", {
      attempts: 1, fetch: async (url, init) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${new URL(String(url)).pathname}`);
        if (method === "POST" && String(url).endsWith("/messages")) return json({ id: "direct-draft" });
        if (String(url).endsWith("/send")) return new Response(null, { status: 202 });
        if (method === "GET") return json({ value: [{ id: "direct-received" }] });
        return new Response(null, { status: 204 });
      },
    }));
    const attempt: MailAttempt = {
      mailbox, correlationId: "11111111-1111-4111-8111-111111111111", ownedMessageIds: new Set(), mutationAttempted: false,
    };
    const signal = new AbortController().signal;
    expect(await authenticate(graph, signal)).toBe(graph);
    const draft = await createDraft(graph, attempt, signal);
    expect(draft).toBe("direct-draft");
    await sendMessage(graph, attempt, draft, signal);
    await confirmDelivery(graph, attempt, signal, 2000, 10, () => 1000);
    await cleanup(graph, attempt, signal);
    expect(calls.map(call => call.split(" ")[0])).toEqual(["POST", "POST", "GET", "GET", "DELETE", "DELETE"]);
    expect(attempt.ownedMessageIds).toEqual(new Set(["direct-draft", "direct-received"]));
  });
  it("sends a unique dedicated message, confirms delivery and deletes only its copies", async () => {
    const { result, calls, sentSubject } = await exchangeRun();
    expect(resultSchema.safeParse(result).success).toBe(true);
    expect(result.success).toBe(true);
    expect(result.steps.map(step => [step.name, step.status])).toEqual([
      ["authenticate", "succeeded"], ["create-draft", "succeeded"], ["send", "succeeded"],
      ["confirm-delivery", "succeeded"], ["cleanup", "succeeded"],
    ]);
    expect(sentSubject).toBe(`AHM synthetic ${result.correlationId}`);
    expect(result.diagnosticContext).toMatchObject({ testStage: "delivery-confirmed", cleanupSucceeded: true });
    expect(calls.filter(call => call.method === "DELETE").map(call => call.url.split("/").at(-1)).sort())
      .toEqual(["draft-immutable", "received-immutable", "sent-immutable"]);
    expect(JSON.stringify(result)).not.toContain(mailbox);
    expect(JSON.stringify(result)).not.toContain(sentSubject);
  });
  it("measures slow delivery", async () => {
    const { result } = await exchangeRun({ deliveryAfter: 10 });
    expect(result.durationMs).toBe(18000);
    expect(result.deliveryDurationMs).toBe(18000);
  });
  it("measures the send request separately from waiting for Inbox delivery", async () => {
    const { result } = await exchangeRun({ sendDurationMs: 250, deliveryAfter: 3 });
    expect(resultSchema.safeParse(result).success).toBe(true);
    expect(result.sendDurationMs).toBe(250);
    expect(result.deliveryDurationMs).toBe(4250);
    expect(result.durationMs).toBe(4250);
  });
  it("retains failed send request timing without inventing a delivery measurement", async () => {
    const { result } = await exchangeRun({ sendDurationMs: 250, fail: "send" });
    expect(resultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      success: false,
      diagnosticCategory: "send-failure",
      sendDurationMs: 250,
      durationMs: 250,
    });
    expect(result.deliveryDurationMs).toBeUndefined();
    expect(result.steps.map(step => [step.name, step.status])).toEqual([
      ["authenticate", "succeeded"], ["create-draft", "succeeded"], ["send", "failed"],
      ["confirm-delivery", "skipped"], ["cleanup", "succeeded"],
    ]);
  });
  it("times out delivery and still attempts bounded cleanup", async () => {
    const { result, calls } = await exchangeRun({ deliveryAfter: 100 });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout", durationMs: 120000 });
    expect(result.deliveryDurationMs).toBeUndefined();
    expect(calls.some(call => call.method === "DELETE")).toBe(true);
  });
  it.each([
    ["permission", "permission-failure"], ["send", "send-failure"], ["read", "read-failure"],
    ["cleanup", "cleanup-failure"], ["throttle", "graph-throttling"],
  ] as const)("categorizes %s failure", async (fail, expected) => {
    const { result, calls } = await exchangeRun({ fail });
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe(expected);
    const step = fail === "permission" || fail === "throttle" ? "create-draft"
      : fail === "send" ? "send" : fail === "read" ? "confirm-delivery" : "cleanup";
    expect(result.steps.find(item => item.name === step)).toMatchObject({ status: "failed", diagnosticCategory: expected });
    if (step === "create-draft") {
      expect(calls.some(call => call.url.endsWith("/send") || call.url.includes("/inbox/"))).toBe(false);
      expect(result.steps.find(item => item.name === "send")?.status).toBe("skipped");
    }
    if (step === "cleanup") {
      expect(result.steps.slice(0, -1).every(item => item.status === "succeeded")).toBe(true);
    }
  });
  it("does not query or mutate a mailbox if authentication never succeeded", async () => {
    const { result, calls } = await exchangeRun({ authFail: true });
    expect(result.diagnosticCategory).toBe("authentication-failure");
    expect(calls).toEqual([]);
    expect(result.steps.map(step => step.status)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped"]);
  });
  it("reports missing selected mailbox setup as configuration failure without Graph calls", async () => {
    const graph = { authenticate: vi.fn(), json: vi.fn(), request: vi.fn() } as unknown as GraphClient;
    const { mailbox: _mailbox, ...missingMailbox } = exchange;
    const result = await exchangeProbe(missingMailbox, { config, graph, telemetry, signal: new AbortController().signal });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "configuration-failure" });
    expect(graph.authenticate).not.toHaveBeenCalled();
    expect(graph.json).not.toHaveBeenCalled();
    expect(graph.request).not.toHaveBeenCalled();
  });
  it.each(["sender-discovery", "recipient-discovery", "sender-delete", "recipient-delete"] as const)(
    "continues independent discovery and all known owned-copy deletions after %s fails", async failure => {
      const recipientMailbox = "recipient@example.invalid";
      const calls: { path: string; method: string }[] = [];
      const graph = new GraphClient(new AuthenticatedHttp(credential, "https://graph.microsoft.com/.default", {
        attempts: 1, fetch: async (url, init) => {
          const path = new URL(String(url));
          const method = init?.method ?? "GET";
          calls.push({ path: path.pathname, method });
          const participant = path.pathname.includes(encodeURIComponent(recipientMailbox)) ? "recipient" : "sender";
          if (method === "GET") {
            if (failure === `${participant}-discovery`) return new Response(null, { status: 403 });
            return json({ value: [{ id: `${participant}-copy` }] });
          }
          if (failure === `${participant}-delete`) return new Response(null, { status: 403 });
          return new Response(null, { status: 204 });
        },
      }));
      await expect(cleanup(graph, {
        mailbox, recipientMailbox, correlationId: "11111111-1111-4111-8111-111111111111",
        mutationAttempted: true, ownedMessageIds: new Set(["known-draft"]), deliveredMessageIds: new Set(["known-delivery"]),
      }, new AbortController().signal)).rejects.toMatchObject({ category: "cleanup-failure" });
      expect(calls.filter(call => call.method === "GET")).toHaveLength(2);
      const deletions = calls.filter(call => call.method === "DELETE").map(call => call.path);
      expect(deletions).toContain(`/v1.0/users/${encodeURIComponent(mailbox)}/messages/known-draft`);
      expect(deletions).toContain(`/v1.0/users/${encodeURIComponent(recipientMailbox)}/messages/known-delivery`);
      if (failure !== "sender-discovery") expect(deletions.some(path => path.endsWith("/sender-copy"))).toBe(true);
      if (failure !== "recipient-discovery") expect(deletions.some(path => path.endsWith("/recipient-copy"))).toBe(true);
    },
  );
  it("cleans known first-page copies but reports incomplete discovery without following continuation", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : json({ value: [{ id: "owned-copy" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/unapproved/messages" }));
    const graph = new GraphClient(new AuthenticatedHttp(credential, "https://graph.microsoft.com/.default", { attempts: 1, fetch: fetcher }));
    await expect(cleanup(graph, {
      mailbox, correlationId: "11111111-1111-4111-8111-111111111111",
      mutationAttempted: true, ownedMessageIds: new Set(["known-draft"]),
    }, new AbortController().signal)).rejects.toMatchObject({ category: "cleanup-failure" });
    expect(fetcher.mock.calls.map(([url, init]) => [String(url).split("/").at(-1), init?.method])).toEqual([
      [expect.stringContaining("messages?"), "GET"], ["known-draft", "DELETE"], ["owned-copy", "DELETE"],
    ]);
  });
  it("tracks and cleans self-delivery once when recipient casing differs", async () => {
    const graph = {
      json: vi.fn().mockResolvedValue({ value: [{ id: "owned-delivery" }] }),
      request: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    } as unknown as GraphClient;
    const attempt: MailAttempt = {
      mailbox, recipientMailbox: mailbox.toUpperCase(), correlationId: "11111111-1111-4111-8111-111111111111",
      mutationAttempted: true, ownedMessageIds: new Set(),
    };
    const signal = new AbortController().signal;
    await confirmDelivery(graph, attempt, signal, 2000, 10, () => 1000);
    expect(attempt.ownedMessageIds).toEqual(new Set(["owned-delivery"]));
    expect(attempt.deliveredMessageIds).toBeUndefined();
    await cleanup(graph, attempt, signal);
    expect(graph.json).toHaveBeenCalledTimes(2);
    expect(graph.request).toHaveBeenCalledTimes(1);
  });
  it("starts every attempt with a fresh run marker and no cycle history", async () => {
    const first = await exchangeRun();
    const second = await exchangeRun();
    expect(first.result.success).toBe(true);
    expect(second.result.success).toBe(true);
    expect(first.result.correlationId).not.toBe(second.result.correlationId);
    expect(first.sentSubject).not.toBe(second.sentSubject);
    const queries = second.calls.map(call => new URL(call.url)).filter(url => url.searchParams.has("$filter"));
    expect(queries).toHaveLength(2);
    expect(queries.every(url => url.searchParams.get("$filter") === `subject eq '${second.sentSubject}'`)).toBe(true);
  });
  it.each([false, true])("excludes authentication/draft/cleanup from delivery, includes cleanup in total (cleanup failure=%s)", async cleanupFails => {
    let clock = 1000;
    const graph = {
      authenticate: vi.fn(async () => { clock += 100; }),
      json: vi.fn(async (path: string) => {
        if (path.endsWith("/messages")) { clock += 200; return { id: "draft" }; }
        if (path.includes("/inbox/")) { clock += 400; return { value: [{ id: "received" }] }; }
        clock += 500;
        return { value: [{ id: "sent" }] };
      }),
      request: vi.fn(async (path: string) => {
        if (path.endsWith("/send")) clock += 300;
        else {
          clock += 50;
          if (cleanupFails) throw new Error("private cleanup error");
        }
        return new Response(null, { status: 204 });
      }),
    } as unknown as GraphClient;
    const result = await exchangeProbe(exchange, { config, graph, telemetry, signal: new AbortController().signal, now: () => clock });
    expect(resultSchema.safeParse(result).success).toBe(true);
    expect(result.deliveryDurationMs).toBe(700);
    expect(result.sendDurationMs).toBe(300);
    expect(result.diagnosticContext.authenticationDurationMs).toBe(100);
    expect(result.durationMs).toBe(1650);
    expect(result.observedAt).toBe(new Date(clock).toISOString());
    expect(result.success).toBe(!cleanupFails);
    expect(result.diagnosticCategory).toBe(cleanupFails ? "cleanup-failure" : null);
  });
  it("measures authentication failure without claiming delivery or mutating a mailbox", async () => {
    let clock = 1000;
    const graph = {
      authenticate: vi.fn(async () => { clock += 200; throw new Error("private auth error"); }),
      request: vi.fn(), json: vi.fn(),
    } as unknown as GraphClient;
    const result = await exchangeProbe(exchange, { config, graph, telemetry, signal: new AbortController().signal, now: () => clock });
    expect(result.durationMs).toBe(200);
    expect(result.deliveryDurationMs).toBeUndefined();
    expect(result.sendDurationMs).toBeUndefined();
    expect(graph.request).not.toHaveBeenCalled();
    expect(graph.json).not.toHaveBeenCalled();
  });
});
