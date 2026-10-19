import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../src/graph.js";
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
  it("never sends Graph credentials to the SharePoint preauthenticated download URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://tenant.sharepoint.com/download" } }));
    const download = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"safe":true}'));
    const client = new GraphClient(new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), download);
    await expect(client.downloadJson("/drives/test/items/test/content", signal())).resolves.toEqual({ safe: true });
    expect(download.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });
  it("rejects non-SharePoint redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://untrusted.test/download" } }));
    const download = vi.fn<typeof fetch>();
    const client = new GraphClient(new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), download);
    await expect(client.downloadJson("/drives/test/items/test/content", signal())).rejects.toThrow();
    expect(download).not.toHaveBeenCalled();
  });
});
