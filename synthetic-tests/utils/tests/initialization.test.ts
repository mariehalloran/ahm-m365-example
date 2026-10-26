import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../src/config.js";
import { readProjectConfig } from "../src/project-config.js";
import { parseServiceConfig } from "../src/service-config.js";
import { runServiceWorker, type WorkerOptions } from "../src/worker.js";
import { baseResult } from "../src/probes.js";
import { outcomeOf } from "../src/results.js";

const credential = vi.hoisted(() => ({
  getToken: vi.fn(async (_scope: string | string[], _options?: unknown) => ({
    token: "mock-arm-token", expiresOnTimestamp: Date.now() + 60000,
  })),
}));
vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: vi.fn(function () { return credential; }),
  ClientCertificateCredential: vi.fn(),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

const checkedIn = await readProjectConfig("../monitoring.config.json");
const project = () => ({
  ...structuredClone(checkedIn),
  healthModel: { ...checkedIn.healthModel, subscriptionId: "11111111-1111-4111-8111-111111111111" },
  services: {
    exchange: { ...structuredClone(checkedIn.services.exchange), scenarios: {
      "send-receive-mail": true, "edit-reopen-draft": false, "attachment-reply-mail": false,
      "distribution-list-mail": false, "recurring-calendar": false, "meeting-invitation": false,
    } },
    teams: {
      ...structuredClone(checkedIn.services.teams), targets: [{ id: "teams-probe-001" }],
      scenarios: { "publish-channel-message": true, "reply-channel-message": false, "call-test-user": false },
    },
    sharepoint: { ...structuredClone(checkedIn.services.sharepoint), enabled: true, scenarios: { "save-reopen-file": true, "rename-reopen-file": false } },
    onedrive: structuredClone(checkedIn.services.onedrive),
  },
});
const env = { ENABLE_LIVE_M365: "true", AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222" };
const service = (type: "exchange" | "teams" | "sharepoint") => parseServiceConfig({
  type, enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "live",
  cohort: `${type}-global`, targets: [{ id: `${type}-probe-001` }],
});

describe("observed initialization failures", () => {
  it("outputs observed startup failures and still publishes direct health when console result output fails", async () => {
    const configured = project();
    const output = { emit: vi.fn() };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    output.emit.mockImplementation((event: string) => { if (event === "synthetic-result") throw new Error("Console write failed"); });
    await expect(runServiceWorker(service("sharepoint"), {
      project: configured, once: true, env, telemetry: output,
    })).rejects.toThrow("Multiple service worker operations failed");
    expect(output.emit).toHaveBeenCalledWith("synthetic-result", expect.objectContaining({
      result: expect.objectContaining({ success: false, steps: [], diagnosticCategory: "configuration-failure" }),
    }));
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it.each(["teams", "sharepoint"] as const)("reports an unconfigured %s journey as Unhealthy, not invented failed actions", async type => {
    const output = { emit: vi.fn() };
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }));
    const createDependencies = vi.fn();
    await expect(runServiceWorker(service(type), {
      project: project(), once: true, env, telemetry: output, createDependencies,
    })).rejects.toThrow("Missing dedicated resources");
    expect(createDependencies).not.toHaveBeenCalled();
    expect(bodies[0]).toMatchObject({ signalName: "synthetic-success-percentage", healthState: "Unhealthy", value: 0 });
    expect(JSON.parse(String(bodies[0]!.additionalContext))).toMatchObject({
      attempted: project().services[type].targets.length, succeeded: 0, diagnosticCategories: ["configuration-failure"],
    });
    expect(bodies.slice(2).every(body => body.healthState === "Unknown" && body.value === undefined)).toBe(true);
    expect(credential.getToken.mock.calls.every(([scope]) => scope === "https://management.azure.com/.default")).toBe(true);
    expect(output.emit).toHaveBeenCalledWith("service-initialization-failed", expect.objectContaining({
      category: "configuration-failure", mode: "live", simulation: false,
    }));
    const result = output.emit.mock.calls.find(([event]) => event === "synthetic-result")?.[1].result;
    expect(result).toMatchObject({ success: false, steps: [], diagnosticContext: { testStage: "initialization" } });
    expect(outcomeOf(result)).toBe("unexecutable");
  });
  it("retries genuine initialization on each independent cadence without claiming a successful cycle", async () => {
    const stop = new AbortController();
    const output = { emit: vi.fn() };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    let clock = 0;
    await runServiceWorker(service("sharepoint"), {
      project: project(), env, telemetry: output, signal: stop.signal, now: () => clock,
      sleep: async ms => { clock += ms; if (clock >= 120000) stop.abort(); },
    });
    expect(fetcher).toHaveBeenCalledTimes(16);
    expect(output.emit.mock.calls.filter(([event]) => event === "service-initialization-failed")).toHaveLength(2);
    expect(output.emit.mock.calls.some(([event]) => event === "service-cycle-summary")).toBe(false);
    expect(output.emit).toHaveBeenCalledWith("service-worker-stopped", expect.objectContaining({ cancelled: true }));
  });
  it("can initialize successfully after a transient setup failure", async () => {
    const stop = new AbortController();
    const output = { emit: vi.fn((event: string) => { if (event === "service-cycle-summary") stop.abort(); }) };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })));
    const results = { record: vi.fn(), recordDiagnostic: vi.fn() };
    const createDependencies = vi.fn<NonNullable<WorkerOptions["createDependencies"]>>()
      .mockRejectedValueOnce(new ConfigurationError("Required initialization setting is missing"))
      .mockImplementation(async (_service, _config, telemetry) => ({ results, telemetry }));
    await runServiceWorker(service("exchange"), {
      project: project(), env, telemetry: output, signal: stop.signal, createDependencies,
      sleep: async () => undefined,
      handler: async probe => ({ ...baseResult(probe, Date.now()), success: true, durationMs: 1 }),
    });
    expect(createDependencies).toHaveBeenCalledTimes(2);
    expect(results.record).toHaveBeenCalledOnce();
    expect(output.emit.mock.calls.filter(([event]) => event === "service-initialization-failed")).toHaveLength(1);
  });
});
