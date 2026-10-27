import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GraphClient, graphNextPagePath, type GraphApiVersion } from "../src/graph.js";
import { AuthenticatedHttp } from "../src/http.js";

const credential: TokenCredential = { getToken: async () => ({ token: "test-only-token", expiresOnTimestamp: Date.now() + 100000 }) };
const signal = () => AbortSignal.timeout(10000);

describe("bounded HTTP", () => {
  it("retries safe reads on throttling and temporary failure", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("ok"));
    const sleep = vi.fn(async () => undefined);
    await new AuthenticatedHttp(credential, "scope", { fetch: fetcher, sleep }).request("https://example.test", {}, signal());
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
  it("does not resend an ambiguous mail send", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network"));
    await expect(new AuthenticatedHttp(credential, "scope", { fetch: fetcher }).request("https://example.test", { method: "POST" }, signal(), false))
      .rejects.toMatchObject({ category: "graph-unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves an already completed write response for cleanup when cancellation races it", async () => {
    const controller = new AbortController();
    const response = Response.json({ id: "owned-resource" }, { status: 201 });
    const fetcher = vi.fn<typeof fetch>(async () => {
      controller.abort();
      return response;
    });
    const http = new AuthenticatedHttp(credential, "scope", { fetch: fetcher });
    await expect(http.request("https://example.test", { method: "POST" }, controller.signal, false)).resolves.toBe(response);
    await expect(response.json()).resolves.toEqual({ id: "owned-resource" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not retry earlier than a long Retry-After, or retry permission failures", async () => {
    for (const status of [403, 429]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status, headers: { "retry-after": "3600" } }));
      await expect(new AuthenticatedHttp(credential, "scope", { fetch: fetcher }).request("https://example.test", {}, signal())).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("lets bulk setup honor longer throttling delays, including explicitly rejected writes", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "45" } }))
      .mockResolvedValueOnce(new Response("created", { status: 201 }));
    const sleep = vi.fn(async () => undefined);
    const http = new AuthenticatedHttp(credential, "scope", {
      fetch: fetcher, sleep, timeoutMs: 300000, maxRetryDelayMs: 60000, retryThrottledWrites: true,
    });
    await expect(http.request("https://example.test", { method: "POST" }, signal(), false)).resolves.toHaveProperty("status", 201);
    expect(sleep).toHaveBeenCalledWith(45000, expect.any(AbortSignal));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["network", "503"])("never retries an ambiguous %s write even with bulk throttling retries enabled", async failure => {
    const fetcher = vi.fn<typeof fetch>();
    if (failure === "network") fetcher.mockRejectedValue(new TypeError("network"));
    else fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    const http = new AuthenticatedHttp(credential, "scope", { fetch: fetcher, retryThrottledWrites: true });
    await expect(http.request("https://example.test", { method: "POST" }, signal(), false)).rejects.toThrow("graph-unavailable");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("never sends Graph credentials to a OneDrive preauthenticated download URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://tenant.sharepoint.com/download" } }));
    const download = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"safe":true}'));
    const client = new GraphClient(credential, { fetch: fetcher, downloadFetch: download });
    await expect(client.downloadContent("/drives/test/items/test/content", signal())).resolves.toEqual(Buffer.from('{"safe":true}'));
    expect(download.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });
  it("rejects redirects outside the OneDrive content hosts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://untrusted.test/download" } }));
    const download = vi.fn<typeof fetch>();
    const client = new GraphClient(credential, { fetch: fetcher, downloadFetch: download });
    await expect(client.downloadContent("/drives/test/items/test/content", signal())).rejects.toThrow();
    expect(download).not.toHaveBeenCalled();
  });
  it("accepts continuation only within the exact approved Graph collection", () => {
    expect(graphNextPagePath(
      "https://graph.microsoft.com/v1.0/sites/approved/drives?$skiptoken=next",
      "/sites/approved/drives",
    )).toBe("/sites/approved/drives?$skiptoken=next");
    for (const url of [
      "https://untrusted.invalid/v1.0/sites/approved/drives",
      "http://graph.microsoft.com/v1.0/sites/approved/drives",
      "https://graph.microsoft.com/v1.0/sites/other/drives",
      "https://graph.microsoft.com/v1.0/users",
      "not-a-url",
    ]) {
      expect(() => graphNextPagePath(url, "/sites/approved/drives")).toThrow("read-failure");
    }
  });
  it("cancels an oversized streamed download before accepting unbounded content", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: "https://tenant.sharepoint.com/download" },
    }));
    const cancel = vi.fn();
    const download = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4097)); },
      cancel,
    })));
    const client = new GraphClient(credential, { fetch: fetcher, downloadFetch: download });
    await expect(client.downloadContent("/drives/test/items/test/content", signal())).rejects.toThrow("read-failure");
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("Graph SDK transport", () => {
  it("uses Azure Identity and SDK requests without changing JSON, version, headers or missing-resource semantics", async () => {
    const getToken = vi.fn(credential.getToken);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ value: 0 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const graph = new GraphClient({ getToken }, { fetch: fetcher });
    await expect(graph.json("/reports/test", z.object({ value: z.number() }), signal(), "POST", { selected: true }, false, "beta"))
      .resolves.toEqual({ value: 0 });
    expect(fetcher.mock.calls[0]).toEqual([
      "https://graph.microsoft.com/beta/reports/test",
      expect.objectContaining({
        method: "POST", body: '{"selected":true}', redirect: "error", signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          Authorization: "Bearer test-only-token", "Content-Type": "application/json", Prefer: 'IdType="ImmutableId"',
        }),
      }),
    ]);
    expect(getToken).toHaveBeenCalledWith(["https://graph.microsoft.com/.default"], { abortSignal: expect.any(AbortSignal) });
    await expect(graph.request("/missing", signal())).rejects.toMatchObject({ category: "read-failure", status: 404 });
    await expect(graph.request("/missing", signal(), "DELETE")).resolves.toHaveProperty("status", 404);
  });

  it.each([429, 502, 503, 504, "network"] as const)("retries a safe %s read once through the shared policy and discards failed bodies", async failure => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>();
    if (failure === "network") fetcher.mockRejectedValueOnce(new TypeError("private network error"));
    else fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), {
      status: failure, headers: { "retry-after": "0.5" },
    }));
    const success = new Response("ok", { headers: { "request-id": "actual-response" } });
    fetcher.mockResolvedValueOnce(success);
    const sleep = vi.fn(async () => undefined);
    const graph = new GraphClient(credential, { fetch: fetcher, sleep, attempts: 2 });
    await expect(graph.request("/users", signal())).resolves.toBe(success);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(failure === "network" ? 250 : 500, expect.any(AbortSignal));
    if (failure !== "network") expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([429, 502, 503, 504, "network"] as const)("never lets SDK defaults resend an unsafe %s mutation", async failure => {
    const fetcher = vi.fn<typeof fetch>();
    if (failure === "network") fetcher.mockRejectedValue(new Error("private network details"));
    else fetcher.mockImplementation(async () => new Response("private response", { status: failure }));
    const sleep = vi.fn(async () => undefined);
    const graph = new GraphClient(credential, { fetch: fetcher, sleep, attempts: 5 });
    for (const path of ["/users/test/messages/draft/send", "/communications/calls", "/users/test/events"]) {
      await expect(graph.request(path, signal(), "POST", {}, false)).rejects.toMatchObject({
        category: failure === 429 ? "graph-throttling" : "graph-unavailable",
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retains setup-only retries for explicitly throttled writes, never ambiguous failures", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "45" } }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError("private network error"));
    const sleep = vi.fn(async () => undefined);
    const graph = new GraphClient(credential, {
      fetch: fetcher, sleep, attempts: 5, maxRetryDelayMs: 60000, retryThrottledWrites: true,
    });
    await expect(graph.request("/drives/test/root/children", signal(), "POST", {}, false)).resolves.toHaveProperty("status", 201);
    await expect(graph.request("/drives/test/root/children", signal(), "POST", {}, false)).rejects.toMatchObject({ status: 503 });
    await expect(graph.request("/drives/test/root/children", signal(), "POST", {}, false)).rejects.toMatchObject({ category: "graph-unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(45000, expect.any(AbortSignal));
  });

  it("bounds shared retries and never truncates an excessive numeric or HTTP-date Retry-After", async () => {
    for (const header of ["3600", new Date(Date.now() + 3600000).toUTCString()]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": header } }));
      const sleep = vi.fn(async () => undefined);
      await expect(new GraphClient(credential, { fetch: fetcher, sleep }).request("/users", signal()))
        .rejects.toMatchObject({ category: "graph-throttling", status: 429 });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 502 }));
    const sleep = vi.fn(async () => undefined);
    await expect(new GraphClient(credential, { fetch: fetcher, sleep, attempts: 2 }).request("/users", signal()))
      .rejects.toMatchObject({ category: "graph-unavailable", status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(250, expect.any(AbortSignal));
  });

  it("honors exact HTTP-date retry delays without rounding or delay clamping", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-27T15:00:00.500Z"));
    try {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 503, headers: { "retry-after": "Tue, 27 Oct 2026 15:00:03 GMT" } }))
        .mockResolvedValueOnce(new Response("ok"));
      const sleep = vi.fn(async () => undefined);
      await new GraphClient(credential, { fetch: fetcher, sleep }).request("/users", signal());
      expect(sleep).toHaveBeenCalledExactlyOnceWith(2500, expect.any(AbortSignal));
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  it("preserves cancellation during shared retry waits without another send", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    const graph = new GraphClient(credential, {
      fetch: fetcher, sleep: async (_ms, bounded) => { controller.abort(reason); bounded.throwIfAborted(); },
    });
    await expect(graph.request("/users", controller.signal)).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("bounds even stalled credentials and response streams, preserving deadline classifications", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const stalledCredential: TokenCredential = { getToken: () => new Promise(() => undefined) };
    const graph = new GraphClient(stalledCredential, { fetch: fetcher, timeoutMs: 10 });
    await expect(graph.authenticate(signal())).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetcher).not.toHaveBeenCalled();
    const cancel = vi.fn();
    fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    await expect(new GraphClient(credential, { fetch: fetcher, timeoutMs: 10 }).json("/users", z.object({}), signal()))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps bounded streaming and Zod validation outside the SDK's unbounded response parser", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(stream) { stream.enqueue(new Uint8Array(33)); }, cancel,
      })))
      .mockResolvedValueOnce(Response.json({ value: "invalid" }));
    const graph = new GraphClient(credential, { fetch: fetcher });
    await expect(graph.json("/users", z.object({ value: z.number() }), signal(), "GET", undefined, true, "v1.0", 32))
      .rejects.toMatchObject({ category: "malformed-response" });
    expect(cancel).toHaveBeenCalledOnce();
    await expect(graph.json("/users", z.object({ value: z.number() }), signal()))
      .rejects.toMatchObject({ category: "malformed-response" });
  });

  it.each([
    ["//untrusted.invalid/users", "v1.0"], ["/../beta/users", "v1.0"], ["/%2e%2e/beta/users", "v1.0"],
    ["/users\\other", "v1.0"], ["/users#fragment", "v1.0"], ["/users\r\n", "v1.0"], ["/users", "v2"],
  ])("rejects unsafe SDK paths/versions before authentication: %s %s", async (path, version) => {
    const getToken = vi.fn(credential.getToken);
    const fetcher = vi.fn<typeof fetch>();
    const graph = new GraphClient({ getToken }, { fetch: fetcher });
    await expect(graph.request(path!, signal(), "GET", undefined, true, version as GraphApiVersion))
      .rejects.toMatchObject({ category: "collector-failure" });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not enable the SDK redirect handler for authenticated requests", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: "https://untrusted.invalid/private" },
    }));
    await expect(new GraphClient(credential, { fetch: fetcher }).request("/users", signal()))
      .rejects.toMatchObject({ category: "graph-unavailable", status: 302 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
});

describe("shared Graph and ARM/Bot retry deadlines", () => {
  it.each(["graph", "arm"] as const)("cancels a %s retry wait even when a sleep hook ignores its signal", async kind => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    let started: () => void = () => undefined;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const sleep = vi.fn(() => {
      started();
      return new Promise<void>(() => undefined);
    });
    const options = { fetch: fetcher, sleep };
    const request = kind === "graph"
      ? new GraphClient(credential, options).request("/users", controller.signal)
      : new AuthenticatedHttp(credential, "https://management.azure.com/.default", options)
        .request("https://management.azure.com/resource", { redirect: "error" }, controller.signal);
    const cancelled = expect(request).rejects.toBe(reason);
    await waiting;
    controller.abort(reason);
    await cancelled;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["graph", "arm"] as const)("bounds a stalled %s fetch without retries or manufactured responses", async kind => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const sleep = vi.fn(async () => undefined);
    const options = { fetch: fetcher, sleep, timeoutMs: 10, attempts: 5 };
    const request = kind === "graph"
      ? new GraphClient(credential, options).request("/users", signal())
      : new AuthenticatedHttp(credential, "https://management.azure.com/.default", options)
        .request("https://management.azure.com/resource", { redirect: "error" }, signal());
    await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
