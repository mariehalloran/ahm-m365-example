import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { AhmSink } from "../src/ahm.js";
import type { HealthReport } from "../src/contracts.js";
import { GraphClient } from "../src/graph.js";
import { AuthenticatedHttp } from "../src/http.js";

const credential: TokenCredential = { getToken: async () => ({ token: "test-only-token", expiresOnTimestamp: Date.now() + 100000 }) };
const signal = () => AbortSignal.timeout(10000);
const now = Date.parse("2026-10-16T20:00:00Z");
const model = "/subscriptions/46433637-4539-481a-b054-e2c9f83ae51d/resourceGroups/m365-example/providers/Microsoft.CloudHealth/healthmodels/test-model";
const report: HealthReport = {
  entity: "exchange-global", signal: "synthetic-health", state: "Healthy",
  observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900000).toISOString(),
  context: { cycleId: "cycle", source: "synthetic" },
};

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

describe("real AHM wire contract", () => {
  it("posts the documented API shape with a bounded whole-minute TTL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const sink = new AhmSink(model, "2025-05-01-preview", new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), () => now + 1);
    await sink.submit(report, signal());
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://management.azure.com${model}/entities/exchange-global/ingestHealthReport?api-version=2025-05-01-preview`);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(Object.keys(body).sort()).toEqual(["additionalContext", "expiresInMinutes", "healthState", "signalName"]);
    expect(body).toMatchObject({ healthState: "Healthy", signalName: "synthetic-health", expiresInMinutes: 14 });
    expect(body.additionalContext).not.toContain("test-only-token");
  });
  it("submits Unknown instead of extending expired evidence", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const sink = new AhmSink(model, "2025-05-01-preview", new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), () => now + 900000);
    await sink.submit(report, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ healthState: "Unknown", expiresInMinutes: 1 });
  });
  it("does not extend freshness across the bounded request duration", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const sink = new AhmSink(model, "2025-05-01-preview", new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), () => now);
    await sink.submit(report, signal());
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.expiresInMinutes * 60000 + 15000).toBeLessThanOrEqual(900000);
    await sink.submit({ ...report, expiresAt: new Date(now + 74000).toISOString() }, signal());
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).healthState).toBe("Unknown");
  });
  it("treats a wrong response status as failed ingestion", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(new AhmSink(model, "2025-05-01-preview", new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), () => now)
      .submit(report, signal())).rejects.toThrow();
  });
});
