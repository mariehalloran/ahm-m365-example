import { describe, expect, it, vi } from "vitest";
import { aggregateHealthReports, createHealthReporter, serviceHealthReport, serviceHealthIssuesReport, type HealthReporter, type CycleResults } from "../src/health-reports.js";
import { readProjectConfig } from "../src/project-config.js";
import { baseResult } from "../src/probes.js";
import { runCycle } from "../src/runner.js";
import { parseServiceConfig, serviceSettings } from "../src/service-config.js";
import type { SyntheticResult } from "../src/contracts.js";
import type { ProviderDiagnostic } from "../src/provider-diagnostics.js";

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
  it("publishes only the observed lane without overwriting other journey entities", () => {
    const mail = aggregateHealthReports("exchange", cycle([sample()]), project.healthModel);
    expect(mail.every(report => report.entityName.startsWith("exchange-global"))).toBe(true);
    const draft: SyntheticResult = {
      ...baseResult({ id: "draft-target", type: "exchange-draft", cohort: "exchange-global" }, Date.now()),
      success: false, diagnosticCategory: "delivery-timeout",
    };
    const extended = aggregateHealthReports("exchange", cycle([draft]), project.healthModel);
    expect(extended.every(report => report.entityName.startsWith("exchange-draft"))).toBe(true);
    expect(extended[0]?.body).toMatchObject({ healthState: "Unhealthy", value: 0 });
  });
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
    expect(new Set(reports.map(report => report.entityName))).toEqual(new Set([
      "exchange-global", "exchange-global-create-draft", "exchange-global-send", "exchange-global-confirm-delivery",
    ]));
    expect(reports.every(report => !/authenticate|cleanup/.test(report.entityName))).toBe(true);
    expect(reports.find(report => report.entityName === "exchange-global")?.body).toMatchObject({
      signalName: "synthetic-success-percentage", healthState: "Unhealthy", value: 50, expiresInMinutes: 15,
    });
    expect(reports.find(report => report.entityName === "exchange-global-send" && report.body.signalName === "synthetic-mean-duration")?.body.value).toBe(500);
    expect(reports.find(report => report.entityName === "exchange-global-send")?.body).toMatchObject({ healthState: "Healthy", value: 100 });
    for (const report of reports.filter(report => report.entityName === "exchange-global-confirm-delivery")) {
      expect(report.body).toMatchObject({ healthState: "Unknown" });
      expect(report.body).not.toHaveProperty("value");
    }
    expect(JSON.stringify(reports)).not.toContain("opaque-target");
    for (const report of reports) {
      expect(JSON.parse(report.body.additionalContext).unit).toBe(
        report.body.signalName === "synthetic-success-percentage" ? "Percent" : "Milliseconds",
      );
      expect(report.body).not.toHaveProperty("dataUnit");
    }
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

