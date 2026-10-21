import { describe, expect, it, vi } from "vitest";
import { isReportedStep, testTypes, type SyntheticResult } from "../src/contracts.js";
import { baseResult, simulate } from "../src/probes.js";
import { createResultOutput, outcomeOf } from "../src/results.js";

const stamp = "2026-10-19T12:00:00.000Z";
function result(overrides: Partial<SyntheticResult> = {}): SyntheticResult {
  return {
    ...baseResult({ id: "ex-001", type: "exchange-mail-flow", cohort: "exchange-global" }, Date.parse(stamp)),
    success: true, durationMs: 1600, deliveryDurationMs: 700, ...overrides,
  };
}

describe("structured console results", () => {
  it.each(testTypes)("outputs one result per %s attempt and preserves skipped steps without fabricated timings", async type => {
    const output = { emit: vi.fn() };
    const results = createResultOutput(output);
    const sample = await simulate({ id: "opaque-probe", type, cohort: "opaque-cohort" }, {
      config: { SYNTHETIC_SCENARIO: "failed", PROBE_TIMEOUT_MS: 45000, POLL_INTERVAL_MS: 100 },
      signal: new AbortController().signal, telemetry: output, now: () => Date.parse(stamp),
    });
    results.record(sample, "simulation");
    const calls = output.emit.mock.calls.filter(([event]) => event === "synthetic-result");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      mode: "simulation", outcome: "failure", result: { success: false, steps: sample.steps.filter(step => isReportedStep(step.name)) },
    });
    const projected = calls[0]?.[1].result as SyntheticResult;
    expect(projected.steps.filter(step => step.status === "skipped").every(step => !("durationMs" in step))).toBe(true);
    expect(JSON.stringify(calls)).not.toMatch(/authenticate|authenticationDurationMs|cleanupSucceeded/);
  });
  it("keeps cleanup failures and completed journey timings while projecting out internal steps and diagnostics", () => {
    const output = { emit: vi.fn() };
    createResultOutput(output).record(result({
      success: false, diagnosticCategory: "cleanup-failure",
      diagnosticContext: { cleanupSucceeded: false, authenticationDurationMs: 100, testStage: "cleanup" },
      steps: [
        { name: "authenticate", status: "succeeded", observedAt: stamp, durationMs: 100 },
        { name: "send", status: "succeeded", observedAt: stamp, durationMs: 100 },
        { name: "confirm-delivery", status: "succeeded", observedAt: stamp, durationMs: 600 },
        { name: "cleanup", status: "failed", observedAt: stamp, durationMs: 100, diagnosticCategory: "cleanup-failure" },
      ],
    }), "live");
    expect(output.emit).toHaveBeenCalledExactlyOnceWith("synthetic-result", expect.objectContaining({
      outcome: "failure", result: expect.objectContaining({
        success: false, deliveryDurationMs: 700, diagnosticCategory: "cleanup-failure", diagnosticContext: { testStage: "execution" },
        steps: [expect.objectContaining({ name: "send" }), expect.objectContaining({ name: "confirm-delivery" })],
      }),
    }));
  });
  it("rejects malformed results before output", () => {
    const output = { emit: vi.fn() };
    expect(() => createResultOutput(output).record({ ...result(), durationMs: -1 }, "live")).toThrow();
    expect(output.emit).not.toHaveBeenCalled();
  });
  it("keeps approved stable and beta diagnostics separate from synthetic observations", () => {
    const output = { emit: vi.fn() };
    const results = createResultOutput(output);
    results.recordDiagnostic({
      kind: "overview", service: "exchange", collectedAt: stamp,
      serviceId: "Exchange", serviceName: "Exchange Online", status: "serviceDegradation",
    });
    results.recordDiagnostic({
      kind: "activity", service: "exchange", collectedAt: stamp, function: "getConnectivityMetricsForExchange",
      intervalStart: stamp, intervalEnd: stamp, aggregationIntervalMinutes: 15, percentage: 99.5,
    });
    results.recordDiagnostic({
      kind: "failure", service: "exchange", collectedAt: stamp,
      source: "serviceAnnouncement.healthOverviews", apiVersion: "v1.0", category: "permission-failure", httpStatus: 403,
    });
    expect(output.emit.mock.calls.map(([event]) => event)).toEqual(Array(3).fill("provider-diagnostic"));
    expect(output.emit.mock.calls[0]?.[1]).toMatchObject({
      body: "m365-service-health-overview", attributes: { "provider.status": "serviceDegradation", "provider.api_version": "v1.0" },
    });
    expect(output.emit.mock.calls[1]?.[1].attributes).not.toHaveProperty("provider.status");
    expect(output.emit.mock.calls[2]?.[1].attributes).toMatchObject({ "provider.http_status": 403, "provider.category": "permission-failure" });
    expect(() => results.recordDiagnostic({
      kind: "overview", service: "exchange", collectedAt: stamp,
      serviceId: "Exchange", serviceName: "Exchange Online", status: "serviceOperational", privateData: "secret",
    } as never)).toThrow();
    expect(output.emit).toHaveBeenCalledTimes(3);
  });
  it.each([
    ["authentication-failure", "unexecutable"], ["permission-failure", "unexecutable"],
    ["collector-failure", "unexecutable"], ["configuration-failure", "unexecutable"],
    ["malformed-response", "unexecutable"], ["graph-throttling", "unexecutable"], ["cancelled", "unexecutable"],
    ["send-failure", "failure"], ["delivery-timeout", "failure"], ["read-failure", "failure"],
    ["cleanup-failure", "failure"], ["graph-unavailable", "failure"],
  ] as const)("classifies %s as %s without inventing successful attempts", (diagnosticCategory, outcome) => {
    expect(outcomeOf(result({ success: false, diagnosticCategory }))).toBe(outcome);
    expect(outcomeOf(result())).toBe("success");
  });
});
