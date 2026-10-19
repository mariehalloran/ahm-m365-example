import { describe, expect, it } from "vitest";
import { loadConfig } from "../../runner/src/config.js";
import { handlers } from "../../probes/src/registry.js";
import { exchangeProbe } from "../../probes/exchange/src/probe.js";
import { sharepointProbe } from "../../probes/sharepoint/src/probe.js";
import { resultSchema, type Probe } from "../src/contracts.js";
import { baseResult, simulate } from "../src/probes.js";

const now = Date.parse("2026-10-16T20:00:00Z");
const telemetry = { emit: () => undefined };

describe("shared probe boundaries", () => {
  it("registers only implemented live journeys", () => {
    expect(handlers).toEqual({ "exchange-mail-flow": exchangeProbe, "sharepoint-file": sharepointProbe });
  });
  it.each([
    ["healthy", true, 3200, null],
    ["slow", true, 30000, null],
    ["failed", false, 3200, "send-failure"],
    ["timeout", false, 65000, "delivery-timeout"],
    ["stale", true, 3200, null],
  ] as const)("preserves deterministic %s outcomes for both services", async (scenario, success, durationMs, diagnosticCategory) => {
    const config = loadConfig({ SYNTHETIC_SCENARIO: scenario });
    for (const type of ["exchange-mail-flow", "sharepoint-file"] as const) {
      const probe: Probe = { id: "simulated-probe", type, cohort: "simulated-cohort" };
      const result = resultSchema.parse(await simulate(probe, { config, telemetry, now: () => now, signal: AbortSignal.timeout(1000) }));
      expect(result).toMatchObject({ testType: type, success, durationMs, diagnosticCategory, diagnosticContext: { testStage: "simulated" } });
      expect(Date.parse(result.observedAt) < now).toBe(scenario === "stale");
      expect(result).not.toHaveProperty("expiresAt");
      expect(result.deliveryDurationMs !== undefined).toBe(type === "exchange-mail-flow" && success);
    }
  });
  it("keeps a per-probe scenario override", async () => {
    const config = loadConfig({});
    const probe: Probe = { id: "simulated-probe", type: "exchange-mail-flow", cohort: "simulated-cohort", scenario: "failed" };
    expect(await simulate(probe, { config, telemetry, now: () => now, signal: AbortSignal.timeout(1000) }))
      .toMatchObject({ success: false, diagnosticCategory: "send-failure" });
  });
  it("rejects expired/state-bearing legacy results and invented delivery measurements", () => {
    const sample = baseResult({ id: "test-001", type: "exchange-mail-flow", cohort: "exchange-global" }, now);
    expect(resultSchema.safeParse({ ...sample, schemaVersion: "1.0" }).success).toBe(false);
    expect(resultSchema.safeParse({ ...sample, expiresAt: new Date(now + 1000).toISOString() }).success).toBe(false);
    expect(resultSchema.safeParse({ ...sample, healthState: "Healthy" }).success).toBe(false);
    expect(resultSchema.safeParse({ ...sample, durationMs: 1000, deliveryDurationMs: 500, diagnosticCategory: "delivery-timeout" }).success).toBe(false);
    expect(resultSchema.safeParse({ ...sample, success: true, diagnosticContext: { cleanupSucceeded: false } }).success).toBe(false);
  });
});
