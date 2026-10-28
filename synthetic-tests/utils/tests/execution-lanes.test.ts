import { afterEach, describe, expect, it, vi } from "vitest";
import { executionLanes, runExecutionLanes } from "../src/execution-lanes.js";
import { aggregateHealthReports } from "../src/health-reports.js";
import { baseResult } from "../src/probes.js";
import { projectFixture, liveTenantEnv } from "./fixtures.js";
import { serviceExecution } from "../src/project-config.js";
import { runCycle } from "../src/runner.js";
import { parseServiceConfig, serviceSettings } from "../src/service-config.js";
import { runServiceWorker } from "../src/worker.js";

afterEach(() => vi.useRealTimers());
const service = parseServiceConfig({
  type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 1, mode: "live",
  cohort: "exchange-global", targets: ["one", "two", "three"].map(id => ({ id, mailbox: "owned@example.invalid" })),
});

describe("independent fixed-rate execution lanes", () => {
  it("caps default and explicit Exchange lanes at their slowest journey without extending shorter budgets", () => {
    const defaults = executionLanes({ ...service, timeoutSeconds: 120 });
    expect(defaults.map(lane => [lane.name, lane.timeoutSeconds])).toEqual([["mail", 15], ["extended", 30]]);
    expect(executionLanes({ ...service, timeoutSeconds: 20 }).map(lane => lane.timeoutSeconds)).toEqual([15, 20]);
    const custom = defaults.map((lane, index) => ({ ...lane, timeoutSeconds: index === 0 ? 8 : 120 }));
    expect(executionLanes({ ...service, executionLanes: custom }).map(lane => lane.timeoutSeconds)).toEqual([8, 30]);
  });

  it("clamps an Exchange lane to the largest deadline among the journeys assigned to it", () => {
    const lane = (name: string, timeoutSeconds: number, journeys: string[]) => ({ name, intervalSeconds: 60, timeoutSeconds, journeys });
    const lanes = [
      lane("mail", 120, ["send-receive-mail"]),
      lane("single-hop", 120, ["edit-reopen-draft", "attachment-mail", "distribution-list-mail", "recurring-calendar"]),
      lane("reply", 120, ["reply-mail"]),
      lane("meeting", 20, ["meeting-invitation"]),
    ];
    expect(executionLanes({ ...service, executionLanes: lanes }).map(lane => [lane.name, lane.timeoutSeconds]))
      .toEqual([["mail", 15], ["single-hop", 15], ["reply", 30], ["meeting", 20]]);
    const mixed = [lane("mail", 15, ["send-receive-mail"]), lane("extended", 120, lanes.slice(1).flatMap(item => item.journeys))];
    expect(executionLanes({ ...service, executionLanes: mixed }).map(lane => lane.timeoutSeconds)).toEqual([15, 30]);
  });

  it("accepts a lane timeout above the service-level timeout and leaves other services' lanes untouched", () => {
    const configured = parseServiceConfig({
      ...service, timeoutSeconds: 15,
      executionLanes: [
        { name: "mail", intervalSeconds: 60, timeoutSeconds: 15, journeys: ["send-receive-mail"] },
        { name: "extended", intervalSeconds: 300, timeoutSeconds: 30, journeys: [
          "edit-reopen-draft", "attachment-mail", "reply-mail", "distribution-list-mail", "recurring-calendar", "meeting-invitation",
        ] },
      ],
    });
    expect(configured.timeoutSeconds).toBe(15);
    expect(executionLanes(configured).map(lane => lane.timeoutSeconds)).toEqual([15, 30]);
    const teams = { type: "teams", intervalSeconds: 120, timeoutSeconds: 120 } as const;
    expect(executionLanes(teams).map(lane => lane.timeoutSeconds)).toEqual([120]);
    const onedriveLanes = [{ name: "all", intervalSeconds: 300, timeoutSeconds: 120, journeys: ["user-drive-roundtrip"] }];
    expect(executionLanes({ ...teams, type: "onedrive", executionLanes: onedriveLanes })).toEqual(onedriveLanes);
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

  it.each([
    ["exchange-mail-flow", 15000], ["exchange-draft", 15000], ["exchange-attachment", 15000], ["exchange-reply", 30000],
    ["exchange-distribution-list", 15000], ["exchange-recurring-calendar", 15000], ["exchange-meeting", 30000],
  ] as const)("cancels %s at its %s ms deadline even when the lane or service timeout is 120 seconds", async (type, deadlineMs) => {
    vi.useFakeTimers();
    const config = serviceSettings({ ...service, timeoutSeconds: 120 }, { ENABLE_LIVE_M365: "true" });
    expect(config.PROBE_TIMEOUT_MS).toBe(120000);
    let aborted = false;
    const pending = runCycle({ ...config, probes: [{ ...config.probes[0]!, type }] }, {
      telemetry: { emit() {} }, results: { record() {}, recordDiagnostic() {} },
      handler: async (probe, context) => {
        context.signal.addEventListener("abort", () => { aborted = true; });
        await new Promise(resolve => setTimeout(resolve, deadlineMs + 3000));
        return { ...baseResult(probe, Date.now()), success: true };
      },
    });
    await vi.advanceTimersByTimeAsync(deadlineMs - 1);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).results[0]).toMatchObject({
      success: false, diagnosticCategory: "delivery-timeout", durationMs: deadlineMs + 3000,
    });
  });

  it.each([
    ["exchange-reply", "exchange-reply"], ["exchange-meeting", "exchange-meeting"],
  ] as const)("lets a 20-second %s succeed under the 30-second deadline and reports it Degraded, not Unhealthy", async (type, entityName) => {
    vi.useFakeTimers();
    const config = serviceSettings({ ...service, timeoutSeconds: 15 }, { ENABLE_LIVE_M365: "true" });
    let aborted = false;
    const pending = runCycle({ ...config, PROBE_TIMEOUT_MS: 30000, probes: [{ ...config.probes[0]!, type }] }, {
      telemetry: { emit() {} }, results: { record() {}, recordDiagnostic() {} },
      handler: async (probe, context) => {
        context.signal.addEventListener("abort", () => { aborted = true; });
        await new Promise(resolve => setTimeout(resolve, 20000));
        return { ...baseResult(probe, Date.now()), success: true };
      },
    });
    await vi.advanceTimersByTimeAsync(20000);
    const cycle = await pending;
    expect(aborted).toBe(false);
    expect(cycle.results[0]).toMatchObject({ success: true, diagnosticCategory: null, durationMs: 20000 });
    const reports = aggregateHealthReports("exchange", cycle, projectFixture().healthModel);
    const signal = (name: string) => reports.find(report => report.entityName === entityName && report.body.signalName === name)?.body;
    expect(signal("synthetic-success-percentage")).toMatchObject({ value: 100, healthState: "Healthy" });
    expect(signal("synthetic-mean-duration")).toMatchObject({ value: 20000, healthState: "Degraded" });
  });

  it.each(["onedrive-roundtrip", "teams-channel-message", "teams-call"] as const)(
    "leaves the configured timeout of other products untouched by the Exchange deadlines: %s", async type => {
      vi.useFakeTimers();
      const config = serviceSettings({ ...service, timeoutSeconds: 45 }, { ENABLE_LIVE_M365: "true" });
      let aborted = false;
      const pending = runCycle({ ...config, probes: [{ ...config.probes[0]!, type }] }, {
        telemetry: { emit() {} }, results: { record() {}, recordDiagnostic() {} },
        handler: async (probe, context) => {
          context.signal.addEventListener("abort", () => { aborted = true; });
          await new Promise(resolve => setTimeout(resolve, 33000));
          return { ...baseResult(probe, Date.now()), success: true };
        },
      });
      await vi.advanceTimersByTimeAsync(33000);
      expect(aborted).toBe(false);
      expect((await pending).results[0]).toMatchObject({ success: true, durationMs: 33000, diagnosticCategory: null });
    },
  );

  it("does not apply the Exchange deadlines in simulation", async () => {
    const simulated = parseServiceConfig({ ...service, mode: "simulation", scenario: "slow", timeoutSeconds: 120 });
    const config = serviceSettings(simulated, {}, { "reply-mail": true, "meeting-invitation": true, "send-receive-mail": true });
    const cycle = await runCycle(config, { telemetry: { emit() {} }, results: { record() {}, recordDiagnostic() {} } });
    expect(config.PROBE_TIMEOUT_MS).toBe(120000);
    expect(cycle.results).toHaveLength(9);
    expect(cycle.results.every(result => result.success && result.durationMs === 30000)).toBe(true);
  });

  it("hands every journey its own deadline through the lanes of a live worker: 30 s for reply and meeting, 15 s otherwise", async () => {
    const project = projectFixture();
    project.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
    const deadlines: Record<string, number> = {};
    const lanes: Record<string, number> = {};
    await runServiceWorker({ ...serviceExecution(project, "exchange"), mode: "live" }, {
      project, once: true, telemetry: { emit() {} },
      env: { ENABLE_LIVE_M365: "true", AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222", ...liveTenantEnv },
      createDependencies: (_service, _config, telemetry) => ({ telemetry, results: { record() {}, recordDiagnostic() {} } }),
      execute: (config, dependencies) => {
        for (const probe of config.probes) lanes[probe.type] = config.PROBE_TIMEOUT_MS;
        return runCycle(config, {
          telemetry: dependencies.telemetry, results: dependencies.results,
          handler: async (probe, context) => {
            deadlines[probe.type] = context.config.PROBE_TIMEOUT_MS;
            return { ...baseResult(probe, Date.now()), success: true };
          },
        });
      },
    });
    expect(deadlines).toEqual({
      "exchange-mail-flow": 15000, "exchange-draft": 15000, "exchange-attachment": 15000, "exchange-reply": 30000,
      "exchange-distribution-list": 15000, "exchange-recurring-calendar": 15000, "exchange-meeting": 30000,
    });
    expect(Object.entries(lanes).filter(([, timeout]) => timeout === 15000).map(([type]) => type)).toEqual(["exchange-mail-flow"]);
    expect(new Set(Object.values(lanes))).toEqual(new Set([15000, 30000]));
  });

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
    const policy = projectFixture().healthModel;
    const reports = aggregateHealthReports("exchange", { ...cycle, results: cycle.results.filter(result => result.testId === "one") }, policy);
    expect(reports.find(report => report.entityName === "exchange-global" && report.body.signalName === "synthetic-success-percentage")?.body)
      .toMatchObject({ value: 0, healthState: "Unhealthy" });
    await vi.advanceTimersByTimeAsync(30000);
    expect(record).toHaveBeenCalledTimes(3);
    expect(reportHealth).toHaveBeenCalledOnce();
    expect(cycle.results.find(result => result.testId === "one")?.success).toBe(false);
  });
});
