import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import type { HealthReport } from "../../shared/src/contracts.js";
import { AuthenticatedHttp } from "../../shared/src/http.js";
import { loadConfig } from "../../runner/src/config.js";
import { AhmSink } from "../src/ahm.js";

const credential: TokenCredential = { getToken: async () => ({ token: "test-only-token", expiresOnTimestamp: Date.now() + 100000 }) };
const signal = () => AbortSignal.timeout(10000);
const now = Date.parse("2026-10-16T20:00:00Z");
const model = `/subscriptions/${crypto.randomUUID()}/resourceGroups/m365-example/providers/Microsoft.CloudHealth/healthmodels/test-model`;
const apiVersion = loadConfig({}).AHM_API_VERSION;
const report: HealthReport = {
  entity: "exchange-global", signal: "synthetic-health", state: "Healthy",
  observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900000).toISOString(),
  context: { cycleId: "cycle", source: "synthetic" },
};

describe("real AHM wire contract", () => {
  it("posts the documented API shape with a bounded whole-minute TTL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const sink = new AhmSink(model, apiVersion, new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), () => now + 1);
    await sink.submit(report, signal());
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://management.azure.com${model}/entities/exchange-global/ingestHealthReport?api-version=${apiVersion}`);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(Object.keys(body).sort()).toEqual(["additionalContext", "expiresInMinutes", "healthState", "signalName"]);
    expect(body).toMatchObject({ healthState: "Healthy", signalName: "synthetic-health", expiresInMinutes: 14 });
    expect(body.additionalContext).not.toContain("test-only-token");
  });
  it("submits Unknown instead of extending expired evidence", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const sink = new AhmSink(model, apiVersion, new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), () => now + 900000);
    await sink.submit(report, signal());
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ healthState: "Unknown", expiresInMinutes: 1 });
  });
  it("does not extend freshness across the bounded request duration", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const sink = new AhmSink(model, apiVersion, new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), () => now);
    await sink.submit(report, signal());
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.expiresInMinutes * 60000 + 15000).toBeLessThanOrEqual(900000);
    await sink.submit({ ...report, expiresAt: new Date(now + 74000).toISOString() }, signal());
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).healthState).toBe("Unknown");
  });
  it("treats a wrong response status as failed ingestion", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(new AhmSink(model, apiVersion, new AuthenticatedHttp(credential, "scope", { fetch: fetcher }), () => now)
      .submit(report, signal())).rejects.toThrow();
  });
});
