import { afterEach, describe, expect, it, vi } from "vitest";
import { executionLanes, runExecutionLanes } from "../src/execution-lanes.js";
import { aggregateHealthReports } from "../src/health-reports.js";
import { baseResult } from "../src/probes.js";
import { readProjectConfig } from "../src/project-config.js";
import { runCycle } from "../src/runner.js";
import { parseServiceConfig, serviceSettings } from "../src/service-config.js";
import { runServiceWorker } from "../src/worker.js";

afterEach(() => vi.useRealTimers());
const service = parseServiceConfig({
  type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 1, mode: "live",
  cohort: "exchange-global", targets: ["one", "two", "three"].map(id => ({ id, mailbox: "owned@example.invalid" })),
});

describe("independent fixed-rate execution lanes", () => {
  it("caps both default and explicitly configured Exchange lanes without extending shorter budgets", () => {
    const defaults = executionLanes({ ...service, timeoutSeconds: 120 });
    expect(defaults.map(lane => lane.timeoutSeconds)).toEqual([15, 15]);
    const custom = defaults.map((lane, index) => ({ ...lane, timeoutSeconds: index === 0 ? 8 : 120 }));
    expect(executionLanes({ ...service, executionLanes: custom }).map(lane => lane.timeoutSeconds)).toEqual([8, 15]);
  });

  it("rejects overlapping assignments, unknown journeys, missing assignments and the reserved provider lane name", () => {
    const defaults = executionLanes(service);
    for (const lanes of [
      [defaults[0]!],
      [...defaults, { ...defaults[0]!, name: "duplicate-assignment" }],
      [{ ...defaults[0]!, journeys: ["invented-journey"] }, defaults[1]!],
      [{ ...defaults[0]!, name: "provider-context" }, defaults[1]!],
    ]) expect(() => parseServiceConfig({ ...service, executionLanes: lanes })).toThrow();
    expect(parseServiceConfig({ ...service, executionLanes: defaults }).executionLanes).toEqual(defaults);
  });

  it("keeps the independent default 300-second provider lane from holding 60-second mail execution", async () => {
    vi.useFakeTimers();
    const origin = Date.now();
    const stop = new AbortController();
    const mailStarts: number[] = [];
    const providerStarts: number[] = [];
    const worker = runServiceWorker(parseServiceConfig({ ...service, mode: "simulation", serviceHealth: true }), {
      signal: stop.signal, now: Date.now, telemetry: { emit() {} },
      createDependencies: () => ({ telemetry: { emit() {} }, results: { record() {}, recordDiagnostic() {} } }),
      execute: async () => {
        mailStarts.push((Date.now() - origin) / 1000);
        return { cycleId: "11111111-1111-4111-8111-111111111111", results: [] };
      },
      providers: async () => {
        providerStarts.push((Date.now() - origin) / 1000);
        await new Promise(resolve => setTimeout(resolve, 350000));
        return { configured: 0, succeeded: 0, failed: 0, skipped: 0, records: 0 };
      },
      sleep: async (ms, signal) => new Promise<void>(resolve => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      }),
    });
    await vi.advanceTimersByTimeAsync(610000);
    stop.abort();
    await vi.advanceTimersByTimeAsync(350000);
    await worker;
    expect(mailStarts).toEqual([0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600]);
    expect(providerStarts).toEqual([0, 600]);
  });

  it("runs 60-second mail while a slow 300-second extended lane skips its overlapping slot", async () => {
    vi.useFakeTimers();
    const origin = Date.now();
    const signal = new AbortController();
    const telemetry = { emit: vi.fn() };
    const starts: Record<string, number[]> = { mail: [], extended: [] };
    const active = new Set<string>();
    const run = runExecutionLanes(executionLanes(service), async lane => {
      expect(active.has(lane.name)).toBe(false);
      active.add(lane.name);
      starts[lane.name]!.push((Date.now() - origin) / 1000);
      await new Promise(resolve => setTimeout(resolve, lane.name === "extended" ? 350000 : 100));
      active.delete(lane.name);
    }, {
      signal: signal.signal, telemetry, now: Date.now,
      sleep: async (ms, abort) => {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, ms);
          abort.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      },
    });
    await vi.advanceTimersByTimeAsync(610000);
    signal.abort();
    await vi.advanceTimersByTimeAsync(350000);
    await run;
    expect(starts.mail).toEqual([0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600]);
    expect(starts.extended).toEqual([0, 600]);
    expect(telemetry.emit).toHaveBeenCalledWith("service-slots-skipped", expect.objectContaining({ lane: "extended", skipped: 1, firstSlot: 1 }));
  });

  it("settles a failed lane without cancelling siblings", async () => {
    const ran: string[] = [];
    await expect(runExecutionLanes(executionLanes(service), async lane => {
      ran.push(lane.name);
      if (lane.name === "mail") throw new Error("one failure");
      await Promise.resolve();
      ran.push("extended-finished");
    }, { signal: new AbortController().signal, telemetry: { emit() {} }, once: true })).rejects.toThrow("one failure");
    expect(ran).toEqual(["mail", "extended", "extended-finished"]);
  });
});

