import { describe, expect, it, vi } from "vitest";
import { baseResult } from "../src/probes.js";
import { IntegrationError } from "../src/http.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../src/steps.js";
import { resultSchema } from "../src/contracts.js";

const sample = () => baseResult({ id: "ex-001", type: "exchange-mail-flow", cohort: "exchange-global" }, 1000);

describe("per-attempt step measurement", () => {
  it.each([true, false])("never executes disabled cleanup (mutation attempted: %s)", async mutated => {
    const result = sample();
    const operation = vi.fn();
    const output = { emit: vi.fn() };
    await cleanupStep(result, mutated, operation, output, () => 1000, false);
    expect(operation).not.toHaveBeenCalled();
    expect(result.steps).toEqual([{
      name: "cleanup", status: "skipped", observedAt: new Date(1000).toISOString(), reason: "cleanup-disabled",
    }]);
    expect(result.diagnosticContext).not.toHaveProperty("cleanupSucceeded");
    expect(output.emit).toHaveBeenCalledWith("exchange-cleanup-disabled", expect.objectContaining({
      mode: "live", mutationAttempted: mutated,
    }));
  });
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
  it("reports an operator hint with the failed step event, without it ever entering the result", () => {
    const result = sample();
    const output = { emit: vi.fn() };
    const error = new IntegrationError("malformed-response", undefined, "schema:value.3.body.content(invalid_type)");
    result.steps.push({ name: "send", status: "failed", observedAt: new Date(0).toISOString(), durationMs: 1, diagnosticCategory: "malformed-response" });
    journeyFailure(result, error, output);
    expect(output.emit).toHaveBeenCalledWith("probe-stage-failed", expect.objectContaining({
      step: "send", category: "malformed-response", detail: "schema:value.3.body.content(invalid_type)",
    }));
    expect(JSON.stringify(result)).not.toContain("invalid_type");
  });
  it("records the value-free hint of an integration error with the failed step and nothing else of the error", async () => {
    const result = sample();
    const hint = "schema:@odata.nextLink(too_big)";
    await expect(measureStep(result, "send", async () => { throw new IntegrationError("malformed-response", 200, hint); }, () => 1000))
      .rejects.toBeInstanceOf(IntegrationError);
    expect(result.steps).toEqual([{
      name: "send", status: "failed", observedAt: new Date(1000).toISOString(), durationMs: 0,
      diagnosticCategory: "malformed-response", detail: hint,
    }]);
  });
  it.each([
    ["an integration error without a hint", () => new IntegrationError("send-failure", 500)],
    ["an unexpected error", () => new Error("private subject text")],
  ])("adds no detail for %s", async (_label, failure) => {
    const result = sample();
    await expect(measureStep(result, "send", async () => { throw failure(); }, () => 1000)).rejects.toThrow();
    expect(result.steps[0]).not.toHaveProperty("detail");
    expect(JSON.stringify(result)).not.toContain("private subject text");
  });
  it("bounds a hint to 200 characters so a failure never becomes an invalid result", async () => {
    const result = sample();
    const error = new IntegrationError("malformed-response", undefined, `schema:${"x".repeat(500)}`);
    await expect(measureStep(result, "send", async () => { throw error; }, () => 1000)).rejects.toBe(error);
    journeyFailure(result, error, { emit: vi.fn() });
    finishJourney(result, 1000, () => 1000);
    const failed = result.steps.find(step => step.status === "failed");
    expect(failed && "detail" in failed ? failed.detail : undefined).toBe(error.detail!.slice(0, 200));
    expect(resultSchema.safeParse(result).success).toBe(true);
  });
  it("accepts a detail only on a failed step", async () => {
    const result = sample();
    await measureStep(result, "create-draft", async () => undefined, () => 1000);
    const error = new IntegrationError("send-failure", undefined, "hint");
    await expect(measureStep(result, "send", async () => { throw error; }, () => 1000)).rejects.toBe(error);
    journeyFailure(result, error, { emit: vi.fn() });
    finishJourney(result, 1000, () => 1000);
    expect(resultSchema.safeParse(result).success).toBe(true);
    const succeeded = result.steps.find(step => step.status === "succeeded")!;
    const failed = result.steps.find(step => step.status === "failed")!;
    for (const [step, detail, valid] of [[failed, "x".repeat(200), true], [failed, "x".repeat(201), false], [succeeded, "hint", false]] as const) {
      const steps = result.steps.map(candidate => candidate === step ? { ...candidate, detail } : candidate);
      expect(resultSchema.safeParse({ ...result, steps }).success).toBe(valid);
    }
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
