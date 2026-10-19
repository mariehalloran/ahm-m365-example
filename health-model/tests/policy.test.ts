import { describe, expect, it } from "vitest";
import { loadConfig } from "../../runner/src/config.js";
import { resultSchema, type SyntheticResult } from "../../shared/src/contracts.js";
import { aggregate, individualState, type History } from "../src/policy.js";
import { baseResult } from "../../shared/src/probes.js";

const now = Date.parse("2026-10-16T20:00:00Z");
const config = loadConfig({});
const telemetry = { emit: () => undefined };
const probe = config.probes[0]!;
const result = (updates: Partial<SyntheticResult> = {}) => ({ ...baseResult(probe, now, 900), success: true, durationMs: 3200, ...updates });

describe("normalized contract and individual health", () => {
  it("rejects private/unrecognized fields and invalid timestamps", () => {
    expect(resultSchema.safeParse({ ...result(), messageBody: "private" }).success).toBe(false);
    expect(resultSchema.safeParse(result({ expiresAt: new Date(now - 1).toISOString() })).success).toBe(false);
    expect(resultSchema.safeParse(result({ targetService: "SharePoint Online" })).success).toBe(false);
  });
  it("accepts the plan's optional fields and resolves cohort from the configured probe", () => {
    const raw = config.probes.map(item => ({
      schemaVersion: "1.0", testType: item.type, testId: item.id, targetService: "Exchange Online",
      success: true, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 900000).toISOString(),
      correlationId: crypto.randomUUID(),
    }));
    expect(resultSchema.safeParse(raw[0]).success).toBe(true);
    const report = aggregate(config.probes, raw, config, {}, now, "cycle", telemetry).reports[0]!;
    expect(report).toMatchObject({ entity: "exchange-global", state: "Healthy" });
  });
  it.each([[15000, "Healthy"], [15001, "Degraded"], [60000, "Degraded"], [60001, "Unhealthy"]] as const)(
    "maps the exact latency boundary %s to %s", (durationMs, state) => {
      expect(individualState(result({ durationMs }), config, now)).toBe(state);
    });
  it("maps missing, expired, future and unexecutable data to Unknown", () => {
    for (const item of [
      undefined, { bad: true }, result({ observedAt: new Date(now - 900000).toISOString() }),
      result({ observedAt: new Date(now + 61000).toISOString() }),
      result({ success: false, diagnosticCategory: "permission-failure" }),
    ]) expect(individualState(item, config, now)).toBe("Unknown");
  });
});

describe("cohort policy", () => {
  const cohort = (successes: number, count = 100) => {
    const probes = Array.from({ length: count }, (_, i) => ({ ...probe, id: `probe-${i}` }));
    const results = probes.map((item, index) => ({
      ...baseResult(item, now, 900), success: index < successes, durationMs: 1000,
      diagnosticCategory: index < successes ? null : "send-failure" as const,
    }));
    return { probes, results };
  };
  it.each([[100, "Healthy"], [99, "Healthy"], [98, "Degraded"], [95, "Degraded"], [94, "Unhealthy"]] as const)(
    "maps %s percent success to %s", (successes, expected) => {
      const sample = cohort(successes);
      const outcome = aggregate(sample.probes, sample.results, { ...config, CONSECUTIVE_FAILURES: 1 }, {}, now, "cycle", telemetry);
      expect(outcome.reports[0]?.state).toBe(expected);
      expect(outcome.reports[0]?.context.successRate).toBe(successes / 100);
    });
  it("uses p95 latency independently of success rate", () => {
    const sample = cohort(100);
    sample.results.forEach(item => { item.durationMs = 30000; });
    const report = aggregate(sample.probes, sample.results, config, {}, now, "cycle", telemetry).reports[0]!;
    expect(report.state).toBe("Degraded");
    expect(report.context.p95DurationMs).toBe(30000);
  });
  it("does not count duplicates, wrong cohorts, stale or missing tests", () => {
    const samples = config.probes.map(item => ({ ...result(), testId: item.id }));
    for (const values of [
      samples.slice(1), [...samples, samples[0]],
      samples.map(item => ({ ...item, cohort: "other-cohort" })),
      samples.map(item => ({ ...item, expiresAt: new Date(now).toISOString(), observedAt: new Date(now - 1000).toISOString() })),
    ]) expect(aggregate(config.probes, values, config, {}, now, "cycle", telemetry).reports[0]?.state).toBe("Unknown");
  });
  it("requires consecutive failures and recoveries; never carries health over stale evidence", () => {
    const failed = cohort(0, 3);
    const good = cohort(3, 3);
    let history: History = {};
    const run = (results: unknown[], time = now) => {
      const outcome = aggregate(failed.probes, results, config, history, time, "cycle", telemetry);
      history = outcome.history;
      return outcome.reports[0]?.state;
    };
    expect(run(failed.results)).toBe("Degraded");
    expect(run(failed.results)).toBe("Unhealthy");
    expect(run(good.results)).toBe("Degraded");
    expect(run(good.results)).toBe("Healthy");
    expect(run(good.results, now + 900000)).toBe("Unknown");
    expect(run(failed.results)).toBe("Degraded");
  });
  it("bounds report expiration by the earliest accepted sample", () => {
    const samples = config.probes.map(item => ({ ...baseResult(item, now - 30000, 900), success: true }));
    const report = aggregate(config.probes, samples, config, {}, now, "cycle", telemetry).reports[0]!;
    expect(Date.parse(report.expiresAt)).toBe(now + 870000);
  });
});
