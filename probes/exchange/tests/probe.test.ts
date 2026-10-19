import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../runner/src/config.js";
import { resultSchema, type Probe } from "../../../shared/src/contracts.js";
import { GraphClient } from "../../../shared/src/graph.js";
import { AuthenticatedHttp } from "../../../shared/src/http.js";
import { individualState } from "../../../health-model/src/policy.js";
import { exchangeProbe } from "../src/probe.js";

const credential: TokenCredential = { getToken: async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 100000 }) };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const mailbox = "dedicated-synthetic@example.invalid";
const exchange: Probe = { id: "exchange-001", cohort: "exchange-global", type: "exchange-mail-flow", mailbox };
const config = loadConfig({ PROBE_TIMEOUT_MS: "120000" });
const telemetry = { emit: vi.fn() };

async function exchangeRun(options: { deliveryAfter?: number; fail?: "permission" | "send" | "read" | "cleanup" | "throttle"; authFail?: boolean } = {}) {
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
    if (path.endsWith("/send")) return new Response(null, { status: options.fail === "send" ? 503 : 202 });
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
    config, graph, telemetry, signal: AbortSignal.timeout(10000), now: () => time,
    sleep: async ms => { time += ms; },
  });
  return { result, calls, sentSubject, time };
}

describe("Exchange send/poll/cleanup", () => {
  it("sends a unique dedicated message, confirms delivery and deletes only its copies", async () => {
    const { result, calls, sentSubject } = await exchangeRun();
    expect(resultSchema.safeParse(result).success).toBe(true);
    expect(result.success).toBe(true);
    expect(sentSubject).toBe(`AHM synthetic ${result.correlationId}`);
    expect(result.diagnosticContext).toMatchObject({ testStage: "delivery-confirmed", cleanupSucceeded: true });
    expect(calls.filter(call => call.method === "DELETE").map(call => call.url.split("/").at(-1)).sort())
      .toEqual(["draft-immutable", "received-immutable", "sent-immutable"]);
    expect(JSON.stringify(result)).not.toContain(mailbox);
    expect(JSON.stringify(result)).not.toContain(sentSubject);
  });
  it("measures slow delivery", async () => {
    const { result, time } = await exchangeRun({ deliveryAfter: 10 });
    expect(result.durationMs).toBe(18000);
    expect(individualState(result, config, time)).toBe("Degraded");
  });
  it("times out delivery and still attempts bounded cleanup", async () => {
    const { result, calls } = await exchangeRun({ deliveryAfter: 100 });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout", durationMs: 60000 });
    expect(calls.some(call => call.method === "DELETE")).toBe(true);
  });
  it.each([
    ["permission", "permission-failure"], ["send", "send-failure"], ["read", "read-failure"],
    ["cleanup", "cleanup-failure"], ["throttle", "graph-throttling"],
  ] as const)("categorizes %s failure", async (fail, expected) => {
    const { result } = await exchangeRun({ fail });
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe(expected);
  });
  it("does not query or mutate a mailbox if authentication never succeeded", async () => {
    const { result, calls } = await exchangeRun({ authFail: true });
    expect(result.diagnosticCategory).toBe("authentication-failure");
    expect(calls).toEqual([]);
  });
});
