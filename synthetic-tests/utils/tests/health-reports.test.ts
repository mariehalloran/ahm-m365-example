import { describe, expect, it, vi } from "vitest";
import { aggregateHealthReports, callQualityReports, createHealthReporter, serviceHealthReport, serviceHealthIssuesReport, type HealthReporter, type CycleResults, type CallQualityCycle } from "../src/health-reports.js";
import { readProjectConfig } from "../src/project-config.js";
import { baseResult } from "../src/probes.js";
import { runCycle } from "../src/runner.js";
import { parseServiceConfig, serviceSettings } from "../src/service-config.js";
import type { SyntheticResult } from "../src/contracts.js";
import type { ProviderDiagnostic } from "../src/provider-diagnostics.js";
import { activityFunctions, isPercentageActivity } from "../src/provider-catalog.js";
import { serviceHealthNames } from "../src/service-health.js";

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
  it("returns aggregated connection, playback and disconnection metrics on the call entity", () => {
    const observedAt = "2026-10-26T16:00:00.000Z";
    const call: SyntheticResult = {
      ...baseResult({ id: "bot-target", type: "teams-call", cohort: "teams-global" }, Date.parse(observedAt)),
      success: true, durationMs: 5000,
      steps: [
        { name: "place-call", status: "succeeded", durationMs: 500, observedAt },
        { name: "wait-for-answer", status: "succeeded", durationMs: 1500, observedAt },
        { name: "play-audio", status: "succeeded", durationMs: 2000, observedAt },
        { name: "end-call", status: "succeeded", durationMs: 1000, observedAt },
      ],
    };
    const failed: SyntheticResult = {
      ...call, success: false, diagnosticCategory: "delivery-timeout",
      steps: [
        { name: "place-call", status: "succeeded", durationMs: 500, observedAt },
        { name: "wait-for-answer", status: "failed", durationMs: 19500, diagnosticCategory: "delivery-timeout", observedAt },
        { name: "play-audio", status: "skipped", reason: "prerequisite-failed", observedAt },
        { name: "end-call", status: "succeeded", durationMs: 500, observedAt },
      ],
    };
    const reports = aggregateHealthReports("teams", cycle([call, failed]), project.healthModel);
    const measurement = (signal: string) => reports.find(report => report.body.signalName === signal)!;
    expect(measurement("teams-call-connection-success-percentage").body).toMatchObject({ value: 50, healthState: "Unhealthy" });
    expect(measurement("teams-call-mean-connection-duration").body.value).toBe(11000);
    expect(measurement("teams-call-playback-success-percentage").body.value).toBe(100);
    expect(measurement("teams-call-mean-playback-duration").body.value).toBe(2000);
    expect(measurement("teams-call-mean-disconnection-duration").body.value).toBe(750);
    expect(JSON.parse(measurement("teams-call-playback-success-percentage").body.additionalContext)).toMatchObject({
      attempted: 1, succeeded: 1, skipped: 1, unit: "Percent", observedAt,
    });
    expect(reports.filter(report => report.body.signalName.startsWith("teams-call-")).every(report => report.entityName === "teams-call")).toBe(true);
    expect(JSON.stringify(reports)).not.toContain("bot-target");
  });
  it("does not invent call measurements when no business action executed", () => {
    const call = baseResult({ id: "bot-target", type: "teams-call", cohort: "teams-global" }, Date.now());
    call.diagnosticCategory = "configuration-failure";
    const reports = aggregateHealthReports("teams", cycle([call]), project.healthModel)
      .filter(report => report.body.signalName.startsWith("teams-call-"));
    expect(reports).toHaveLength(6);
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
  it("returns quality values on the same entity without inventing thresholds or overriding journey signals", () => {
    const quality: CallQualityCycle = {
      cycleId: "quality-cycle", collectedAt: "2026-10-26T16:01:00.000Z",
      callQuality: [{
        status: "available",
        observation: {
          callChainId: "11111111-1111-4111-8111-111111111111", version: 1,
          startDateTime: "2026-10-26T16:00:00.000Z", endDateTime: "2026-10-26T16:00:10.000Z",
          audioStreamCount: 2, codecs: ["opus"], streamDirections: ["callerToCallee"],
          metrics: {
            jitterMs: { value: 15, sampleCount: 2 },
            packetLossPercent: { value: 2, sampleCount: 1 },
          },
        },
      }],
    };
    const reports = callQualityReports(quality, project.healthModel);
    expect(reports).toHaveLength(9);
    expect(reports.every(report => report.entityName === "teams-call" && report.body.healthState === "Unknown")).toBe(true);
    const jitter = reports.find(report => report.body.signalName === "teams-call-quality-jitter")!;
    expect(jitter.body.value).toBe(15);
    expect(jitter.body).not.toHaveProperty("evaluationRules");
    expect(JSON.parse(jitter.body.additionalContext)).toMatchObject({
      sampleCount: 2, complete: true, unit: "Milliseconds", availableCalls: 1,
      observedThrough: "2026-10-26T16:00:10.000Z",
    });
    expect(reports.find(report => report.body.signalName === "teams-call-quality-round-trip-time")?.body).not.toHaveProperty("value");
    const policy = {
      ...project.healthModel,
      callQualityThresholds: {
        jitterMs: { degradedAbove: 10, unhealthyAbove: 20 },
        packetLossPercent: { degradedAbove: 1, unhealthyAbove: 5 },
      },
    };
    const evaluated = callQualityReports(quality, policy);
    expect(evaluated.find(report => report.body.signalName === jitter.body.signalName)?.body.healthState).toBe("Degraded");
    expect(evaluated.find(report => report.body.signalName === "teams-call-quality-packet-loss")?.body.healthState).toBe("Unknown");
    const pending = callQualityReports({
      ...quality, callQuality: [...quality.callQuality, { status: "pending" }],
    }, policy);
    expect(pending.every(report => report.body.healthState === "Unknown")).toBe(true);
    expect(pending.some(report => report.body.signalName === "synthetic-success-percentage")).toBe(false);
  });
  it("publishes quality-only reports to the existing Teams entity through the ARM ingestion API", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const teams = parseServiceConfig({ ...service, type: "teams", cohort: "teams-global", mode: "live" });
    const reporter = createHealthReporter(project, teams, { emit: vi.fn() }, {}, {
      credential: { getToken: async () => ({ token: "mock-token", expiresOnTimestamp: Date.now() + 60000 }) },
      fetch: async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: 204 });
      },
    });
    await reporter({
      cycleId: "quality-cycle", collectedAt: new Date().toISOString(),
      callQuality: [{ status: "pending", callChainId: "11111111-1111-4111-8111-111111111111" }],
    });
    expect(requests).toHaveLength(9);
    expect(new Set(requests.map(request => request.url)).size).toBe(1);
    expect(requests[0]?.url).toContain("/healthmodels/m365-experience-poc-teams/entities/teams-call/ingestHealthReport?");
    expect(requests.every(request => String(request.body.signalName).startsWith("teams-call-quality-"))).toBe(true);
    expect(requests.every(request => request.body.healthState === "Unknown" && !("value" in request.body))).toBe(true);
  });
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
    it.each(["exchange", "teams", "onedrive"] as const)("uses the authenticated bounded publisher and selected %s model", async type => {
      const requests: { url: string; body: unknown }[] = [];
      const credential = { getToken: vi.fn(async () => ({ token: "test-only", expiresOnTimestamp: Date.now() + 60000 })) };
      await createHealthReporter(project, { ...service, type, mode: "live", serviceHealth: true } as typeof service, { emit: vi.fn() }, {}, {
        credential, fetch: async (url, init) => {
          requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return new Response(null, { status: 204 });
        },
      })({ cycleId: "provider-cycle", providerDiagnostics: [{
        ...diagnostic("serviceOperational"), service: type, serviceName: serviceHealthNames[type],
        serviceId: type === "onedrive" ? "OneDriveForBusiness" : "reported-service",
      }] });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.url).toContain(`/healthmodels/${project.healthModel.name}-${type}/entities/${type}-service-health/`);
      expect(requests[0]?.body).toMatchObject({ signalName: "microsoft-reported-service-status", healthState: "Healthy", value: 100 });
      expect(requests[1]?.url).toBe(requests[0]?.url);
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
        await createHealthReporter(project, selected, { emit: vi.fn() }, {}, {
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

    it("retains honest OneDrive Unknown context when stable data is missing or denied", () => {
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
  });
});
