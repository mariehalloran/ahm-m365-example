import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingSink } from "../../health-model/src/ahm.js";
import { GraphClient } from "../../shared/src/graph.js";
import { AuthenticatedHttp, IntegrationError } from "../../shared/src/http.js";
import { baseResult } from "../../shared/src/probes.js";
import { runCycle } from "../src/runner.js";
import { parseServiceConfig, serviceSettings, type ServiceConfig } from "../src/service-config.js";
import { MemoryStateStore } from "./memory-state.js";
import { runServiceWorker } from "../src/worker.js";

const service = parseServiceConfig({
  type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation",
  cohort: "exchange-global", targets: [1, 2, 3].map(index => ({ id: `exchange-00${index}` })),
});
const telemetry = () => ({ emit: vi.fn() });
const dependencies = () => ({ sink: new RecordingSink(), state: new MemoryStateStore(), telemetry: telemetry() });
const liveService = () => parseServiceConfig({
  ...service, mode: "live", targets: service.targets.map(target => ({ ...target, mailbox: "private@example.invalid" })),
});
afterEach(() => vi.useRealTimers());

describe("service-only execution reuses the existing pipeline", () => {
  it.each([
    ["healthy", "Healthy"], ["slow", "Degraded"], ["failed", "Unhealthy"],
    ["timeout", "Unhealthy"], ["stale", "Unknown"],
  ] as const)("evaluates %s evidence through cohort policy", async (scenario, state) => {
    const config = serviceSettings(parseServiceConfig({ ...service, scenario }), {});
    const deps = dependencies();
    await runCycle(config, deps);
    const cycle = await runCycle(config, deps);
    expect(cycle.reports).toHaveLength(1);
    expect(cycle.reports[0]?.state).toBe(state);
    expect(cycle.results).toHaveLength(3);
  });
  it("does not save history or claim completion when report ingestion fails", async () => {
    const deps = dependencies();
    vi.spyOn(deps.sink, "submit").mockRejectedValue(new IntegrationError("permission-failure"));
    const save = vi.spyOn(deps.state, "save");
    await expect(runCycle(serviceSettings(service, {}), deps)).rejects.toThrow("Synthetic cycle failed");
    expect(save).not.toHaveBeenCalled();
    expect(deps.telemetry.emit.mock.calls.map(([event]) => event)).not.toContain("service-execution-completed");
  });
  it("submits only its cohort, never global heartbeat/provider/control-plane reports or Graph queries", async () => {
    const config = serviceSettings(liveService(), { ENABLE_LIVE_M365: "true" });
    const deps = dependencies();
    const graph = new GraphClient(new AuthenticatedHttp({ getToken: async () => null }, "scope"));
    const request = vi.spyOn(graph, "request").mockRejectedValue(new Error("Provider queries must never run"));
    const healthy = vi.fn(async probe => ({ ...baseResult(probe, Date.now(), 900), success: true, durationMs: 1000 }));
    const result = await runCycle(config, {
      ...deps, graph, handlers: { "exchange-mail-flow": healthy, "sharepoint-file": healthy },
    });
    expect(result.reports.map(report => report.entity)).toEqual(["exchange-global"]);
    expect(result.reports[0]?.state).toBe("Healthy");
    expect(deps.sink.reports).toEqual(result.reports);
    expect(request).not.toHaveBeenCalled();
    expect(healthy).toHaveBeenCalledTimes(3);
    expect(deps.telemetry.emit.mock.calls.filter(([event]) => event === "synthetic-result")).toHaveLength(3);
    expect(JSON.stringify(deps.telemetry.emit.mock.calls)).not.toContain("private@example.invalid");
    expect(deps.telemetry.emit.mock.calls.map(([event]) => event)).not.toContain("cycle-completed");
  });
  it("keeps a single target Unknown under the default minimum three fresh samples", async () => {
    const config = serviceSettings(parseServiceConfig({ ...service, targets: [{ id: "only-one" }] }), {});
    const cycle = await runCycle(config, dependencies());
    expect(cycle.reports[0]).toMatchObject({ state: "Unknown", context: { reason: "insufficient-fresh-samples", sampleCount: 1 } });
  });
  it("retains per-target scenarios and shared consecutive-cycle policy", async () => {
    const config = serviceSettings(parseServiceConfig({ ...service, scenario: "failed" }), {});
    const deps = dependencies();
    expect((await runCycle(config, deps)).reports[0]?.state).toBe("Degraded");
    expect((await runCycle(config, deps)).reports[0]?.state).toBe("Unhealthy");
    const healthy = serviceSettings(service, {});
    expect((await runCycle(healthy, deps)).reports[0]?.state).toBe("Degraded");
    expect((await runCycle(healthy, deps)).reports[0]?.state).toBe("Healthy");
  });
  it("never submits even an Unknown global heartbeat on service persistence failure", async () => {
    const deps = dependencies();
    vi.spyOn(deps.state, "save").mockRejectedValue(new Error("state failed"));
    await expect(runCycle(serviceSettings(service, {}), deps)).rejects.toThrow("Synthetic cycle failed");
    expect(deps.sink.reports.map(report => report.entity)).toEqual(["exchange-global"]);
    expect(deps.sink.reports[0]?.context).toMatchObject({
      executionMode: "simulation", testType: "exchange-mail-flow", durationMeaning: "modeled-not-measured-latency",
    });
  });
  it("does not persist history or submit any reports after cancellation", async () => {
    const deps = dependencies();
    const save = vi.spyOn(deps.state, "save");
    await expect(runCycle(serviceSettings(service, {}), deps, AbortSignal.abort())).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    expect(deps.sink.reports).toEqual([]);
  });
});

