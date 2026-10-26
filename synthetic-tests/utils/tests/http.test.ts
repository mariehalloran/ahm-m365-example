import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { GraphClient, graphNextPagePath } from "../src/graph.js";
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
  it("does not retry earlier than a long Retry-After, or retry permission failures", async () => {
    for (const status of [403, 429]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status, headers: { "retry-after": "3600" } }));
      await expect(new AuthenticatedHttp(credential, "scope", { fetch: fetcher }).request("https://example.test", {}, signal())).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("never sends Graph credentials to a OneDrive preauthenticated download URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://tenant.sharepoint.com/download" } }));
    const download = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"safe":true}'));
    const client = new GraphClient(new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), download);
    await expect(client.downloadContent("/drives/test/items/test/content", signal())).resolves.toEqual(Buffer.from('{"safe":true}'));
    expect(download.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });
  it("rejects redirects outside the OneDrive content hosts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://untrusted.test/download" } }));
    const download = vi.fn<typeof fetch>();
    const client = new GraphClient(new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), download);
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
    const client = new GraphClient(new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), download);
    await expect(client.downloadContent("/drives/test/items/test/content", signal())).rejects.toThrow("read-failure");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