describe("direct health reports", () => {
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
    await createHealthReporter(project, { ...service, mode: "live" }, output, {}, {
      credential, fetch: fetcher,
    })(cycle());
    expect(requests).toHaveLength(8);
    expect(new Set(requests.map(request => request.url)).size).toBe(4);
    expect(maximumActive).toBeLessThanOrEqual(3);
    expect(requests.every(request => request.url.includes("/healthmodels/m365-experience-poc-exchange/entities/exchange-") &&
      request.url.endsWith("/ingestHealthReport?api-version=2026-05-01-preview"))).toBe(true);
    expect(credential.getToken).toHaveBeenCalledWith("https://management.azure.com/.default", expect.anything());
    expect(requests[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
      signalName: "synthetic-success-percentage", healthState: "Healthy", value: 100, expiresInMinutes: 15,
    });
    expect(JSON.parse(JSON.parse(String(requests[0]!.init.body)).additionalContext)).toMatchObject({ unit: "Percent" });
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
    results: { record: vi.fn(), recordDiagnostic: vi.fn() },
    reportHealth: vi.fn<HealthReporter>(async () => undefined),
  });
  it("reports health even when console output fails", async () => {
    const deps = dependencies();
    deps.results.record.mockImplementation(() => { throw new Error("output failed"); });
    await expect(runCycle(serviceSettings(service, {}), deps)).rejects.toThrow("Synthetic cycle failed");
    expect(deps.reportHealth).toHaveBeenCalledWith(expect.objectContaining({ results: [expect.anything()] }));
  });
  it("still outputs observed results when health-report ingestion fails", async () => {
    const deps = dependencies();
    deps.reportHealth.mockRejectedValue(new Error("ingestion denied"));
    await expect(runCycle(serviceSettings(service, {}), deps)).rejects.toThrow("Synthetic cycle failed");
    expect(deps.results.record).toHaveBeenCalledOnce();
  });
  it("keeps executing/aggregating targets after a telemetry record failure without duplicating results", async () => {
    const deps = dependencies();
    deps.results.record.mockImplementation(() => { throw new Error("export failed"); });
    const selected = parseServiceConfig({ ...service, targets: [{ id: "target-one" }, { id: "target-two" }] });
    await expect(runCycle(serviceSettings(selected, {}), deps)).rejects.toThrow("Synthetic cycle failed");
    expect(deps.results.record).toHaveBeenCalledTimes(2);
    expect(deps.reportHealth).toHaveBeenCalledWith(expect.objectContaining({ results: expect.any(Array) }));
    expect((deps.reportHealth.mock.calls[0]?.[0] as CycleResults).results).toHaveLength(2);
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
    expect(deps.results.record).toHaveBeenCalled();
    expect(deps.telemetry.emit).toHaveBeenCalledWith("health-report-skipped-incomplete-cycle", expect.anything());
  });

  describe("observed stable Microsoft Service Health reports", () => {
    const diagnostic = (status: string): ProviderDiagnostic => ({
      kind: "overview", service: "exchange", collectedAt: new Date().toISOString(),
      serviceId: "Exchange", serviceName: "Exchange Online", status,
    });
    const report = (providerDiagnostics: ProviderDiagnostic[]) => serviceHealthReport("exchange", {
      cycleId: "provider-cycle", providerDiagnostics,
    }, project.healthModel.reportTtlMinutes);
    it("replaces stale/future or malformed overview observations with Unknown", () => {
      for (const record of [
        { ...diagnostic("serviceOperational"), collectedAt: new Date(Date.now() - 61 * 60000).toISOString() },
        { ...diagnostic("serviceOperational"), collectedAt: new Date(Date.now() + 60000).toISOString() },
        { ...diagnostic("serviceOperational"), status: "" },
      ]) {
        const observed = report([record]);
        expect(observed.body.healthState).toBe("Unknown");
        expect(observed.body).not.toHaveProperty("value");
      }
    });
    it.each([
      ["serviceOperational", 100, "Healthy"] as const,
      ["serviceInterruption", 0, "Unhealthy"] as const,
      ["serviceDegradation", 50, "Degraded"] as const,
    ])("maps observed overview %s to %s (%s)", (status, value, healthState) => {
      expect(report([diagnostic(String(status))])).toMatchObject({
        entityName: "exchange-service-health-health-overviews",
        body: { signalName: "microsoft-reported-service-status", value, healthState, expiresInMinutes: 15 },
      });
      expect(JSON.parse(report([diagnostic(String(status))]).body.additionalContext)).toMatchObject({ unit: "status-score" });
    });
    it.each(["unknownFutureStatus", "investigating", "restoringService", "serviceRestored", "resolved"]
      .map(status => ({ records: [diagnostic(status)] })).concat([{ records: [] }]))("reports missing/unrecognized observations as Unknown without a score", ({ records }) => {
      const observed = report(records);
      expect(observed.body.healthState).toBe("Unknown");
      expect(observed.body).not.toHaveProperty("value");
      expect(observed.body).not.toHaveProperty("evaluationRules");
    });
    it("does not turn a permission/collection failure or partial snapshot into a Microsoft outage or healthy data", () => {
      const observed = report([diagnostic("serviceOperational"), {
        kind: "failure", service: "exchange", collectedAt: "2026-10-19T12:00:00.000Z",
        source: "serviceAnnouncement.healthOverviews", apiVersion: "v1.0", category: "permission-failure", httpStatus: 403,
      }]);
      expect(observed.body.healthState).toBe("Unknown");
      expect(observed.body).not.toHaveProperty("value");
      expect(JSON.parse(observed.body.additionalContext)).toMatchObject({
        diagnosticCategories: ["permission-failure"], httpStatuses: [403],
      });
    });
    it("keeps issues and beta diagnostics out of status, even if their collection fails", () => {
      expect(report([diagnostic("serviceOperational"), {
        kind: "failure", service: "exchange", collectedAt: "2026-10-19T12:00:00.000Z",
        source: "serviceAnnouncement.issues", apiVersion: "v1.0", category: "permission-failure", httpStatus: 403,
      }, {
        kind: "failure", service: "exchange", collectedAt: "2026-10-19T12:00:00.000Z",
        source: "getConnectivityMetricsForExchange", apiVersion: "beta", category: "collector-failure",
      }]).body).toMatchObject({ healthState: "Healthy", value: 100 });
    });
    it("ignores other service snapshots, treats skipped source data as Unknown, and bounds approved context", () => {
      expect(report([{ ...diagnostic("serviceInterruption"), service: "teams" }]).body.healthState).toBe("Unknown");
      expect(report([diagnostic("serviceOperational"), {
        kind: "skipped", service: "exchange", collectedAt: "2026-10-19T12:00:00.000Z",
        source: "serviceAnnouncement.healthOverviews", apiVersion: "v1.0", reason: "simulation",
      }]).body).toMatchObject({ healthState: "Unknown" });
      const observed = report(Array.from({ length: 500 }, (_, index) => diagnostic(`${index}-${"x".repeat(120)}`)));
      expect(observed.body.additionalContext.length).toBeLessThan(1600);
      expect(JSON.parse(observed.body.additionalContext).statuses).toHaveLength(8);
    });
    it.each([
      { mode: "simulation" as const, serviceHealth: true },
      { mode: "live" as const, serviceHealth: false },
    ])("never publishes or previews provider state for $mode / enabled=$serviceHealth", async settings => {
      const output = { emit: vi.fn() };
      const credential = { getToken: vi.fn() };
      const fetcher = vi.fn();
      await createHealthReporter(project, { ...service, ...settings }, output, {}, { credential, fetch: fetcher })({
        cycleId: "provider-cycle", providerDiagnostics: [diagnostic("serviceInterruption")],
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(credential.getToken).not.toHaveBeenCalled();
      expect(output.emit).not.toHaveBeenCalled();
    });
    it.each(["exchange", "teams", "sharepoint"] as const)("uses the authenticated bounded publisher and selected %s model", async type => {
      const requests: { url: string; body: unknown }[] = [];
      const credential = { getToken: vi.fn(async () => ({ token: "test-only", expiresOnTimestamp: Date.now() + 60000 })) };
      await createHealthReporter(project, { ...service, type, mode: "live", serviceHealth: true } as typeof service, { emit: vi.fn() }, {}, {
        credential, fetch: async (url, init) => {
          requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return new Response(null, { status: 204 });
        },
      })({ cycleId: "provider-cycle", providerDiagnostics: [{ ...diagnostic("serviceOperational"), service: type }] });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.url).toContain(`/healthmodels/${project.healthModel.name}-${type}/entities/${type}-service-health-health-overviews/`);
      expect(requests[0]?.body).toMatchObject({ signalName: "microsoft-reported-service-status", healthState: "Healthy", value: 100 });
      expect(requests[1]?.url).toContain(`/entities/${type}-service-health-issues/`);
      expect(requests[1]?.body).toMatchObject({ signalName: "microsoft-reported-issue-count", healthState: "Unknown" });
      expect(credential.getToken).toHaveBeenCalledWith("https://management.azure.com/.default", expect.anything());
    });
  });

  describe("diagnostic issue counts", () => {
    const now = Date.parse("2026-10-26T12:30:00Z");
    const summary: ProviderDiagnostic = {
      kind: "issue-summary", service: "exchange", collectedAt: new Date(now).toISOString(), count: 0,
    };
    const report = (records: ProviderDiagnostic[]) =>
      serviceHealthIssuesReport("exchange", { cycleId: "issues", providerDiagnostics: records }, 15, now);
    it.each([0, 4])("displays a complete %i-issue snapshot without evaluating availability", count => {
      const observed = report([{ ...summary, count }]);
      expect(observed).toMatchObject({
        entityName: "exchange-service-health-issues",
        body: { signalName: "microsoft-reported-issue-count", healthState: "Unknown", value: count },
      });
      expect(observed.body).not.toHaveProperty("evaluationRules");
      expect(observed.body).not.toHaveProperty("dataUnit");
      expect(JSON.parse(observed.body.additionalContext)).toMatchObject({ unit: "Count", evaluated: false });
    });
    it("never converts absent, failed, stale, future, duplicate or other-service snapshots to zero issues", () => {
      for (const records of [
        [],
        [{ ...summary, collectedAt: new Date(now - 61 * 60000).toISOString() }],
        [{ ...summary, collectedAt: new Date(now + 60000).toISOString() }],
        [{ ...summary, service: "teams" as const }],
        [{ ...summary, count: -1 }],
        [summary, summary],
        [summary, { kind: "failure" as const, service: "exchange" as const, collectedAt: new Date(now).toISOString(),
          source: "serviceAnnouncement.issues" as const, apiVersion: "v1.0" as const, category: "permission-failure" as const }],
      ]) {
        expect(report(records).body.healthState).toBe("Unknown");
        expect(report(records).body).not.toHaveProperty("value");
      }
    });
  });
});
