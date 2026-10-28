import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { aggregateHealthReports, createHealthReporter, groupHealthReports, serviceActivityReports, serviceHealthReport, serviceHealthIssuesReport, teamsCallSignals, type HealthReport, type HealthReporter, type CycleResults } from "../src/health-reports.js";
import { groupSignalName, reportingGroups, tenantSignalName } from "../src/groups.js";
import { parseProjectDocument, selectTenant, serviceExecution, type ProjectConfig, type ProjectDocument } from "../src/project-config.js";
import { documentFixture, multiTenantFixture, projectFixture } from "./fixtures.js";
import { baseResult } from "../src/probes.js";
import { runCycle } from "../src/runner.js";
import { parseServiceConfig, serviceSettings, type ServiceConfig } from "../src/service-config.js";
import { runServiceWorker } from "../src/worker.js";
import { probeServices, testTypes, type SyntheticResult, type TestType } from "../src/contracts.js";
import { modelCatalog } from "../src/catalog.js";
import type { ProviderDiagnostic } from "../src/provider-diagnostics.js";
import { activityFunctions, isPercentageActivity } from "../src/provider-catalog.js";
import { serviceHealthNames } from "../src/service-health.js";

const project = projectFixture();
const providerProject = { ...project, serviceHealth: { enabled: true } };
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

describe("shared runtime/model catalogue", () => {
  it("keeps the checked-in Bicep projection fresh", async () => {
    const projection = await readFile(new URL("../src/catalog.json", import.meta.url), "utf8");
    expect(projection, "Run npm run catalog:generate after editing the catalogue").toBe(
      `${JSON.stringify(modelCatalog, null, 2)}\n`,
    );
  });
  it("propagates filesystem failures from the projection freshness check", async () => {
    const failure = Object.assign(new Error("Cannot read catalogue projection"), { code: "EACCES" });
    const argv = process.argv;
    process.argv = [...argv, "--check"];
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(failure), writeFile: vi.fn(),
    }));
    try {
      await expect(import("../src/catalog-projection.js")).rejects.toBe(failure);
    } finally {
      vi.doUnmock("node:fs/promises");
      process.argv = argv;
    }
  });
  it("preserves service-specific literal contracts for callers", () => {
    expectTypeOf<Extract<(typeof probeServices)[TestType], { service: "teams" }>["journey"]>()
      .toEqualTypeOf<"channel-conversation" | "scheduled-meeting">();
    expectTypeOf(probeServices["exchange-mail-flow"].target).toEqualTypeOf<"Exchange Online">();
  });
  it.each(testTypes)("reports %s only on its deployed journey and business-step entities", type => {
    const definition = probeServices[type];
    const journey = modelCatalog.serviceDefinitions.find(service => service.service === definition.service)!
      .journeys.find(journey => journey.name === definition.journey)!;
    const observed: SyntheticResult = {
      ...baseResult({ id: "catalogue-test-target", type, cohort: `${definition.service}-global` }, Date.now()),
      success: true, durationMs: 100,
      steps: definition.steps.map(name => ({
        name, status: "succeeded", observedAt: new Date().toISOString(), durationMs: 1,
      })),
    };
    const reports = aggregateHealthReports(definition.service, cycle([observed]), project.healthModel);
    expect(new Set(reports.map(report => report.entityName))).toEqual(new Set([
      journey.entityName, ...journey.steps.map(step => `${journey.entityName}-${step.name}`),
    ]));
    expect(reports.every(report => report.body.value !== undefined)).toBe(true);
    expect(JSON.stringify(reports)).not.toContain("catalogue-test-target");
  });
});

