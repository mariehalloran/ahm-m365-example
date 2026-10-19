import { describe, expect, it, vi } from "vitest";
import { baseResult } from "../src/probes.js";
import { IntegrationError } from "../src/http.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../src/steps.js";
import { resultSchema } from "../src/contracts.js";

const sample = () => baseResult({ id: "ex-001", type: "exchange-mail-flow", cohort: "exchange-global" }, 1000);

describe("per-attempt step measurement", () => {
  it("returns an operation's value with one successful timed observation", async () => {
    const result = sample();
    let clock = 1000;
    const value = await measureStep(result, "authenticate", async () => { clock += 150; return "client"; }, () => clock);
    expect(value).toBe("client");
    expect(result.steps).toEqual([{
      name: "authenticate", status: "succeeded", observedAt: new Date(1150).toISOString(), durationMs: 150,
    }]);
  });
  it("rethrows the original error, records one failed duration and never stores its payload", async () => {
    const result = sample();
    const error = new Error("private response");
    let clock = 1000;
    await expect(measureStep(result, "send", async () => { clock += 200; throw error; }, () => clock, () => "send-failure"))
      .rejects.toBe(error);
    expect(result.steps).toMatchObject([{ name: "send", status: "failed", durationMs: 200, diagnosticCategory: "send-failure" }]);
    expect(JSON.stringify(result)).not.toContain("private response");
  });
  it("marks blocked steps skipped without fabricated durations or successes after authentication failure", async () => {
    const result = sample();
    const output = { emit: vi.fn() };
    const error = new IntegrationError("authentication-failure", 401);
    await expect(measureStep(result, "authenticate", async () => { throw error; }, () => 1000)).rejects.toBe(error);
    journeyFailure(result, error, output);
    await cleanupStep(result, false, vi.fn(), output, () => 1000);
    finishJourney(result, 1000, () => 1000);
    expect(resultSchema.safeParse(result).success).toBe(true);
    expect(result.steps.map(step => [step.name, step.status])).toEqual([
      ["authenticate", "failed"], ["create-draft", "skipped"], ["send", "skipped"],
      ["confirm-delivery", "skipped"], ["cleanup", "skipped"],
    ]);
    expect(result.steps.filter(step => step.status === "skipped").every(step => !("durationMs" in step))).toBe(true);
    expect(result.diagnosticContext.httpStatus).toBe(401);
  });
  it("runs cleanup with an independent non-cancelled ten-second budget after cancellation", async () => {
    const result = sample();
    const operationSignal = AbortSignal.abort();
    await expect(measureStep(result, "send", async () => operationSignal.throwIfAborted(), () => 1000)).rejects.toThrow();
    journeyFailure(result, operationSignal.reason, { emit: vi.fn() });
    const cleanup = vi.fn(async (signal: AbortSignal) => {
      expect(signal).not.toBe(operationSignal);
      expect(signal.aborted).toBe(false);
    });
    await cleanupStep(result, true, cleanup, { emit: vi.fn() }, () => 1000);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(result.steps).toMatchObject([
      { name: "send", status: "failed", diagnosticCategory: "cancelled" },
      { name: "cleanup", status: "succeeded" },
    ]);
  });
  it("fails the attempt on cleanup error while retaining previous successful step observations and timings", async () => {
    const result = sample();
    let clock = 1000;
    await measureStep(result, "send", async () => { clock += 100; }, () => clock);
    result.success = true;
    result.sendDurationMs = 100;
    await cleanupStep(result, true, async () => { clock += 200; throw new Error("private"); }, { emit: vi.fn() }, () => clock);
    expect(result).toMatchObject({ success: false, sendDurationMs: 100, diagnosticCategory: "cleanup-failure" });
    expect(result.steps).toMatchObject([
      { name: "send", status: "succeeded", durationMs: 100 },
      { name: "cleanup", status: "failed", durationMs: 200, diagnosticCategory: "cleanup-failure" },
    ]);
  });
  it("preserves primary failure and separately identifies cleanup failure", async () => {
    const result = sample();
    result.diagnosticCategory = "delivery-timeout";
    await cleanupStep(result, true, async () => { throw new Error("private"); }, { emit: vi.fn() }, () => 1000);
    expect(result.diagnosticCategory).toBe("delivery-timeout");
    expect(result.steps[0]).toMatchObject({ name: "cleanup", status: "failed", diagnosticCategory: "cleanup-failure" });
  });
});
