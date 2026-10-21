import { describe, expect, it, vi } from "vitest";
import { aggregateHealthReports, createHealthReporter, type CycleResults } from "../src/health-reports.js";
import { readProjectConfig } from "../src/project-config.js";
import { baseResult } from "../src/probes.js";
import { runCycle } from "../src/runner.js";
import { parseServiceConfig, serviceSettings } from "../src/service-config.js";
import type { SyntheticResult } from "../src/contracts.js";

const project = await readProjectConfig("../monitoring.config.json");
const service = parseServiceConfig({
  type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation",
  cohort: "exchange-global", targets: [{ id: "opaque-target" }],
});
const sample = (): SyntheticResult => ({
  ...baseResult({ id: "opaque-target", type: "exchange-mail-flow", cohort: "exchange-global" }, Date.now()),
  success: true, durationMs: 2000,
  steps: [
    { name: "authenticate", status: "succeeded", durationMs: 100, observedAt: new Date().toISOString() },
    { name: "send", status: "succeeded", durationMs: 500, observedAt: new Date().toISOString() },
    { name: "confirm-delivery", status: "skipped", reason: "prerequisite-failed", observedAt: new Date().toISOString() },
  ],
});
const cycle = (results = [sample()]): CycleResults => ({ cycleId: "cycle-001", results });

describe("single-cycle journey/action health aggregation", () => {
  it("aggregates attempts per action without a per-target inventory or skipped failures", () => {
    const failed = sample();
    failed.success = false;
    failed.durationMs = 4000;
    failed.steps = [
      { name: "authenticate", status: "failed", durationMs: 300, diagnosticCategory: "authentication-failure", observedAt: new Date().toISOString() },
      { name: "send", status: "skipped", reason: "prerequisite-failed", observedAt: new Date().toISOString() },
    ];
    const reports = aggregateHealthReports("exchange", cycle([sample(), failed]), project.healthModel);
    expect(reports).toHaveLength(8);
    expect(reports.every(report => report.entityName === "exchange-global")).toBe(true);
    expect(reports.every(report => !/authenticate|cleanup/.test(report.body.signalName))).toBe(true);
    expect(reports.find(report => report.entityName === "exchange-global")?.body).toMatchObject({
      signalName: "synthetic-success-percentage", healthState: "Unhealthy", value: 50, expiresInMinutes: 15,
    });
    expect(reports.find(report => report.body.signalName === "send-mean-duration")?.body.value).toBe(500);
    expect(reports.find(report => report.body.signalName === "send-success-percentage")?.body).toMatchObject({ healthState: "Healthy", value: 100 });
    for (const report of reports.filter(report => report.body.signalName.startsWith("confirm-delivery-"))) {
      expect(report.body).toMatchObject({ healthState: "Unknown" });
      expect(report.body).not.toHaveProperty("value");
    }
    expect(JSON.stringify(reports)).not.toContain("opaque-target");
  });
  it.each([
    { successes: 100, expected: "Healthy" }, { successes: 99, expected: "Healthy" },
    { successes: 98, expected: "Degraded" }, { successes: 95, expected: "Degraded" },
    { successes: 94, expected: "Unhealthy" }, { successes: 0, expected: "Unhealthy" },
  ])("evaluates exact success boundaries: $successes%", ({ successes, expected }) => {
    const results = Array.from({ length: 100 }, (_, index) => ({ ...sample(), success: index < successes }));
    expect(aggregateHealthReports("exchange", cycle(results), project.healthModel)[0]?.body).toMatchObject({
      value: successes, healthState: expected,
    });
  });
  it.each([
    [15000, "Healthy"], [15001, "Degraded"], [60000, "Degraded"], [60001, "Unhealthy"],
  ])("evaluates exact duration boundary %s ms as %s", (durationMs, healthState) => {
    const result = { ...sample(), durationMs: Number(durationMs) };
    const duration = aggregateHealthReports("exchange", cycle([result]), project.healthModel)[1]!;
    expect(duration.body).toMatchObject({ value: durationMs, healthState });
  });
  it("does not turn absent observations into healthy success or zero duration", () => {
    const reports = aggregateHealthReports("exchange", cycle([]), project.healthModel);
    expect(reports.every(report => report.body.healthState === "Unknown" && report.body.value === undefined)).toBe(true);
  });
});

