import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../runner/src/config.js";
import { resultSchema, type Probe } from "../../../shared/src/contracts.js";
import { GraphClient } from "../../../shared/src/graph.js";
import { AuthenticatedHttp } from "../../../shared/src/http.js";
import { sharepointProbe } from "../src/probe.js";

const credential: TokenCredential = { getToken: async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 100000 }) };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const config = loadConfig({ PROBE_TIMEOUT_MS: "120000" });
const telemetry = { emit: vi.fn() };

describe("SharePoint dedicated file journey", () => {
  const probe: Probe = { id: "sharepoint-001", type: "sharepoint-file", cohort: "sharepoint-global", siteId: "site-approved", driveId: "drive-approved", folderId: "folder-approved" };
  it("validates site ownership, uploads, verifies and deletes a uniquely named file", async () => {
    let content = "";
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.includes("/sites/")) return json({ value: [{ id: probe.driveId }] });
      if (init?.method === "PUT") {
        content = String(init.body);
        const name = new URL(path).pathname.split(":/")[1];
        return json({ id: "owned-file", name });
      }
      if (path.endsWith("/content")) return new Response(null, { status: 302, headers: { location: "https://example.sharepoint.com/approved-download" } });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error("Unexpected request");
    });
    const download = vi.fn<typeof fetch>(async () => new Response(content));
    const graph = new GraphClient(new AuthenticatedHttp(credential, "scope", { fetch: fetcher, attempts: 1 }), download);
    const result = await sharepointProbe(probe, { config, graph, telemetry, signal: AbortSignal.timeout(10000) });
    expect(result.success).toBe(true);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(JSON.stringify(result)).not.toContain("owned-file");
  });
  it("does not mutate a drive outside the approved site", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ value: [{ id: "different-drive" }] }));
    const graph = new GraphClient(new AuthenticatedHttp(credential, "scope", { fetch: fetcher, attempts: 1 }));
    const result = await sharepointProbe(probe, { config, graph, telemetry, signal: AbortSignal.timeout(10000) });
    expect(result.diagnosticCategory).toBe("permission-failure");
    expect(fetcher.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
  });
  it.each([false, true])("includes upload/download/cleanup in total duration (cleanup failure=%s)", async cleanupFails => {
    let clock = 1000;
    const graph = {
      authenticate: vi.fn(async () => { clock += 100; }),
      json: vi.fn(async () => { clock += 100; return { value: [{ id: probe.driveId }] }; }),
      request: vi.fn(async (path: string, _signal: AbortSignal, method: string) => {
        if (method === "PUT") {
          clock += 200;
          return json({ id: "owned-file", name: path.split(":/")[1] });
        }
        clock += 400;
        if (cleanupFails) throw new Error("private cleanup error");
        return new Response(null, { status: 204 });
      }),
      downloadJson: vi.fn(async () => {
        clock += 300;
        const upload = (graph.request as ReturnType<typeof vi.fn>).mock.calls[0]!;
        return upload[3];
      }),
    } as unknown as GraphClient;
    const result = await sharepointProbe(probe, { config, graph, telemetry, signal: new AbortController().signal, now: () => clock });
    expect(resultSchema.safeParse(result).success).toBe(true);
    expect(result.durationMs).toBe(1100);
    expect(result.deliveryDurationMs).toBeUndefined();
    expect(result.diagnosticContext.authenticationDurationMs).toBe(100);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(!cleanupFails);
    expect(result.success).toBe(!cleanupFails);
  });
  it("measures a failed upload through cleanup and never fabricates delivery", async () => {
    let clock = 1000;
    const graph = {
      authenticate: vi.fn(async () => { clock += 100; }),
      json: vi.fn(async () => ({ value: [{ id: probe.driveId }] })),
      request: vi.fn(async (_path: string, _signal: AbortSignal, method: string) => {
        clock += method === "PUT" ? 200 : 300;
        if (method === "PUT") throw new Error("private upload error");
        return new Response(null, { status: 204 });
      }),
    } as unknown as GraphClient;
    const result = await sharepointProbe(probe, { config, graph, telemetry, signal: new AbortController().signal, now: () => clock });
    expect(result).toMatchObject({ success: false, durationMs: 600, diagnosticContext: { cleanupSucceeded: true } });
    expect(result.deliveryDurationMs).toBeUndefined();
  });
});