describe("one config, one fixed-rate worker", () => {
  it("runs once immediately without sleeping and prints a labeled service summary plus sanitized results", async () => {
    const output = telemetry();
    const sleep = vi.fn();
    const deps = dependencies();
    await runServiceWorker(service, {
      once: true, env: {}, telemetry: output, sleep,
      createDependencies: (_service, _config, scoped) => ({ ...deps, telemetry: scoped }),
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(output.emit).toHaveBeenCalledWith("service-cycle-summary", expect.objectContaining({
      type: "exchange", mode: "simulation", entity: "exchange-global", state: "Healthy", probeCount: 3,
      reportingEnabled: false, simulation: true, durationMeaning: "modeled-not-measured-latency",
    }));
    expect(output.emit.mock.calls.filter(([event]) => event === "synthetic-result")).toHaveLength(3);
    expect(deps.sink.reports.map(report => report.entity)).toEqual(["exchange-global"]);
  });
  it("skips missed slots without overlap, backlog, or catch-up bursts", async () => {
    const controller = new AbortController();
    const output = telemetry();
    let clock = 0;
    const starts: number[] = [];
    const durations = [150000, 10000, 0];
    let active = 0;
    let maximumActive = 0;
    const deps = dependencies();
    await runServiceWorker(service, {
      env: {}, telemetry: output, signal: controller.signal, now: () => clock,
      createDependencies: () => deps,
      execute: async (...args) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
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
    expect(deps.sink.reports).toHaveLength(1);
  });
  it("schedules normal cycles against the original origin, not completion time", async () => {
    const controller = new AbortController();
    let clock = 0;
    const starts: number[] = [];
    await runServiceWorker(service, {
      env: {}, signal: controller.signal, telemetry: telemetry(), now: () => clock,
      createDependencies: () => dependencies(),
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
  it("does not let a blocked Exchange process delay an independent SharePoint worker", async () => {
    const exchangeStop = new AbortController();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const exchangeExecute = vi.fn(async (...args: Parameters<typeof runCycle>) => {
      await blocked;
      return runCycle(...args);
    });
    const exchange = runServiceWorker(service, {
      env: {}, signal: exchangeStop.signal, telemetry: telemetry(),
      createDependencies: () => dependencies(), execute: exchangeExecute,
    });
    const sharepointStop = new AbortController();
    let clock = 0;
    const starts: number[] = [];
    await runServiceWorker(parseServiceConfig({ ...service, type: "sharepoint", cohort: "sharepoint-global", intervalSeconds: 300 }), {
      env: {}, signal: sharepointStop.signal, telemetry: telemetry(), now: () => clock,
      createDependencies: () => dependencies(),
      execute: async (...args) => {
        starts.push(clock);
        const cycle = await runCycle(...args);
        if (starts.length === 2) sharepointStop.abort();
        return cycle;
      },
      sleep: async ms => { clock += ms; },
    });
    expect(starts).toEqual([0, 300000]);
    expect(exchangeExecute).toHaveBeenCalledTimes(1);
    exchangeStop.abort();
    release();
    await exchange;
  });
  it("continues its cadence after a failed scheduled cycle but propagates one-shot failure", async () => {
    const onceExecute = vi.fn().mockRejectedValue(new IntegrationError("collector-failure"));
    await expect(runServiceWorker(service, {
      once: true, env: {}, telemetry: telemetry(), createDependencies: () => dependencies(), execute: onceExecute,
    })).rejects.toThrow();
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
  it("interrupts a cadence wait immediately and starts no further cycle", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const output = telemetry();
    const execute = vi.fn(runCycle);
    const worker = runServiceWorker(service, {
      env: {}, signal: stop.signal, telemetry: output, createDependencies: () => dependencies(), execute,
    });
    await vi.waitFor(() => expect(output.emit).toHaveBeenCalledWith("service-cycle-summary", expect.anything()));
    stop.abort();
    await worker;
    await vi.advanceTimersByTimeAsync(120000);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("cancels active work, permits bounded cleanup, and never starts queued probes or future runs", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const deps = dependencies();
    const save = vi.spyOn(deps.state, "save");
    let cleaned = 0;
    const handler = vi.fn(async (probe, context) => {
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => {
        setTimeout(() => { cleaned++; resolve(); }, 1000);
      }, { once: true }));
      return baseResult(probe, Date.now(), 900);
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
    expect(save).not.toHaveBeenCalled();
    expect(deps.sink.reports).toEqual([]);
  });
  it("bounds cleanup even if an injected handler ignores cancellation", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const handler = vi.fn(async () => new Promise<never>(() => undefined));
    const worker = runServiceWorker(liveService(), {
      env: { ENABLE_LIVE_M365: "true" }, signal: stop.signal, telemetry: telemetry(),
      createDependencies: () => ({ ...dependencies(), handlers: { "exchange-mail-flow": handler, "sharepoint-file": handler } }),
    });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3));
    stop.abort();
    await vi.advanceTimersByTimeAsync(12000);
    await worker;
    expect(handler).toHaveBeenCalledTimes(3);
  });
  it.each(["teams", "exchange", "sharepoint"])("does nothing for a disabled %s config, including credential/env validation and state initialization", async type => {
    const createDependencies = vi.fn();
    const execute = vi.fn();
    await runServiceWorker(parseServiceConfig({ ...service, type, enabled: false, targets: [] }), {
      env: { EXECUTION_MODE: "invalid", AHM_MODEL_ID: "invalid" }, telemetry: telemetry(), createDependencies, execute,
    });
    expect(createDependencies).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(([
    { ...service, type: "teams", enabled: true },
    { ...service, intervalSeconds: 0 },
    { ...service, targets: [{ id: "bad", siteId: "wrong-service" }] },
    { ...service, reportToHealthModel: true },
    { ...service, mode: "live" },
  ] as unknown[]).map(raw => ({ raw })))("fails invalid or unsupported configuration before runtime side effects", async ({ raw }) => {
    const createDependencies = vi.fn();
    const output = telemetry();
    await expect(runServiceWorker(raw as ServiceConfig, { env: {}, telemetry: output, createDependencies })).rejects.toThrow();
    expect(createDependencies).not.toHaveBeenCalled();
    expect(output.emit).not.toHaveBeenCalled();
  });
});
