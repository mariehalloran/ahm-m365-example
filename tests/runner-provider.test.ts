import { describe, expect, it, vi } from "vitest";
import { RecordingSink } from "../src/ahm.js";
import { loadConfig } from "../src/config.js";
import { IntegrationError } from "../src/http.js";
import { providerReport } from "../src/provider.js";
import { runCycle } from "../src/runner.js";
import { MemoryStateStore } from "../src/state.js";
import { baseResult } from "../src/probes.js";

const telemetry = { emit: vi.fn() };
describe("complete-cycle runner", () => {
  it.each([
    ["healthy", "Healthy"], ["slow", "Degraded"], ["failed", "Unhealthy"],
    ["timeout", "Unhealthy"], ["stale", "Unknown"],
  ] as const)("runs %s through the same aggregation and reporting pipeline", async (scenario, expected) => {
    const config = loadConfig({ SYNTHETIC_SCENARIO: scenario });
    const sink = new RecordingSink();
    const state = new MemoryStateStore();
    await runCycle(config, { sink, state, telemetry });
    const result = await runCycle(config, { sink, state, telemetry });
    expect(result.reports[0]?.state).toBe(expected);
    expect(result.reports.at(-1)).toMatchObject({ entity: "runner-heartbeat", state: "Healthy" });
    expect(result.results).toHaveLength(3);
  });
  it("does not allow provider degradation to change healthy tenant evidence", async () => {
    const result = await runCycle(loadConfig({ PROVIDER_SCENARIO: "degraded" }), {
      sink: new RecordingSink(), state: new MemoryStateStore(), telemetry,
    });
    expect(result.reports[0]?.state).toBe("Healthy");
    expect(result.reports[1]?.state).toBe("Degraded");
  });
  it("reports provider healthy while tenant synthetics are unhealthy", async () => {
    const result = await runCycle(loadConfig({ SYNTHETIC_SCENARIO: "failed", CONSECUTIVE_FAILURES: "1" }), {
      sink: new RecordingSink(), state: new MemoryStateStore(), telemetry,
    });
    expect(result.reports.slice(0, 2).map(item => item.state)).toEqual(["Unhealthy", "Healthy"]);
  });
  it("never emits a healthy heartbeat when state persistence fails", async () => {
    const sink = new RecordingSink();
    await expect(runCycle(loadConfig({}), {
      sink, telemetry, state: { load: async () => ({}), save: async () => { throw new Error("storage unavailable"); } },
    })).rejects.toThrow("Synthetic cycle failed");
    expect(sink.reports.filter(item => item.entity === "runner-heartbeat").map(item => item.state)).toEqual(["Unknown"]);
  });
  it("never emits a healthy heartbeat when ingestion fails", async () => {
    const sink = new RecordingSink();
    const submit = vi.spyOn(sink, "submit").mockRejectedValueOnce(new IntegrationError("permission-failure"));
    await expect(runCycle(loadConfig({}), { sink, state: new MemoryStateStore(), telemetry })).rejects.toThrow();
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ entity: "runner-heartbeat", state: "Unknown" }), expect.any(AbortSignal));
  });
  it("immediately marks an aborted execution as incomplete", async () => {
    const sink = new RecordingSink();
    await expect(runCycle(loadConfig({}), { sink, state: new MemoryStateStore(), telemetry }, AbortSignal.abort())).rejects.toThrow();
    expect(sink.reports).toHaveLength(1);
    expect(sink.reports[0]?.state).toBe("Unknown");
  });
  it("isolates unknown regional evidence and supports another handler without changing ingestion", async () => {
    const config = loadConfig({
      EXECUTION_MODE: "live", ENABLE_LIVE_M365: "true", MIN_FRESH_SAMPLES: "1",
      PROBES_JSON: JSON.stringify([
        { id: "exchange-region-001", type: "exchange-mail-flow", cohort: "exchange-regional", mailbox: "dedicated@example.invalid" },
        { id: "sharepoint-region-001", type: "sharepoint-file", cohort: "sharepoint-regional", siteId: "site", driveId: "drive", folderId: "folder" },
      ]),
    });
    const report = await runCycle(config, {
      sink: new RecordingSink(), state: new MemoryStateStore(), telemetry,
      handlers: {
        "exchange-mail-flow": async () => { throw new IntegrationError("permission-failure"); },
        "sharepoint-file": async (probe, { now = Date.now }) => ({
          ...baseResult(probe, now(), 900), success: true, durationMs: 1000,
        }),
      },
    });
    expect(report.reports.find(item => item.entity === "exchange-regional")?.state).toBe("Unknown");
    expect(report.reports.find(item => item.entity === "sharepoint-regional")?.state).toBe("Healthy");
    expect(report.reports.find(item => item.entity === "graph-availability")?.state).toBe("Unhealthy");
    expect(report.reports.at(-1)?.state).toBe("Healthy");
  });
});

describe("Graph-shaped provider fixtures", () => {
  it.each([
    ["operational", "Healthy"], ["degraded", "Degraded"], ["throttled", "Unknown"],
    ["unauthorized", "Unknown"], ["forbidden", "Unknown"], ["unavailable", "Unknown"],
    ["malformed", "Unknown"], ["stale", "Unknown"],
  ] as const)("maps provider scenario %s to %s", async (scenario, state) => {
    const report = await providerReport(loadConfig({ PROVIDER_SCENARIO: scenario }), undefined, "cycle", telemetry, AbortSignal.timeout(1000));
    expect(report.state).toBe(state);
  });
});

describe("safe configuration", () => {
  it("requires explicit live mutation consent and dedicated resources", () => {
    expect(() => loadConfig({ EXECUTION_MODE: "live" })).toThrow("ENABLE_LIVE_M365");
    expect(() => loadConfig({ EXECUTION_MODE: "live", ENABLE_LIVE_M365: "true" })).toThrow("Missing dedicated resources");
  });
  it("rejects duplicate IDs, mixed cohorts and invalid thresholds", () => {
    const probe = { id: "probe-001", type: "exchange-mail-flow", cohort: "cohort-global" };
    expect(() => loadConfig({ PROBES_JSON: JSON.stringify([probe, probe]) })).toThrow("unique");
    expect(() => loadConfig({ PROBES_JSON: JSON.stringify([probe, { ...probe, id: "probe-002", type: "sharepoint-file" }]) })).toThrow("mix");
    expect(() => loadConfig({ HEALTHY_SUCCESS_RATE: "0.90" })).toThrow("threshold");
  });
});
