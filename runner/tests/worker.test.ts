import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphClient } from "../../shared/src/graph.js";
import { AuthenticatedHttp, IntegrationError } from "../../shared/src/http.js";
import { baseResult } from "../../shared/src/probes.js";
import { runCycle } from "../src/runner.js";
import { parseServiceConfig, serviceSettings, type ServiceConfig } from "../src/service-config.js";
import { runServiceWorker } from "../src/worker.js";

const service = parseServiceConfig({
  type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation",
  cohort: "exchange-global", targets: [1, 2, 3].map(index => ({ id: `exchange-00${index}` })),
});
const telemetry = () => ({ emit: vi.fn() });
const dependencies = () => ({
  results: { record: vi.fn(), forceFlush: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined) },
  telemetry: telemetry(),
});
const liveService = () => parseServiceConfig({
  ...service, mode: "live", targets: service.targets.map(target => ({ ...target, mailbox: "private@example.invalid" })),
});
afterEach(() => vi.useRealTimers());

describe("stateless per-attempt execution", () => {
  it.each(["healthy", "slow", "failed", "timeout", "stale"] as const)("reports %s without analysis, history or health reports", async scenario => {
    const config = serviceSettings(parseServiceConfig({ ...service, scenario }), {});
    const deps = dependencies();
    const cycle = await runCycle(config, deps);
    expect(Object.keys(cycle).sort()).toEqual(["cycleId", "results"]);
    expect(cycle.results).toHaveLength(3);
    expect(deps.results.record).toHaveBeenCalledTimes(3);
    expect(deps.results.forceFlush).toHaveBeenCalledOnce();
    expect(deps.telemetry.emit.mock.calls.map(([event]) => event)).not.toContain("synthetic-result");
  });
  it("flushes a single attempt without a minimum-sample policy", async () => {
    const config = serviceSettings(parseServiceConfig({ ...service, targets: [{ id: "only-one" }] }), {});
    expect((await runCycle(config, dependencies())).results).toHaveLength(1);
  });
  it("does not run global heartbeat/provider/control-plane queries or leak target resources", async () => {
    const config = serviceSettings(liveService(), { ENABLE_LIVE_M365: "true" });
    const deps = dependencies();
    const graph = new GraphClient(new AuthenticatedHttp({ getToken: async () => null }, "scope"));
    const request = vi.spyOn(graph, "request").mockRejectedValue(new Error("Must never run"));
    const healthy = vi.fn(async probe => ({ ...baseResult(probe, Date.now()), success: true, durationMs: 1000 }));
    await runCycle(config, { ...deps, graph, handlers: { "exchange-mail-flow": healthy, "sharepoint-file": healthy } });
    expect(request).not.toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(deps.results.record.mock.calls)).not.toContain("private@example.invalid");
  });
  it("measures thrown handler failures rather than fabricating zero latency", async () => {
    let time = 1000;
    const deps = dependencies();
    const handler = vi.fn(async () => { time += 550; throw new IntegrationError("authentication-failure"); });
    const cycle = await runCycle(serviceSettings(parseServiceConfig({ ...liveService(), targets: [liveService().targets[0]!] }), { ENABLE_LIVE_M365: "true" }), {
      ...deps, now: () => time, handlers: { "exchange-mail-flow": handler, "sharepoint-file": handler },
    });
    expect(cycle.results[0]).toMatchObject({ schemaVersion: "2.0", success: false, durationMs: 550, diagnosticCategory: "authentication-failure" });
  });
  it("converts malformed handler responses to one observed failure", async () => {
    const deps = dependencies();
    const handler = vi.fn(async () => ({} as never));
    const cycle = await runCycle(serviceSettings(liveService(), { ENABLE_LIVE_M365: "true" }), {
      ...deps, handlers: { "exchange-mail-flow": handler, "sharepoint-file": handler },
    });
    expect(cycle.results.every(result => result.diagnosticCategory === "malformed-response")).toBe(true);
    expect(deps.results.record).toHaveBeenCalledTimes(3);
  });
  it("never catches publication errors as a second mock probe result", async () => {
    const deps = dependencies();
    deps.results.record.mockImplementation(() => { throw new Error("private export error"); });
    await expect(runCycle(serviceSettings(parseServiceConfig({ ...service, targets: [{ id: "one" }] }), {}), deps)).rejects.toThrow("Synthetic cycle failed");
    expect(deps.results.record).toHaveBeenCalledOnce();
    expect(deps.telemetry.emit.mock.calls.map(([event]) => event)).not.toContain("probe-execution-failed");
  });
  it("propagates flush failures without claiming that the cycle reported", async () => {
    const deps = dependencies();
    deps.results.forceFlush.mockRejectedValue(new Error("private export error"));
    await expect(runCycle(serviceSettings(service, {}), deps)).rejects.toThrow("Synthetic cycle failed");
    expect(deps.telemetry.emit.mock.calls.map(([event]) => event)).not.toContain("service-execution-completed");
    expect(deps.results.record).toHaveBeenCalledTimes(3);
  });
  it("starts no probes when already cancelled", async () => {
    const deps = dependencies();
    await expect(runCycle(serviceSettings(service, {}), deps, AbortSignal.abort())).rejects.toThrow();
    expect(deps.results.record).not.toHaveBeenCalled();
  });
});