describe("single-cycle journey/action health aggregation", () => {
  it("returns only aggregated connection and disconnection metrics on the call entity", () => {
    const observedAt = "2026-10-26T16:00:00.000Z";
    const call: SyntheticResult = {
      ...baseResult({ id: "bot-target", type: "teams-call", cohort: "teams-global" }, Date.parse(observedAt)),
      success: true, durationMs: 3000,
      steps: [
        { name: "place-call", status: "succeeded", durationMs: 500, observedAt },
        { name: "wait-for-answer", status: "succeeded", durationMs: 1500, observedAt },
        { name: "end-call", status: "succeeded", durationMs: 1000, observedAt },
      ],
    };
    const failed: SyntheticResult = {
      ...call, success: false, diagnosticCategory: "delivery-timeout",
      steps: [
        { name: "place-call", status: "succeeded", durationMs: 500, observedAt },
        { name: "wait-for-answer", status: "failed", durationMs: 19500, diagnosticCategory: "delivery-timeout", observedAt },
        { name: "end-call", status: "succeeded", durationMs: 500, observedAt },
      ],
    };
    const reports = aggregateHealthReports("teams", cycle([call, failed]), project.healthModel);
    const measurement = (signal: string) => reports.find(report => report.body.signalName === signal)!;
    expect(measurement("teams-call-connection-success-percentage").body).toMatchObject({ value: 50, healthState: "Unhealthy" });
    expect(measurement("teams-call-mean-connection-duration").body.value).toBe(11000);
    expect(measurement("teams-call-disconnection-success-percentage").body.value).toBe(100);
    expect(measurement("teams-call-mean-disconnection-duration").body.value).toBe(750);
    expect(JSON.parse(measurement("teams-call-disconnection-success-percentage").body.additionalContext)).toMatchObject({
      attempted: 2, succeeded: 2, skipped: 0, unit: "Percent", observedAt,
      evidence: "graph-confirmed-meeting-connectivity",
    });
    expect(reports.some(report => /play-audio|playback/.test(`${report.entityName}/${report.body.signalName}`))).toBe(false);
    expect(reports.filter(report => report.body.signalName.startsWith("teams-call-")).every(report => report.entityName === "teams-call")).toBe(true);
    expect(JSON.stringify(reports)).not.toContain("bot-target");
  });
  it("does not invent call measurements when no business action executed", () => {
    const call = baseResult({ id: "bot-target", type: "teams-call", cohort: "teams-global" }, Date.now());
    call.diagnosticCategory = "configuration-failure";
    const reports = aggregateHealthReports("teams", cycle([call]), project.healthModel)
      .filter(report => report.body.signalName.startsWith("teams-call-"));
    expect(reports).toHaveLength(4);
    expect(reports.every(report => report.body.value === undefined && report.body.healthState === "Unknown")).toBe(true);
  });
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
    const diagnostic = (status: string): Extract<ProviderDiagnostic, { kind: "overview" }> => ({
      kind: "overview", service: "exchange", collectedAt: new Date().toISOString(),
      serviceId: "Exchange", serviceName: "Exchange Online", status,
    });
    const report = (providerDiagnostics: ProviderDiagnostic[]) => serviceHealthReport("exchange", {
      cycleId: "provider-cycle", providerDiagnostics,
    }, project.healthModel.reportTtlMinutes);
    it("reports stale/future or malformed overview observations as Unknown without a value", () => {
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
        entityName: "exchange-service-health",
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
    it("ignores other service snapshots, leaves missing source data Unknown, and bounds approved context", () => {
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
      await createHealthReporter(providerProject, { ...service, ...settings }, output, {}, { credential, fetch: fetcher })({
        cycleId: "provider-cycle", providerDiagnostics: [diagnostic("serviceInterruption")],
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(credential.getToken).not.toHaveBeenCalled();
      expect(output.emit).not.toHaveBeenCalled();
    });
    it.each(["exchange", "teams", "onedrive"] as const)("uses the authenticated bounded publisher and selected %s model", async type => {
      const requests: { url: string; body: unknown }[] = [];
      const credential = { getToken: vi.fn(async () => ({ token: "test-only", expiresOnTimestamp: Date.now() + 60000 })) };
      await createHealthReporter(providerProject, { ...service, type, mode: "live", serviceHealth: true } as typeof service, { emit: vi.fn() }, {}, {
        credential, fetch: async (url, init) => {
          requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return new Response(null, { status: 204 });
        },
      })({ cycleId: "provider-cycle", providerDiagnostics: [{
        ...diagnostic("serviceOperational"), service: type, serviceName: serviceHealthNames[type],
        serviceId: type === "onedrive" ? "OneDriveForBusiness" : "reported-service",
      }, { kind: "issue-summary", service: type, collectedAt: new Date().toISOString(), count: 0 }] });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.url).toContain(`/healthmodels/${project.healthModel.name}-${type}/entities/${type}-service-health/`);
      expect(requests[0]?.body).toMatchObject({ signalName: "microsoft-reported-service-status", healthState: "Healthy", value: 100 });
      expect(requests[1]?.url).toBe(requests[0]?.url);
      expect(requests[1]?.body).toMatchObject({ signalName: "microsoft-reported-issue-count", healthState: "Unknown", value: 0 });
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
        entityName: "exchange-service-health",
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

  describe("one supporting entity for stable and approved beta sources", () => {
    const now = Date.parse("2026-10-26T12:30:00Z");
    it.each(["exchange", "teams", "onedrive"] as const)("publishes distinct %s signals together without any per-API destinations", async type => {
      const selected = parseServiceConfig({
        ...service, type, cohort: `${type}-global`, mode: "live", serviceHealth: true,
        serviceActivity: { enabled: type !== "onedrive" },
      });
      const providerDiagnostics: ProviderDiagnostic[] = [
        {
          kind: "overview", service: type, collectedAt: new Date(now).toISOString(),
          serviceId: type === "onedrive" ? "OneDriveForBusiness" : "reported-service",
          serviceName: serviceHealthNames[type], status: "serviceDegradation",
        },
        { kind: "issue-summary", service: type, collectedAt: new Date(now).toISOString(), count: 2 },
        ...activityFunctions[type].map(functionName => ({
          kind: "activity" as const, service: type, collectedAt: new Date(now).toISOString(), function: functionName,
          intervalStart: "2026-10-26T12:15:00.000Z", intervalEnd: new Date(now).toISOString(),
          aggregationIntervalMinutes: 15 as const, ...(isPercentageActivity(functionName) ? { percentage: 97 } : { value: 120 }),
        })),
      ];
      const requests: { url: string; body: Record<string, unknown> }[] = [];
      vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        await createHealthReporter(providerProject, selected, { emit: vi.fn() }, {}, {
          credential: { getToken: async () => ({ token: "unit-test-token", expiresOnTimestamp: now + 60000 }) },
          fetch: async (url, init) => {
            requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            return new Response(null, { status: 204 });
          },
        })({ cycleId: "all-provider-sources", providerDiagnostics });
      } finally {
        vi.restoreAllMocks();
      }
      expect(requests).toHaveLength(2 + activityFunctions[type].length);
      expect(new Set(requests.map(request => request.url)).size).toBe(1);
      expect(requests[0]?.url).toContain(`/healthmodels/${project.healthModel.name}-${type}/entities/${type}-service-health/ingestHealthReport?`);
      expect(new Set(requests.map(request => request.body.signalName))).toEqual(new Set([
        "microsoft-reported-service-status", "microsoft-reported-issue-count",
        ...activityFunctions[type].map(name => `microsoft-activity-${name}`),
      ]));
      expect(requests[0]?.body).toMatchObject({ healthState: "Degraded", value: 50 });
      expect(requests[1]?.body).toMatchObject({ healthState: "Unknown", value: 2 });
      expect(requests.slice(2).every(({ body }) =>
        body.healthState === "Unknown" && !("evaluationRules" in body))).toBe(true);
      for (const { body } of requests) {
        const context = JSON.parse(String(body.additionalContext));
        expect(context).toMatchObject({
          cycleId: "all-provider-sources",
          apiVersion: String(body.signalName).startsWith("microsoft-activity-") ? "beta" : "v1.0",
        });
        expect(context.source).toBe(String(body.signalName).startsWith("microsoft-activity-")
          ? String(body.signalName).slice("microsoft-activity-".length)
          : body.signalName === "microsoft-reported-service-status"
            ? "serviceAnnouncement.healthOverviews" : "serviceAnnouncement.issues");
        expect(body).not.toHaveProperty("dataUnit");
      }
      expect(requests.every(({ body }) => !String(body.signalName).startsWith("synthetic-"))).toBe(true);
    });

    it.each(["exchange", "teams", "onedrive"] as const)("does not publish unavailable %s provider observations", async type => {
      const selected = parseServiceConfig({
        ...service, type, cohort: `${type}-global`, mode: "live", serviceHealth: true,
        serviceActivity: { enabled: type !== "onedrive" },
      });
      const credential = { getToken: vi.fn() };
      const fetcher = vi.fn();
      const output = { emit: vi.fn() };
      const overview: ProviderDiagnostic = {
        kind: "overview", service: type, collectedAt: new Date().toISOString(),
        serviceId: type === "onedrive" ? "OneDriveForBusiness" : "reported-service",
        serviceName: serviceHealthNames[type], status: "investigating",
      };
      for (const providerDiagnostics of [
        [],
        [overview],
        [{ ...overview, status: "" }],
        [{ ...overview, status: "serviceOperational", collectedAt: new Date(Date.now() - 61 * 60000).toISOString() }],
      ]) {
        await createHealthReporter(providerProject, selected, output, {}, { credential, fetch: fetcher })({
          cycleId: "unavailable-provider-data", providerDiagnostics,
        });
      }
      expect(fetcher).not.toHaveBeenCalled();
      expect(credential.getToken).not.toHaveBeenCalled();
      expect(output.emit).not.toHaveBeenCalled();
    });

    it.each(["authentication-failure", "permission-failure"] as const)("publishes nothing when provider collection fails with %s", async category => {
      const selected = parseServiceConfig({
        ...service, mode: "live", serviceHealth: true,
        serviceActivity: { enabled: true, functions: ["getConnectivityMetricsForExchange"] },
      });
      const collectedAt = new Date().toISOString();
      const credential = { getToken: vi.fn() };
      const fetcher = vi.fn();
      await createHealthReporter(providerProject, selected, { emit: vi.fn() }, {}, { credential, fetch: fetcher })({
        cycleId: "failed-provider-data", providerDiagnostics: [
          { kind: "failure", service: "exchange", collectedAt, category, source: "serviceAnnouncement.healthOverviews", apiVersion: "v1.0" },
          { kind: "failure", service: "exchange", collectedAt, category, source: "serviceAnnouncement.issues", apiVersion: "v1.0" },
          { kind: "failure", service: "exchange", collectedAt, category, source: "getConnectivityMetricsForExchange", apiVersion: "beta" },
        ],
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(credential.getToken).not.toHaveBeenCalled();
    });

    it.each([
      ["serviceOperational", 100, "Healthy"],
      ["serviceDegradation", 50, "Degraded"],
      ["serviceInterruption", 0, "Unhealthy"],
    ] as const)("publishes observed %s availability and zero issues despite an unavailable sibling", async (status, value, healthState) => {
      const selected = parseServiceConfig({
        ...service, mode: "live", serviceHealth: true,
        serviceActivity: { enabled: true, functions: ["getConnectivityMetricsForExchange"] },
      });
      const collectedAt = new Date().toISOString();
      const bodies: Record<string, unknown>[] = [];
      await createHealthReporter(providerProject, selected, { emit: vi.fn() }, {}, {
        credential: { getToken: async () => ({ token: "unit-test-token", expiresOnTimestamp: Date.now() + 60000 }) },
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 204 });
        },
      })({
        cycleId: "partially-available-provider-data", providerDiagnostics: [
          { kind: "overview", service: "exchange", collectedAt, serviceId: "Exchange", serviceName: "Exchange Online", status },
          { kind: "issue-summary", service: "exchange", collectedAt, count: 0 },
          { kind: "failure", service: "exchange", collectedAt, category: "permission-failure",
            source: "getConnectivityMetricsForExchange", apiVersion: "beta", httpStatus: 403 },
        ],
      });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toMatchObject({ signalName: "microsoft-reported-service-status", value, healthState });
      expect(bodies[1]).toMatchObject({ signalName: "microsoft-reported-issue-count", value: 0, healthState: "Unknown" });
    });

    it("reports OneDrive Unknown without data when stable collection is missing or denied", () => {
      const failure: ProviderDiagnostic = {
        kind: "failure", service: "onedrive", collectedAt: new Date(now).toISOString(),
        source: "serviceAnnouncement.healthOverviews", apiVersion: "v1.0", category: "permission-failure", httpStatus: 403,
      };
      for (const providerDiagnostics of [[], [failure]]) {
        const report = serviceHealthReport("onedrive", { cycleId: "onedrive-provider", providerDiagnostics }, 15, now);
        expect(report).toMatchObject({
          entityName: "onedrive-service-health",
          body: { signalName: "microsoft-reported-service-status", healthState: "Unknown" },
        });
        expect(report.body).not.toHaveProperty("value");
        expect(JSON.parse(report.body.additionalContext).diagnosticCategories)
          .toEqual(providerDiagnostics.length ? ["permission-failure"] : ["no-data"]);
      }
    });
    it("never publishes provider reports when the root opt-in is absent or disabled", async () => {
      const credential = { getToken: vi.fn() };
      const fetcher = vi.fn();
      const selected = {
        ...service, mode: "live" as const, serviceHealth: true,
        serviceActivity: { ...service.serviceActivity, enabled: true },
      };
      await createHealthReporter(project, selected, { emit: vi.fn() }, {}, { credential, fetch: fetcher })({
        cycleId: "disabled-provider", providerDiagnostics: [],
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(credential.getToken).not.toHaveBeenCalled();
    });
    it("reports denied beta metrics as Unknown without inventing a value", () => {
      const observed = serviceActivityReports({
        ...service, serviceActivity: { ...service.serviceActivity, enabled: true, functions: ["getConnectivityMetricsForExchange"] },
      }, { cycleId: "denied-beta", providerDiagnostics: [{
        kind: "failure", service: "exchange", collectedAt: new Date(now).toISOString(),
        source: "getConnectivityMetricsForExchange", apiVersion: "beta", category: "permission-failure", httpStatus: 403,
      }] }, 15, now);
      expect(observed).toHaveLength(1);
      expect(observed[0]?.body.healthState).toBe("Unknown");
      expect(observed[0]?.body).not.toHaveProperty("value");
      expect(JSON.parse(observed[0]!.body.additionalContext)).toMatchObject({
        diagnosticCategories: ["permission-failure"], httpStatuses: [403],
      });
    });
  });
});

describe("user group reports", () => {
  const document = multiTenantFixture();
  const contoso = selectTenant(document, "contoso");
  const fabrikam = selectTenant(document, "fabrikam");
  const observed = (id: string, type: TestType, success = true): SyntheticResult => ({
    ...baseResult({ id, type, cohort: "group-test" }, Date.now()),
    success, durationMs: success ? 100 : 1000, diagnosticCategory: success ? null : "send-failure",
  });
  const withSteps = (result: SyntheticResult): SyntheticResult => ({
    ...result, steps: probeServices[result.testType].steps.map(name => ({
      name, status: "succeeded" as const, observedAt: new Date().toISOString(), durationMs: 5,
    })),
  });
  const summary = (reports: HealthReport[]) => reports.map(report => [report.entityName, report.body.signalName, report.body.healthState]);
  const successState = (reports: HealthReport[], group: string) => reports.find(report =>
    report.body.signalName === `group-${group}--tenant-contoso--synthetic-success-percentage`)?.body.healthState;

  it("re-aggregates each group's own results on journey entities as group-<id>--tenant-<alias>--<signal>", () => {
    const reports = groupHealthReports(contoso, "exchange", cycle([
      observed("pair-a", "exchange-mail-flow"), observed("pair-a", "exchange-draft"),
      observed("pair-b", "exchange-mail-flow", false),
    ]));
    expect(summary(reports)).toEqual([
      ["exchange-global", "group-priority--tenant-contoso--synthetic-success-percentage", "Healthy"],
      ["exchange-global", "group-priority--tenant-contoso--synthetic-mean-duration", "Healthy"],
      ["exchange-draft", "group-priority--tenant-contoso--synthetic-success-percentage", "Healthy"],
      ["exchange-draft", "group-priority--tenant-contoso--synthetic-mean-duration", "Healthy"],
      ["exchange-global", "group-field--tenant-contoso--synthetic-success-percentage", "Unhealthy"],
      ["exchange-global", "group-field--tenant-contoso--synthetic-mean-duration", "Healthy"],
    ]);
    expect(reports[0]!.body).toMatchObject({ value: 100, expiresInMinutes: contoso.healthModel.reportTtlMinutes });
    expect(JSON.parse(reports[0]!.body.additionalContext)).toMatchObject({ attempted: 1, succeeded: 1, cycleId: "cycle-001" });
  });

  it("reports only journey entities, never steps or provider entities", () => {
    const results = ["exchange-mail-flow", "exchange-draft", "exchange-attachment"].map(type =>
      withSteps(observed("pair-a", type as TestType)));
    const entities = new Set(groupHealthReports(contoso, "exchange", cycle(results)).map(report => report.entityName));
    expect(entities).toEqual(new Set(["exchange-global", "exchange-draft", "exchange-attachment"]));
    const overall = new Set(aggregateHealthReports("exchange", cycle(results), contoso.healthModel).map(report => report.entityName));
    expect(overall.size).toBeGreaterThan(entities.size);
    expect([...entities].every(entity => overall.has(entity))).toBe(true);
  });

  it("keeps one group's failure from changing another group's state", () => {
    const states = (pairB: boolean) => {
      const reports = groupHealthReports(contoso, "exchange", cycle([
        observed("pair-a", "exchange-mail-flow"), observed("pair-b", "exchange-mail-flow", pairB),
      ]));
      return [successState(reports, "priority"), successState(reports, "field")];
    };
    expect(states(true)).toEqual(["Healthy", "Healthy"]);
    expect(states(false)).toEqual(["Healthy", "Unhealthy"]);
  });

  it("counts targets outside every group in the overall signals and in no group", () => {
    const results = cycle([observed("pair-a", "exchange-mail-flow"), observed("pair-b", "exchange-mail-flow", false)]);
    const overall = aggregateHealthReports("exchange", results, fabrikam.healthModel)[0]!;
    expect(overall.body).toMatchObject({ signalName: "synthetic-success-percentage", value: 50, healthState: "Unhealthy" });
    const grouped = groupHealthReports(fabrikam, "exchange", results);
    expect(grouped.map(report => report.body.signalName)).toEqual([
      "group-priority--tenant-fabrikam--synthetic-success-percentage", "group-priority--tenant-fabrikam--synthetic-mean-duration",
    ]);
    expect(grouped[0]!.body).toMatchObject({ value: 100, healthState: "Healthy" });
    expect(JSON.parse(overall.body.additionalContext).attempted).toBe(2);
    expect(JSON.parse(grouped[0]!.body.additionalContext).attempted).toBe(1);
  });

  it("publishes nothing for groups without results and never a placeholder", () => {
    expect(groupHealthReports(contoso, "exchange", cycle([]))).toEqual([]);
    const onlyPairA = groupHealthReports(contoso, "exchange", cycle([observed("pair-a", "exchange-mail-flow")]));
    expect(onlyPairA.some(report => report.body.signalName.startsWith("group-field--"))).toBe(false);
    expect(onlyPairA.every(report => report.body.healthState !== "Unknown" && report.body.value !== undefined)).toBe(true);
    expect(groupHealthReports(fabrikam, "exchange", cycle([observed("pair-b", "exchange-mail-flow")]))).toEqual([]);
    const now = new Date().toISOString();
    const failedCall: SyntheticResult = {
      ...observed("fabrikam-meeting", "teams-call", false),
      steps: [
        { name: "place-call", status: "failed", observedAt: now, durationMs: 10, diagnosticCategory: "send-failure" },
        ...(["wait-for-answer", "verify-meeting-metadata", "verify-participants", "end-call"] as const).map(name =>
          ({ name, status: "skipped" as const, reason: "prerequisite-failed" as const, observedAt: now })),
      ],
    };
    expect(aggregateHealthReports("teams", cycle([failedCall]), fabrikam.healthModel)
      .filter(report => report.body.healthState === "Unknown" && report.body.signalName.startsWith("teams-call-")))
      .toHaveLength(4);
    expect(groupHealthReports(fabrikam, "teams", cycle([failedCall])).map(report => [report.body.signalName, report.body.healthState]))
      .toEqual([
        ["group-priority--tenant-fabrikam--synthetic-success-percentage", "Unhealthy"],
        ["group-priority--tenant-fabrikam--synthetic-mean-duration", "Healthy"],
      ]);
  });

  it("reports channel and meeting journeys from their own members, adding the call phases for meetings", () => {
    const channelAndMeeting = (tenant: string) => cycle([
      observed(`${tenant}-channel`, "teams-channel-message"), withSteps(observed(`${tenant}-meeting`, "teams-call")),
    ]);
    expect(summary(groupHealthReports(fabrikam, "teams", channelAndMeeting("fabrikam"))).map(([entity, signal]) => `${entity}:${signal}`)).toEqual([
      "teams-call:group-priority--tenant-fabrikam--synthetic-success-percentage",
      "teams-call:group-priority--tenant-fabrikam--synthetic-mean-duration",
      ...teamsCallSignals.map(signal => `teams-call:group-priority--tenant-fabrikam--${signal}`),
      "teams-global:group-bridge--tenant-fabrikam--synthetic-success-percentage",
      "teams-global:group-bridge--tenant-fabrikam--synthetic-mean-duration",
    ]);
    expect(groupHealthReports(contoso, "teams", channelAndMeeting("contoso")).map(report => report.entityName))
      .toEqual(["teams-global", "teams-global"]);
  });

  it("publishes group reports beside the overall reports on the same service model, for result cycles only", async () => {
    const project = selectTenant(multiTenantFixture(), "fabrikam");
    project.serviceHealth.enabled = true;
    const requests: [string, HealthReport["body"]][] = [];
    const fetcher: typeof fetch = async (url, init) => {
      requests.push([String(url), JSON.parse(String(init?.body))]);
      return new Response(null, { status: 204 });
    };
    const credential = { getToken: async () => ({ token: "mock", expiresOnTimestamp: Date.now() + 60000 }) };
    const reporter = (type: "exchange" | "teams") => createHealthReporter(
      project, { ...serviceExecution(project, type), mode: "live" as const, serviceHealth: true }, { emit: vi.fn() }, {},
      { credential, fetch: fetcher },
    );
    await reporter("exchange")(cycle([observed("pair-a", "exchange-mail-flow")]));
    const exchangeModel = "healthmodels/m365-experience-poc-exchange/entities/";
    expect(requests.every(([url]) => url.includes(exchangeModel))).toBe(true);
    const published = requests.map(([url, body]) => `${url.split(exchangeModel)[1]!.split("/")[0]}:${body.signalName}`);
    expect(published.sort()).toEqual([
      ...["exchange-global", "exchange-global-create-draft", "exchange-global-send", "exchange-global-confirm-delivery"]
        .flatMap(entity => ["synthetic-success-percentage", "synthetic-mean-duration"]
          .map(signal => `${entity}:${tenantSignalName("fabrikam", signal)}`)),
      "exchange-global:group-priority--tenant-fabrikam--synthetic-success-percentage",
      "exchange-global:group-priority--tenant-fabrikam--synthetic-mean-duration",
    ].sort());
    requests.length = 0;
    const now = new Date().toISOString();
    await reporter("teams")({
      cycleId: "provider", providerDiagnostics: [{
        kind: "overview", service: "teams", collectedAt: now, serviceId: "Teams", serviceName: "Microsoft Teams", status: "serviceOperational",
      }],
    });
    expect(requests.map(([, body]) => body.signalName)).toEqual(["tenant-fabrikam--microsoft-reported-service-status"]);
  });

  it("leaves ungrouped projects exactly as before", async () => {
    const output = { emit: vi.fn() };
    const ungrouped = projectFixture();
    await createHealthReporter(ungrouped, service, output, {})(cycle());
    const previews = output.emit.mock.calls.filter(([event]) => event === "health-report-preview");
    expect(previews).toHaveLength(aggregateHealthReports("exchange", cycle(), ungrouped.healthModel).length);
    expect(previews.some(([, preview]) => preview.body.signalName.startsWith("group-"))).toBe(false);
  });

  describe("contract between the reportingGroups plan and the signals workers publish", () => {
    const bicepSignals = (entity: string) => [
      "synthetic-success-percentage", "synthetic-mean-duration", ...(entity === "teams-call" ? teamsCallSignals : []),
    ];
    const entityOf = (service: string, journey: string) => probeServices[testTypes.find(type =>
      probeServices[type].service === service && probeServices[type].journey === journey)!].entityName;
    const journeyEntities = testTypes.map(type => probeServices[type].entityName);

    // Runs every tenant's three workers once in simulation, collecting the previewed signal names by entity.
    async function simulate(source: ProjectDocument) {
      const group = new Map<string, string[]>();
      const overall = new Map<string, Map<string, string[]>>();
      for (const tenant of source.tenants) {
        overall.set(tenant.id, new Map());
        for (const type of ["exchange", "teams", "onedrive"] as const) {
          const project = selectTenant(source, tenant.id);
          const telemetry = { emit: vi.fn() };
          await runServiceWorker(serviceExecution(project, type), { project, once: true, env: {}, telemetry });
          for (const [event, preview] of telemetry.emit.mock.calls) {
            if (event !== "health-report-preview") continue;
            const names = preview.body.signalName.startsWith("group-") ? group : overall.get(tenant.id)!;
            names.set(preview.entityName, [...(names.get(preview.entityName) ?? []), preview.body.signalName]);
          }
        }
      }
      return { group, overall };
    }

    it.each([
      ["one tenant", documentFixture],
      ["two tenants with a group spanning both", multiTenantFixture],
    ])("publishes exactly the group signals the plan lists as aggregation members, for every journey entity: %s", async (_label, makeDocument) => {
      const source = makeDocument();
      const expected = new Map<string, string[]>();
      for (const group of reportingGroups(source)) {
        for (const scope of group.scopes) {
          for (const journey of scope.journeys) {
            const entity = entityOf(scope.service, journey);
            expected.set(entity, [...(expected.get(entity) ?? []),
              ...bicepSignals(entity).map(signal => groupSignalName(group.id, scope.tenant, signal))]);
          }
        }
      }
      const { group: published } = await simulate(source);
      expect([...expected.keys()].sort()).toEqual([...journeyEntities].sort());
      expect([...published.keys()].sort()).toEqual([...journeyEntities].sort());
      for (const entity of journeyEntities) {
        expect([...published.get(entity)!].sort(), entity).toEqual([...expected.get(entity)!].sort());
      }
      if (source.tenants.length > 1) {
        const tenantsOf = (entity: string) => new Set(published.get(entity)!.filter(name => name.startsWith("group-priority--"))
          .map(name => name.split("--")[1]));
        expect(tenantsOf("exchange-global")).toEqual(new Set(["tenant-contoso", "tenant-fabrikam"]));
      }
    });

    it("tenant-qualifies the overall signals exactly when the document has several tenants, without collisions", async () => {
      const plain = new Set<string>(["synthetic-success-percentage", "synthetic-mean-duration", ...teamsCallSignals]);
      for (const source of [documentFixture(), multiTenantFixture()]) {
        const { overall } = await simulate(source);
        const several = source.tenants.length > 1;
        const publishers = new Map<string, string[]>();
        for (const [alias, entities] of overall) {
          const prefix = `tenant-${alias}--`;
          // All tenants run the same services, so unqualified names would collide on every entity.
          expect([...entities.keys()].sort(), alias).toEqual([...overall.values().next().value!.keys()].sort());
          for (const [entity, names] of entities) {
            for (const name of new Set(names)) {
              expect(several ? name.startsWith(prefix) && plain.has(name.slice(prefix.length)) : plain.has(name), `${alias}: ${name}`).toBe(true);
              publishers.set(`${entity}:${name}`, [...(publishers.get(`${entity}:${name}`) ?? []), alias]);
            }
          }
        }
        expect(overall.size).toBe(source.tenants.length);
        expect([...publishers.values()].every(aliases => aliases.length === 1)).toBe(true);
      }
    });
  });

  describe("tenant-qualified overall signals", () => {
    type AnyCycle = Parameters<HealthReporter>[0];
    // The tenant's project from the two-tenant document, or the same tenant alone in a one-tenant document without groups.
    const projectFor = (alias: string, alone = false): ProjectConfig => {
      const source = multiTenantFixture();
      if (alone) {
        source.tenants = source.tenants.filter(tenant => tenant.id === alias);
        source.groups = [];
      }
      const project = selectTenant(parseProjectDocument(source), alias);
      project.serviceHealth.enabled = true;
      return project;
    };
    // Publishes one cycle through the live reporter and returns "entity:signalName" for every ingested report.
    const published = async (project: ProjectConfig, type: ServiceConfig["type"], reported: AnyCycle) => {
      const names: string[] = [];
      const base = serviceExecution(project, type);
      const live = { ...base, mode: "live" as const, serviceHealth: true, serviceActivity: { ...base.serviceActivity, enabled: type !== "onedrive" } };
      await createHealthReporter(project, live, { emit: vi.fn() }, {}, {
        credential: { getToken: async () => ({ token: "unit-test-token", expiresOnTimestamp: Date.now() + 60000 }) },
        fetch: async (url, init) => {
          names.push(`${String(url).split("/entities/")[1]!.split("/")[0]}:${JSON.parse(String(init?.body)).signalName}`);
          return new Response(null, { status: 204 });
        },
      })(reported);
      return names;
    };
    const providerCycle = (type: "exchange" | "teams"): AnyCycle => {
      const at = Date.now();
      const collectedAt = new Date(at - 1000).toISOString();
      const intervalEnd = at - 60000;
      return {
        cycleId: "provider", providerDiagnostics: [
          { kind: "overview", service: type, collectedAt, serviceId: "reported-service", serviceName: serviceHealthNames[type], status: "serviceOperational" },
          { kind: "issue-summary", service: type, collectedAt, count: 0 },
          ...activityFunctions[type].map(functionName => ({
            kind: "activity" as const, service: type, collectedAt, function: functionName,
            intervalStart: new Date(intervalEnd - 15 * 60000).toISOString(), intervalEnd: new Date(intervalEnd).toISOString(),
            aggregationIntervalMinutes: 15 as const, ...(isPercentageActivity(functionName) ? { percentage: 99 } : { value: 10 }),
          })),
        ],
      };
    };
    // Every publishing path: journey/step/call-phase results, Service Health and activity.
    const everything = async (project: ProjectConfig) => {
      const [pairA, pairB] = project.services.exchange.targets.map(target => target.id);
      const channel = project.services.teams.targets[0]!.id;
      const meeting = project.services.teams.callTargets[0]!.id;
      return [
        ...await published(project, "exchange", cycle([withSteps(observed(pairA!, "exchange-mail-flow")), withSteps(observed(pairB!, "exchange-mail-flow"))])),
        ...await published(project, "teams", cycle([withSteps(observed(channel, "teams-channel-message")), withSteps(observed(meeting, "teams-call"))])),
        ...await published(project, "exchange", providerCycle("exchange")),
        ...await published(project, "teams", providerCycle("teams")),
      ];
    };
    const signalOf = (name: string) => name.slice(name.indexOf(":") + 1);
    const isGroup = (name: string) => signalOf(name).startsWith("group-");
    const byEntity = (names: string[]) => {
      const entities = new Map<string, string[]>();
      for (const name of names) entities.set(name.split(":")[0]!, [...(entities.get(name.split(":")[0]!) ?? []), signalOf(name)]);
      return entities;
    };

    it("qualifies journey, step, call-phase and Service Health/activity signals alike when the document has several tenants", async () => {
      const names = await everything(projectFor("fabrikam"));
      for (const expected of [
        "exchange-global:tenant-fabrikam--synthetic-success-percentage",
        "exchange-global-send:tenant-fabrikam--synthetic-mean-duration",
        "teams-call:tenant-fabrikam--synthetic-success-percentage",
        "teams-call-place-call:tenant-fabrikam--synthetic-mean-duration",
        ...teamsCallSignals.map(signal => `teams-call:tenant-fabrikam--${signal}`),
        "teams-service-health:tenant-fabrikam--microsoft-reported-service-status",
        "teams-service-health:tenant-fabrikam--microsoft-reported-issue-count",
        "teams-service-health:tenant-fabrikam--microsoft-activity-getUsageMetricsForTeamsByMeetingsJoined",
        "exchange-service-health:tenant-fabrikam--microsoft-activity-getConnectivityMetricsForExchange",
      ]) expect(names).toContain(expected);
      for (const plain of [
        "exchange-global:synthetic-success-percentage", "teams-call:teams-call-connection-success-percentage",
        "teams-service-health:microsoft-reported-service-status",
      ]) expect(names).not.toContain(plain);
      expect(names.filter(name => !isGroup(name)).every(name => signalOf(name).startsWith("tenant-fabrikam--"))).toBe(true);
      expect(names.every(name => /^[a-zA-Z0-9][a-zA-Z0-9-]{1,258}[a-zA-Z0-9]$/.test(signalOf(name)))).toBe(true);
    });

    it.each([
      ["contoso", [["exchange-global", "priority"], ["exchange-global", "field"], ["teams-global", "priority"]]],
      ["fabrikam", [["exchange-global", "priority"], ["teams-call", "priority"], ["teams-global", "bridge"]]],
    ] as const)("leaves %s's group signals exactly as group-<id>--tenant-<alias>--<signal>", async (alias, groups) => {
      const grouped = (await everything(projectFor(alias))).filter(isGroup);
      const expected = groups.flatMap(([entity, group]) => ["synthetic-success-percentage", "synthetic-mean-duration",
        ...(entity === "teams-call" ? teamsCallSignals : [])].map(signal => `${entity}:${groupSignalName(group, alias, signal)}`));
      expect(grouped.sort()).toEqual(expected.sort());
    });

    it.each(["contoso", "fabrikam"])("keeps the single-tenant names and only prefixes them with the tenant for %s", async alias => {
      const alone = await everything(projectFor(alias, true));
      expect(alone.some(isGroup)).toBe(false);
      expect(alone.every(name => !signalOf(name).startsWith("tenant-"))).toBe(true);
      expect(alone).toContain("exchange-global:synthetic-success-percentage");
      expect(alone).toContain("teams-call:teams-call-connection-success-percentage");
      expect(alone).toContain("exchange-service-health:microsoft-reported-service-status");
      const shared = (await everything(projectFor(alias))).filter(name => !isGroup(name));
      expect(shared.sort()).toEqual(alone.map(name => name.replace(":", `:${tenantSignalName(alias, "")}`)).sort());
    });

    it("never lets two tenants publish the same signal name on the same entity", async () => {
      const contoso = byEntity(await everything(projectFor("contoso")));
      const fabrikam = byEntity(await everything(projectFor("fabrikam")));
      expect([...contoso.keys()].sort()).toEqual([...fabrikam.keys()].sort());
      for (const [entity, signals] of contoso) {
        expect(signals.length, entity).toBeGreaterThan(0);
        expect(signals.filter(signal => fabrikam.get(entity)!.includes(signal)), entity).toEqual([]);
      }
      const plainContoso = byEntity(await everything(projectFor("contoso", true)));
      const plainFabrikam = byEntity(await everything(projectFor("fabrikam", true)));
      expect([...plainContoso].every(([entity, signals]) => signals.every(signal => plainFabrikam.get(entity)!.includes(signal)))).toBe(true);
    });
  });
});