describe("direct health reports independent of OTEL", () => {
  it("uses no credentials/network in simulation and clearly previews rather than publishes", async () => {
    const output = { emit: vi.fn() };
    const credential = { getToken: vi.fn() };
    const fetcher = vi.fn();
    await createHealthReporter(project, service, output, {}, { credential, fetch: fetcher })(cycle());
    expect(credential.getToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.emit).toHaveBeenCalledTimes(8);
    expect(output.emit.mock.calls.every(([event]) => event === "health-report-preview")).toBe(true);
  });
  it("posts every aggregate to its service model with ARM audience and the documented payload", async () => {
    const output = { emit: vi.fn() };
    const credential = { getToken: vi.fn(async () => ({ token: "mock-token", expiresOnTimestamp: Date.now() + 60000 })) };
    const requests: { url: string; init: RequestInit }[] = [];
    let active = 0;
    let maximumActive = 0;
    const fetcher: typeof fetch = async (input, init) => {
      maximumActive = Math.max(maximumActive, ++active);
      requests.push({ url: String(input), init: init! });
      await Promise.resolve();
      active--;
      return new Response(null, { status: 204 });
    };
    await createHealthReporter({ ...project, otel: { enabled: false, destination: "console" } }, { ...service, mode: "live" }, output, {}, {
      credential, fetch: fetcher,
    })(cycle());
    expect(requests).toHaveLength(8);
    expect(new Set(requests.map(request => request.url)).size).toBe(1);
    expect(maximumActive).toBeLessThanOrEqual(3);
    expect(requests.every(request => request.url.includes("/healthmodels/m365-experience-poc-exchange/entities/exchange-") &&
      request.url.endsWith("/ingestHealthReport?api-version=2026-05-01-preview"))).toBe(true);
    expect(credential.getToken).toHaveBeenCalledWith("https://management.azure.com/.default", expect.anything());
    expect(requests[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
      signalName: "synthetic-success-percentage", healthState: "Healthy", value: 100, expiresInMinutes: 15,
    });
    expect(output.emit.mock.calls.filter(([event]) => event === "health-report-published")).toHaveLength(8);
  });
  it("fails explicitly on denied ingestion, tries other signals, and never logs response bodies or credentials", async () => {
    const output = { emit: vi.fn() };
    const fetcher = vi.fn(async () => new Response("private-response", { status: 403 }));
    const credential = { getToken: vi.fn(async () => ({ token: "private-token", expiresOnTimestamp: Date.now() + 60000 })) };
    await expect(createHealthReporter(project, { ...service, mode: "live" }, output, {}, { credential, fetch: fetcher })(cycle()))
      .rejects.toThrow("collector-failure");
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(output.emit.mock.calls.every(([event]) => event === "health-report-failed")).toBe(true);
    expect(JSON.stringify(output.emit.mock.calls)).not.toMatch(/private-response|private-token|health-report-published/);
  });
  it.each([200, 202, 404])("does not acknowledge unexpected status %s as ingestion", async status => {
    const credential = { getToken: async () => ({ token: "test", expiresOnTimestamp: Date.now() + 60000 }) };
    await expect(createHealthReporter(project, { ...service, mode: "live" }, { emit: vi.fn() }, {}, {
      credential, fetch: async () => new Response(null, { status }),
    })(cycle())).rejects.toThrow("collector-failure");
  });
  it("bounds safe report retries to two attempts without changing aggregate values", async () => {
    const attempts = new Map<string, number>();
    const credential = { getToken: async () => ({ token: "test", expiresOnTimestamp: Date.now() + 60000 }) };
    const fetcher: typeof fetch = async (url, init) => {
      const key = `${url}:${JSON.parse(String(init?.body)).signalName}`;
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      return new Response(null, { status: count === 1 ? 503 : 204 });
    };
    await createHealthReporter(project, { ...service, mode: "live" }, { emit: vi.fn() }, {}, {
      credential, fetch: fetcher, sleep: async () => undefined,
    })(cycle());
    expect(attempts.size).toBe(8);
    expect([...attempts.values()].every(count => count === 2)).toBe(true);
  });
});

describe("independent reporting failure paths", () => {
  const dependencies = () => ({
    telemetry: { emit: vi.fn() },
    results: { record: vi.fn(), recordDiagnostic: vi.fn(), forceFlush: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined) },
    reportHealth: vi.fn(async (_cycle: CycleResults) => undefined),
  });
  it("reports health even when OTEL flush fails", async () => {
    const deps = dependencies();
    deps.results.forceFlush.mockRejectedValue(new Error("export failed"));
    await expect(runCycle(serviceSettings(service, {}), deps)).rejects.toThrow("Synthetic cycle failed");
    expect(deps.reportHealth).toHaveBeenCalledWith(expect.objectContaining({ results: [expect.anything()] }));
  });
  it("still exports OTEL when health-report ingestion fails", async () => {
    const deps = dependencies();
    deps.reportHealth.mockRejectedValue(new Error("ingestion denied"));
    await expect(runCycle(serviceSettings(service, {}), deps)).rejects.toThrow("Synthetic cycle failed");
    expect(deps.results.forceFlush).toHaveBeenCalledOnce();
  });
  it("keeps executing/aggregating targets after a telemetry record failure without duplicating results", async () => {
    const deps = dependencies();
    deps.results.record.mockImplementation(() => { throw new Error("export failed"); });
    const selected = parseServiceConfig({ ...service, targets: [{ id: "target-one" }, { id: "target-two" }] });
    await expect(runCycle(serviceSettings(selected, {}), deps)).rejects.toThrow("Synthetic cycle failed");
    expect(deps.results.record).toHaveBeenCalledTimes(2);
    expect(deps.reportHealth.mock.calls[0]?.[0].results).toHaveLength(2);
    expect(deps.results.forceFlush).toHaveBeenCalledOnce();
  });
  it("does not publish a healthy partial aggregate after cancellation", async () => {
    const deps = dependencies();
    const stop = new AbortController();
    const selected = parseServiceConfig({
      ...service, mode: "live", targets: [
        { id: "target-one", mailbox: "synthetic@example.invalid" },
        { id: "target-two", mailbox: "synthetic@example.invalid" },
      ],
    });
    await runCycle(serviceSettings(selected, { ENABLE_LIVE_M365: "true" }), {
      ...deps,
      handler: async probe => {
        stop.abort();
        return { ...baseResult(probe, Date.now()), success: true, durationMs: 1 };
      },
    }, stop.signal);
    expect(deps.reportHealth).not.toHaveBeenCalled();
    expect(deps.results.forceFlush).toHaveBeenCalledOnce();
    expect(deps.telemetry.emit).toHaveBeenCalledWith("health-report-skipped-incomplete-cycle", expect.anything());
  });
});