describe("execution deadlines", () => {
  it.each([14999, 15000, 16000])("checks elapsed Exchange execution even before a delayed timer can run (%s ms)", async durationMs => {
    let clock = 0;
    const config = serviceSettings({ ...service, timeoutSeconds: 45 }, { ENABLE_LIVE_M365: "true" });
    const cycle = await runCycle({ ...config, probes: [config.probes[0]!] }, {
      now: () => clock, telemetry: { emit() {} }, results: { record() {}, recordDiagnostic() {} },
      handler: async probe => {
        clock = durationMs;
        return { ...baseResult(probe, clock), success: true };
      },
    });
    expect(cycle.results[0]).toMatchObject({
      success: durationMs < 15000, durationMs,
      diagnosticCategory: durationMs < 15000 ? null : "delivery-timeout",
    });
  });

  it("includes queued selected attempts when the internal cycle deadline expires", async () => {
    vi.useFakeTimers();
    const configured = parseServiceConfig({
      ...service, timeoutSeconds: 120, cycleTimeoutSeconds: 20,
      targets: Array.from({ length: 7 }, (_, index) => ({ id: `target-${index}`, mailbox: "owned@example.invalid" })),
    });
    const handler = vi.fn(async (probe, context) => {
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { ...baseResult(probe, Date.now()), success: false, diagnosticCategory: "cancelled" as const };
    });
    const pending = runCycle(serviceSettings(configured, { ENABLE_LIVE_M365: "true" }), {
      telemetry: { emit() {} }, results: { record() {}, recordDiagnostic() {} }, handler,
    });
    await vi.advanceTimersByTimeAsync(21000);
    const cycle = await pending;
    expect(cycle.results).toHaveLength(7);
    expect(cycle.results.every(result => !result.success && result.diagnosticCategory === "delivery-timeout")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(6);
  });

  it.each(["exchange-mail-flow", "onedrive-roundtrip"] as const)(
    "enforces the Exchange 15-second deadline without changing other products: %s", async type => {
      vi.useFakeTimers();
      const config = serviceSettings({ ...service, timeoutSeconds: 45 }, { ENABLE_LIVE_M365: "true" });
      let aborted = false;
      const pending = runCycle({ ...config, probes: [{ ...config.probes[0]!, type }] }, {
        telemetry: { emit() {} }, results: { record() {}, recordDiagnostic() {} },
        handler: async (probe, context) => {
          context.signal.addEventListener("abort", () => { aborted = true; });
          await new Promise(resolve => setTimeout(resolve, 18000));
          return { ...baseResult(probe, Date.now()), success: true };
        },
      });
      await vi.advanceTimersByTimeAsync(14999);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted).toBe(type === "exchange-mail-flow");
      await vi.advanceTimersByTimeAsync(3000);
      const cycle = await pending;
      expect(cycle.results[0]).toMatchObject({
        success: type !== "exchange-mail-flow", durationMs: 18000,
        diagnosticCategory: type === "exchange-mail-flow" ? "delivery-timeout" : null,
      });
    },
  );

  it("cancels timed-out work, publishes zero/Unhealthy, preserves siblings and ignores late success", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const record = vi.fn();
    const reportHealth = vi.fn();
    const work = runCycle(serviceSettings(service, { ENABLE_LIVE_M365: "true" }), {
      telemetry: { emit() {} }, results: { record, recordDiagnostic() {} }, reportHealth,
      handler: async (probe, context) => {
        if (probe.id === "one") {
          context.signal.addEventListener("abort", () => { aborted = true; });
          await new Promise(resolve => setTimeout(resolve, 30000));
        }
        if (probe.id === "three") throw new Error("independent rejection");
        return { ...baseResult(probe, Date.now()), success: true };
      },
    });
    await vi.advanceTimersByTimeAsync(14000);
    const cycle = await work;
    expect(aborted).toBe(true);
    expect(cycle.results).toHaveLength(3);
    expect(cycle.results.find(result => result.testId === "one")).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout" });
    expect(cycle.results.find(result => result.testId === "two")?.success).toBe(true);
    const policy = (await readProjectConfig("../monitoring.config.json")).healthModel;
    const reports = aggregateHealthReports("exchange", { ...cycle, results: cycle.results.filter(result => result.testId === "one") }, policy);
    expect(reports.find(report => report.entityName === "exchange-global" && report.body.signalName === "synthetic-success-percentage")?.body)
      .toMatchObject({ value: 0, healthState: "Unhealthy" });
    await vi.advanceTimersByTimeAsync(30000);
    expect(record).toHaveBeenCalledTimes(3);
    expect(reportHealth).toHaveBeenCalledOnce();
    expect(cycle.results.find(result => result.testId === "one")?.success).toBe(false);
  });
});
