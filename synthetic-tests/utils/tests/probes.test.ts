import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { probeServices, resultSchema, type Probe } from "../src/contracts.js";
import { baseResult, simulate } from "../src/probes.js";

const now = Date.parse("2026-10-16T20:00:00Z");
const telemetry = { emit: () => undefined };

describe("shared probe boundaries", () => {
  it.each([
    ["healthy", true, 3200, null],
    ["slow", true, 30000, null],
    ["failed", false, 3200, "send-failure"],
    ["timeout", false, 65000, "delivery-timeout"],
    ["stale", true, 3200, null],
  ] as const)("preserves deterministic %s outcomes for both services", async (scenario, success, durationMs, diagnosticCategory) => {
    const config = loadConfig({ SYNTHETIC_SCENARIO: scenario });
    for (const type of ["exchange-mail-flow", "sharepoint-file", "teams-channel-message"] as const) {
      const probe: Probe = { id: "simulated-probe", type, cohort: "simulated-cohort" };
      const result = resultSchema.parse(await simulate(probe, { config, telemetry, now: () => now, signal: AbortSignal.timeout(1000) }));
      expect(result).toMatchObject({
        testType: type, success, durationMs,
        diagnosticCategory: type === "sharepoint-file" && scenario === "failed" ? "read-failure" : diagnosticCategory,
        diagnosticContext: { testStage: "simulated" },
      });
      expect(Date.parse(result.observedAt) < now).toBe(scenario === "stale");
      expect(result).not.toHaveProperty("expiresAt");
      expect(result.deliveryDurationMs !== undefined).toBe(type === "exchange-mail-flow" && success);
      expect(result.sendDurationMs !== undefined).toBe(type !== "sharepoint-file");
      expect(result.publicationDurationMs !== undefined).toBe(type === "teams-channel-message" && success);
      expect(result.uploadDurationMs !== undefined).toBe(type === "sharepoint-file");
      expect(result.readDurationMs !== undefined).toBe(type === "sharepoint-file");
      expect(result.steps.map(step => step.name)).toEqual(probeServices[type].steps);
      expect(result.steps.every(step => step.observedAt === result.observedAt)).toBe(true);
      expect(result.steps.at(-1)?.status).toBe("succeeded");
      const failed = result.steps.filter(step => step.status === "failed");
      expect(failed).toHaveLength(success ? 0 : 1);
      if (scenario === "failed") {
        expect(failed[0]?.name).toBe(type === "exchange-mail-flow" ? "send" : type === "teams-channel-message" ? "post-message" : "read-file");
      }
      if (scenario === "timeout") {
        expect(failed[0]?.name).toBe(type === "exchange-mail-flow" ? "confirm-delivery" : type === "teams-channel-message" ? "confirm-publication" : "read-file");
      }
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
  it("rejects send durations that are negative, longer than the attempt/delivery, or assigned to another service", () => {
    const sample = {
      ...baseResult({ id: "test-001", type: "exchange-mail-flow", cohort: "exchange-global" }, now),
      success: true,
      durationMs: 1000,
    };
    expect(resultSchema.safeParse({ ...sample, sendDurationMs: -1 }).success).toBe(false);
    expect(resultSchema.safeParse({ ...sample, sendDurationMs: 1001 }).success).toBe(false);
    expect(resultSchema.safeParse({ ...sample, sendDurationMs: 501, deliveryDurationMs: 500 }).success).toBe(false);
    expect(resultSchema.safeParse({
      ...sample, testType: "sharepoint-file", targetService: "SharePoint Online", sendDurationMs: 100,
    }).success).toBe(false);
    expect(resultSchema.safeParse({ ...sample, sendDurationMs: 250 }).success).toBe(true);
  });
  it("keeps publication and file phase timings attached only to their own services", () => {
    const teams = {
      ...baseResult({ id: "teams-001", type: "teams-channel-message", cohort: "teams-global" }, now),
      success: true, durationMs: 1000, sendDurationMs: 200, publicationDurationMs: 700,
    };
    expect(resultSchema.safeParse(teams).success).toBe(true);
    expect(resultSchema.safeParse({ ...teams, publicationDurationMs: 1001 }).success).toBe(false);
    expect(resultSchema.safeParse({ ...teams, success: false, diagnosticCategory: "read-failure" }).success).toBe(false);
    expect(resultSchema.safeParse({ ...teams, uploadDurationMs: 100 }).success).toBe(false);
    const sharepoint = {
      ...baseResult({ id: "sp-001", type: "sharepoint-file", cohort: "sharepoint-global" }, now),
      success: true, durationMs: 1000, uploadDurationMs: 100, readDurationMs: 200,
    };
    expect(resultSchema.safeParse(sharepoint).success).toBe(true);
    expect(resultSchema.safeParse({ ...sharepoint, readDurationMs: 1001 }).success).toBe(false);
    expect(resultSchema.safeParse({ ...sharepoint, publicationDurationMs: 100 }).success).toBe(false);
  });
});