describe("one config, one embedded-SDK fixed-rate worker", () => {
  it("runs once immediately and shuts down after flushing, without health-state summaries", async () => {
    const output = telemetry();
    const deps = dependencies();
    const sleep = vi.fn();
    await runServiceWorker(service, { once: true, env: {}, telemetry: output, sleep,
      createDependencies: (_service, _config, scoped) => ({ ...deps, telemetry: scoped }),
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(output.emit).toHaveBeenCalledWith("service-cycle-summary", expect.objectContaining({
      type: "exchange", mode: "simulation", cohort: "exchange-global", probeCount: 3,
      telemetry: "console", simulation: true, durationMeaning: "modeled-not-measured-latency",
    }));
    expect(JSON.stringify(output.emit.mock.calls)).not.toMatch(/healthState|Healthy|Unhealthy|successRate|p95/);
    expect(deps.results.forceFlush).toHaveBeenCalledOnce();
    expect(deps.results.shutdown).toHaveBeenCalledOnce();
  });
  it("skips missed slots without overlap, backlog, or catch-up bursts", async () => {
    const controller = new AbortController();
    const output = telemetry();
    let clock = 0;
    const starts: number[] = [];
    const durations = [150000, 10000, 0];
    let active = 0;
    let maximumActive = 0;
    await runServiceWorker(service, {
      env: {}, telemetry: output, signal: controller.signal, now: () => clock, createDependencies: () => dependencies(),
      execute: async (...args) => {
        maximumActive = Math.max(maximumActive, ++active);
        starts.push(clock);
        const cycle = await runCycle(...args);
        clock += durations[starts.length - 1]!;
        active--;
        if (starts.length === 3) controller.abort();
        return cycle;
      },
      sleep: async ms => { clock += ms; },
    });
    expect(starts).toEqual([0, 180000, 240000]);
    expect(maximumActive).toBe(1);
    expect(output.emit).toHaveBeenCalledWith("service-slots-skipped", expect.objectContaining({ skipped: 2 }));
  });
  it("schedules normal cycles against the original origin rather than completion", async () => {
    const controller = new AbortController();
    let clock = 0;
    const starts: number[] = [];
    await runServiceWorker(service, {
      env: {}, signal: controller.signal, telemetry: telemetry(), now: () => clock, createDependencies: () => dependencies(),
      execute: async (...args) => {
        starts.push(clock);
        const cycle = await runCycle(...args);
        clock += 10000;
        if (starts.length === 3) controller.abort();
        return cycle;
      },
      sleep: async ms => { clock += ms; },
    });
    expect(starts).toEqual([0, 60000, 120000]);
  });
  it("does not let a blocked Exchange worker delay an independent SharePoint worker", async () => {
    const exchangeStop = new AbortController();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const exchangeExecute = vi.fn(async (...args: Parameters<typeof runCycle>) => { await blocked; return runCycle(...args); });
    const exchange = runServiceWorker(service, {
      env: {}, signal: exchangeStop.signal, telemetry: telemetry(), createDependencies: () => dependencies(), execute: exchangeExecute,
    });
    const stop = new AbortController();
    let clock = 0;
    const starts: number[] = [];
    await runServiceWorker(parseServiceConfig({ ...service, type: "sharepoint", cohort: "sharepoint-global", intervalSeconds: 300 }), {
      env: {}, signal: stop.signal, telemetry: telemetry(), now: () => clock, createDependencies: () => dependencies(),
      execute: async (...args) => {
        starts.push(clock);
        const cycle = await runCycle(...args);
        if (starts.length === 2) stop.abort();
        return cycle;
      },
      sleep: async ms => { clock += ms; },
    });
    expect(starts).toEqual([0, 300000]);
    expect(exchangeExecute).toHaveBeenCalledOnce();
    exchangeStop.abort();
    release();
    await exchange;
  });
  it("shuts down and propagates one-shot failures, but resumes the next scheduled cycle", async () => {
    const deps = dependencies();
    await expect(runServiceWorker(service, {
      once: true, env: {}, telemetry: telemetry(), createDependencies: () => deps,
      execute: vi.fn().mockRejectedValue(new IntegrationError("collector-failure")),
    })).rejects.toThrow();
    expect(deps.results.shutdown).toHaveBeenCalledOnce();
    const stop = new AbortController();
    let calls = 0;
    let clock = 0;
    await runServiceWorker(service, {
      env: {}, signal: stop.signal, telemetry: telemetry(), createDependencies: () => dependencies(),
      now: () => clock, sleep: async ms => { clock += ms; },
      execute: async (...args) => {
        if (++calls === 1) throw new IntegrationError("collector-failure");
        const result = await runCycle(...args);
        stop.abort();
        return result;
      },
    });
    expect(calls).toBe(2);
    expect(clock).toBe(60000);
  });
  it("interrupts cadence waiting and shuts down without another cycle", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const output = telemetry();
    const deps = dependencies();
    const execute = vi.fn(runCycle);
    const worker = runServiceWorker(service, {
      env: {}, signal: stop.signal, telemetry: output, createDependencies: () => deps, execute,
    });
    await vi.waitFor(() => expect(output.emit).toHaveBeenCalledWith("service-cycle-summary", expect.anything()));
    stop.abort();
    await worker;
    await vi.advanceTimersByTimeAsync(120000);
    expect(execute).toHaveBeenCalledOnce();
    expect(deps.results.shutdown).toHaveBeenCalledOnce();
  });
  it("cancels active work, allows bounded cleanup, reports active attempts and starts no queued probes", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const deps = dependencies();
    let cleaned = 0;
    const handler = vi.fn(async (probe, context) => {
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => {
        setTimeout(() => { cleaned++; resolve(); }, 1000);
      }, { once: true }));
      return { ...baseResult(probe, Date.now()), diagnosticCategory: "cancelled" as const };
    });
    const worker = runServiceWorker(parseServiceConfig({ ...liveService(), targets: [
      ...liveService().targets, { id: "queued-fourth", mailbox: "private@example.invalid" },
    ] }), {
      env: { ENABLE_LIVE_M365: "true" }, signal: stop.signal, telemetry: telemetry(),
      createDependencies: () => ({ ...deps, handlers: { "exchange-mail-flow": handler, "sharepoint-file": handler } }),
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
    stop.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await worker;
    expect(cleaned).toBe(3);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(deps.results.record).toHaveBeenCalledTimes(3);
    expect(deps.results.record.mock.calls.every(([attempt]) => attempt.durationMs >= 1000)).toBe(true);
    expect(deps.results.shutdown).toHaveBeenCalledOnce();
  });
  it("bounds cleanup even when an injected handler ignores cancellation", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const handler = vi.fn(async () => new Promise<never>(() => undefined));
    const deps = dependencies();
    const worker = runServiceWorker(liveService(), {
      env: { ENABLE_LIVE_M365: "true" }, signal: stop.signal, telemetry: telemetry(),
      createDependencies: () => ({ ...deps, handlers: { "exchange-mail-flow": handler, "sharepoint-file": handler } }),
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
    stop.abort();
    await vi.advanceTimersByTimeAsync(12000);
    await worker;
    expect(handler).toHaveBeenCalledTimes(3);
    expect(deps.results.record).toHaveBeenCalledTimes(3);
    expect(deps.results.record.mock.calls.every(([attempt]) => attempt.durationMs >= 12000)).toBe(true);
    expect(deps.results.shutdown).toHaveBeenCalledOnce();
  });
  it.each(["teams", "exchange", "sharepoint"])("does not initialize OTel, credentials or execution for disabled %s", async type => {
    const createDependencies = vi.fn();
    const execute = vi.fn();
    await runServiceWorker(parseServiceConfig({ ...service, type, enabled: false, targets: [], telemetry: "azure-monitor" }), {
      env: {}, telemetry: telemetry(), createDependencies, execute,
    });
    expect(createDependencies).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(([
    { ...service, type: "teams", enabled: true }, { ...service, intervalSeconds: 0 },
    { ...service, targets: [{ id: "bad", siteId: "wrong-service" }] },
    { ...service, reportToHealthModel: true }, { ...service, mode: "live" },
  ] as unknown[]).map(raw => ({ raw })))("rejects invalid configs before runtime side effects", async ({ raw }) => {
    const createDependencies = vi.fn();
    await expect(runServiceWorker(raw as ServiceConfig, { env: {}, telemetry: telemetry(), createDependencies })).rejects.toThrow();
    expect(createDependencies).not.toHaveBeenCalled();
  });
});
