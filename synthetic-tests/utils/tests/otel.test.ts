import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  AzureMonitorLogExporter, AzureMonitorMetricExporter, type AzureMonitorExporterOptions,
} from "@azure/monitor-opentelemetry-exporter";
import { InMemoryLogRecordExporter, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, InMemoryMetricExporter, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { createProbeTelemetry, validateConnectionString, type AzureExporterFactory } from "../src/azure-monitor.js";
import { resultContext } from "../src/groups.js";
import { createResultTelemetry, TelemetryExportError, type ResultContext } from "../src/otel.js";
import { baseResult, simulate } from "../src/probes.js";
import { isReportedStep, probeServices, testTypes, type SyntheticResult, type TestType } from "../src/contracts.js";
import { checkedInDocument, documentFixture, liveTenantEnv, projectFixture } from "./fixtures.js";
import { selectTenant, serviceExecution, type ProjectConfig } from "../src/project-config.js";
import { parseServiceConfig } from "../src/service-config.js";
import { runServiceWorker } from "../src/worker.js";

const stamp = "2026-10-22T12:00:00.000Z";
const project = projectFixture();
vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: vi.fn(function () {
    return { getToken: vi.fn(async () => ({ token: "mock-arm-token", expiresOnTimestamp: Date.now() + 60000 })) };
  }),
  ClientCertificateCredential: vi.fn(),
}));
const output = () => ({ emit: vi.fn() });
function exporters() {
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  return { logs, metrics };
}
function metricNames(batches: ResourceMetrics[]) {
  return batches.flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics.map(metric => metric.descriptor.name)));
}
function sample(): SyntheticResult {
  return {
    ...baseResult({ id: "opaque-id", type: "exchange-mail-flow", cohort: "exchange-global" }, Date.parse(stamp)),
    success: false, durationMs: 2000, diagnosticCategory: "send-failure",
    steps: [
      { name: "authenticate", status: "succeeded", observedAt: stamp, durationMs: 10 },
      { name: "create-draft", status: "succeeded", observedAt: stamp, durationMs: 500 },
      { name: "send", status: "failed", observedAt: stamp, durationMs: 100, diagnosticCategory: "send-failure" },
      { name: "confirm-delivery", status: "skipped", observedAt: stamp, reason: "prerequisite-failed" },
      { name: "cleanup", status: "succeeded", observedAt: stamp, durationMs: 10 },
    ],
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("optional OTEL observation contract", () => {
  it("exports call-phase samples without target dimensions or synthetic double-counting", async () => {
    const sinks = exporters();
    const telemetry = createResultTelemetry(sinks, output());
    try {
      const result = await simulate({ id: "bot-target", type: "teams-call", cohort: "teams-global" }, {
        config: { SYNTHETIC_SCENARIO: "healthy", PROBE_TIMEOUT_MS: 45000, POLL_INTERVAL_MS: 100 },
        signal: new AbortController().signal, telemetry: output(), now: () => Date.parse(stamp),
      });
      telemetry.record(result, "live");
      await telemetry.forceFlush();
      const metrics = sinks.metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics));
      expect(metrics.find(metric => metric.descriptor.name === "teams.call.connection.success")?.dataPoints[0]?.value).toMatchObject({ count: 1, sum: 1 });
      expect(metrics.find(metric => metric.descriptor.name === "synthetic.probe.success")?.dataPoints[0]?.value).toMatchObject({ count: 1, sum: 1 });
      expect(JSON.stringify(metrics)).not.toMatch(/bot-target|probe\.id|callChainId/);
    } finally { await telemetry.shutdown(); }
  });
  it.each(testTypes)("exports %s with explicit mode and journey attribution", async type => {
    const sinks = exporters();
    const telemetry = createResultTelemetry(sinks, output());
    try {
      const result = await simulate({ id: "probe", type, cohort: "approved-cohort" }, {
        config: { SYNTHETIC_SCENARIO: "healthy", PROBE_TIMEOUT_MS: 45000, POLL_INTERVAL_MS: 100 },
        signal: new AbortController().signal, telemetry: output(), now: () => Date.parse(stamp),
      });
      telemetry.record(result, "simulation");
      await telemetry.forceFlush();
      const log = sinks.logs.getFinishedLogRecords().find(record => record.body === "synthetic-result");
      expect(log?.attributes).toMatchObject({ "probe.mode": "simulation", "probe.success": true, "probe.schema_version": "2.0" });
      expect(log?.attributes["probe.journey"]).toBeDefined();
      expect(metricNames(sinks.metrics.getMetrics())).toContain("synthetic.probe.success");
    } finally { await telemetry.shutdown(); }
  });
  it("records binary successes, separate durations and skipped logs without failed/skipped action samples", async () => {
    const sinks = exporters();
    const telemetry = createResultTelemetry(sinks, output());
    try {
      telemetry.record(sample(), "live");
      await telemetry.forceFlush();
      const logs = sinks.logs.getFinishedLogRecords();
      expect(logs.filter(record => record.body === "synthetic-step")).toHaveLength(3);
      expect(JSON.stringify(logs.map(record => record.attributes))).not.toMatch(/authenticate|cleanup|mailbox/);
      const skipped = logs.find(record => record.attributes["probe.step_status"] === "skipped");
      expect(skipped?.attributes).not.toHaveProperty("probe.duration_ms");
      const metrics = sinks.metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics));
      const success = metrics.find(metric => metric.descriptor.name === "synthetic.probe.success");
      expect(success?.dataPoints[0]?.value).toMatchObject({ count: 1, sum: 0 });
      const duration = metrics.find(metric => metric.descriptor.name === "synthetic.probe.duration");
      expect(duration?.dataPoints[0]?.value).toMatchObject({ count: 1, sum: 2 });
      const steps = metrics.find(metric => metric.descriptor.name === "synthetic.step.success");
      expect(steps?.dataPoints).toHaveLength(2);
      expect(steps?.dataPoints.every(point => point.attributes["probe.step"] !== "confirm-delivery")).toBe(true);
      expect(JSON.stringify(metrics)).not.toMatch(/probe\.id|probe\.correlation_id/);
      const count = metrics.length;
      await telemetry.forceFlush();
      expect(sinks.metrics.getMetrics().slice(1).flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics))).toHaveLength(0);
      expect(count).toBeGreaterThan(0);
    } finally { await telemetry.shutdown(); }
  });
  it("exports providers only as logs, never as synthetic or business-step metrics", async () => {
    const sinks = exporters();
    const telemetry = createResultTelemetry(sinks, output());
    try {
      telemetry.recordDiagnostic({
        kind: "overview", service: "exchange", collectedAt: stamp,
        serviceId: "Exchange", serviceName: "Exchange Online", status: "serviceOperational",
      });
      await telemetry.forceFlush();
      expect(sinks.logs.getFinishedLogRecords()[0]?.body).toBe("m365-service-health-overview");
      expect(metricNames(sinks.metrics.getMetrics())).toEqual([]);
      expect(() => telemetry.record({ ...sample(), durationMs: -1 }, "live")).toThrow();
    } finally { await telemetry.shutdown(); }
  });
  it.each(["logs", "metrics"] as const)("surfaces %s failures before HTTP submission and bounds missing callbacks", async signal => {
    for (const failure of ["callback", "throw", "rejection", "timeout"] as const) {
      const sinks = exporters();
      const events = output();
      const exporter = vi.spyOn(sinks[signal], "export").mockImplementation((_data: unknown, callback: (result: ExportResult) => void) => {
        const error = new Error("private response");
        if (failure === "throw") throw error;
        if (failure === "rejection") return Promise.reject(error);
        if (failure === "callback") callback({ code: ExportResultCode.FAILED, error });
      });
      const telemetry = createResultTelemetry(sinks, events, 10);
      telemetry.record(sample(), "live");
      await expect(telemetry.forceFlush()).rejects.toBeInstanceOf(TelemetryExportError);
      expect(events.emit).toHaveBeenCalledWith("telemetry-export-failed", { signal, category: "collector-failure" });
      expect(JSON.stringify(events.emit.mock.calls)).not.toContain("private response");
      exporter.mockRestore();
      await telemetry.shutdown();
      expect(() => telemetry.record(sample(), "live")).toThrow(TelemetryExportError);
    }
  });
  it.each(["forceFlush", "shutdown"] as const)("bounds rejected or stalled exporter %s operations", async method => {
    vi.useFakeTimers();
    for (const hanging of [false, true]) {
      const sinks = exporters();
      const events = output();
      const exporter = vi.spyOn(sinks.metrics, method).mockImplementation(() =>
        hanging ? new Promise<void>(() => {}) : Promise.reject(new Error("private lifecycle failure")));
      const telemetry = createResultTelemetry(sinks, events, 10);
      const failure = expect(telemetry[method]()).rejects.toBeInstanceOf(TelemetryExportError);
      await vi.advanceTimersByTimeAsync(511);
      await failure;
      expect(events.emit).toHaveBeenCalledWith("telemetry-export-failed", { signal: "lifecycle", category: "collector-failure" });
      expect(JSON.stringify(events.emit.mock.calls)).not.toContain("private lifecycle failure");
      exporter.mockRestore();
      await telemetry.shutdown();
    }
  });
  it("keeps repeated and overlapping telemetry lifetimes isolated", async () => {
    const first = exporters();
    const second = exporters();
    const telemetry = createResultTelemetry(first, output());
    const other = createResultTelemetry(second, output());
    try {
      telemetry.record(sample(), "live");
      await Promise.all([telemetry.forceFlush(), other.forceFlush()]);
      expect(first.logs.getFinishedLogRecords()).toHaveLength(4);
      expect(second.logs.getFinishedLogRecords()).toHaveLength(0);
      await telemetry.shutdown();
      await telemetry.shutdown();
      other.record(sample(), "simulation");
      await other.forceFlush();
      expect(second.logs.getFinishedLogRecords()).toHaveLength(4);
    } finally { await Promise.all([telemetry.shutdown(), other.shutdown()]); }
  });
});

describe("Azure destination configuration", () => {
  const connectionString = "InstrumentationKey=11111111-1111-4111-8111-111111111111;IngestionEndpoint=https://telemetry.example.invalid";
  it.each([
    undefined, "", "private-value", `${connectionString};Authorization=secret`,
    `${connectionString};IngestionEndpoint=https://duplicate.invalid`,
    connectionString.replace("https:", "http:"), `${connectionString}?secret`,
  ])("rejects invalid Azure settings without echoing them", value => {
    expect(() => validateConnectionString({ APPLICATIONINSIGHTS_CONNECTION_STRING: value }))
      .toThrow("azure-monitor telemetry requires a valid APPLICATIONINSIGHTS_CONNECTION_STRING");
  });
  it("does not construct Azure exporters for the local console destination", async () => {
    const factory = { logs: vi.fn(), metrics: vi.fn() };
    const telemetry = await createProbeTelemetry("console", output(), {}, factory);
    await telemetry.shutdown();
    expect(factory.logs).not.toHaveBeenCalled();
    expect(factory.metrics).not.toHaveBeenCalled();
  });
  it("wires explicit Azure exporters with no disk storage, retries or unbounded HTTP calls", async () => {
    const sinks = exporters();
    const factory = {
      logs: vi.fn<AzureExporterFactory["logs"]>(() => sinks.logs),
      metrics: vi.fn<AzureExporterFactory["metrics"]>(() => sinks.metrics),
    };
    const telemetry = await createProbeTelemetry("azure-monitor", output(), {
      APPLICATIONINSIGHTS_CONNECTION_STRING: connectionString,
    }, factory);
    expect(factory.logs.mock.calls[0]?.[0]).toMatchObject({
      connectionString, disableOfflineStorage: true, retryOptions: { maxRetries: 0 },
    });
    expect(factory.metrics).toHaveBeenCalledOnce();
    telemetry.record(sample(), "live");
    await telemetry.forceFlush();
    expect(sinks.logs.getFinishedLogRecords()).toHaveLength(4);
    await telemetry.shutdown();
  });
  it.each([200, 206, 307, 400, 429, 500])("validates real Azure exporter compatibility and ingestion status %s without network calls", async status => {
    const requests: { url: string; timeout: number }[] = [];
    const httpClient: NonNullable<AzureMonitorExporterOptions["httpClient"]> = {
      async sendRequest(request) {
        requests.push({ url: request.url, timeout: request.timeout });
        return {
          request, status, headers: request.headers,
          bodyAsText: JSON.stringify({ itemsReceived: 1, itemsAccepted: status === 200 ? 1 : 0, errors: [] }),
        };
      },
    };
    const factory: AzureExporterFactory = {
      logs: options => new AzureMonitorLogExporter({ ...options, httpClient }),
      metrics: options => new AzureMonitorMetricExporter({ ...options, httpClient }),
    };
    const telemetry = await createProbeTelemetry("azure-monitor", output(), {
      APPLICATIONINSIGHTS_CONNECTION_STRING: connectionString,
    }, factory);
    try {
      telemetry.record(sample(), "live");
      if (status === 200) await telemetry.forceFlush();
      else await expect(telemetry.forceFlush()).rejects.toThrow(TelemetryExportError);
      expect(requests).toHaveLength(2);
      expect(requests.every(request => request.url.startsWith("https://telemetry.example.invalid/"))).toBe(true);
      expect(requests.every(request => request.timeout === 5000)).toBe(true);
    } finally { await telemetry.shutdown(); }
  });
  it("rejects real Azure transport failures without retries, offline success or private diagnostics", async () => {
    const sendRequest = vi.fn<NonNullable<AzureMonitorExporterOptions["httpClient"]>["sendRequest"]>(async () => {
      throw new Error("private transport response");
    });
    const factory: AzureExporterFactory = {
      logs: options => new AzureMonitorLogExporter({ ...options, httpClient: { sendRequest } }),
      metrics: options => new AzureMonitorMetricExporter({ ...options, httpClient: { sendRequest } }),
    };
    const events = output();
    const telemetry = await createProbeTelemetry("azure-monitor", events, {
      APPLICATIONINSIGHTS_CONNECTION_STRING: connectionString,
    }, factory);
    try {
      telemetry.record(sample(), "live");
      await expect(telemetry.forceFlush()).rejects.toBeInstanceOf(TelemetryExportError);
      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(events.emit.mock.calls)).not.toContain("private transport response");
    } finally { await telemetry.shutdown(); }
  });
  it("cleans up partially initialized exporters and restores the statsbeat opt-out", async () => {
    vi.stubEnv("APPLICATION_INSIGHTS_NO_STATSBEAT", "previous");
    const sinks = exporters();
    const shutdown = vi.spyOn(sinks.logs, "shutdown");
    const factory: AzureExporterFactory = {
      logs() {
        expect(process.env.APPLICATION_INSIGHTS_NO_STATSBEAT).toBe("true");
        return sinks.logs;
      },
      metrics() { throw new Error("private initialization response"); },
    };
    await expect(createProbeTelemetry("azure-monitor", output(), {
      APPLICATIONINSIGHTS_CONNECTION_STRING: connectionString,
    }, factory)).rejects.toThrow("Cannot initialize azure-monitor telemetry exporters");
    expect(shutdown).toHaveBeenCalledOnce();
    expect(process.env.APPLICATION_INSIGHTS_NO_STATSBEAT).toBe("previous");
  });
});

describe("worker health-report independence", () => {
  const service = parseServiceConfig({
    type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45,
    mode: "simulation", cohort: "exchange-global", targets: [{ id: "probe" }],
  });
  const journeys = testTypes.filter(type => probeServices[type].service === "exchange" &&
    project.services.exchange.scenarios[probeServices[type].journey]);
  const reportCount = 2 * journeys.reduce((count, type) =>
    count + 1 + probeServices[type].steps.filter(isReportedStep).length, 0);
  it("never creates an exporter when OTEL is disabled", async () => {
    const createOtel = vi.fn();
    const events = output();
    await runServiceWorker(service, { project, once: true, env: {}, telemetry: events, createOtel });
    expect(createOtel).not.toHaveBeenCalled();
    expect(events.emit.mock.calls.filter(([event]) => event === "health-report-preview")).toHaveLength(reportCount);
  });
  it("keeps existing console results and direct-report previews when console OTEL is enabled", async () => {
    const events = output();
    await runServiceWorker(service, {
      project: { ...project, otel: { enabled: true, destination: "console" } },
      once: true, env: {}, telemetry: events,
    });
    const names = events.emit.mock.calls.map(([event]) => event);
    expect(names.filter(name => name === "synthetic-result")).toHaveLength(journeys.length);
    expect(names.filter(name => name === "health-report-preview")).toHaveLength(reportCount);
    expect(names).toContain("otel-log");
    expect(names).toContain("probe-metrics");
  });
  it.each(["initialization", "record", "flush", "shutdown"] as const)(
    "does not block report publication on an OTEL %s failure", async failure => {
      const events = output();
      const telemetry = {
        record: vi.fn(), recordDiagnostic: vi.fn(), forceFlush: vi.fn(async () => {}),
        shutdown: vi.fn(async () => {}),
      };
      if (failure === "record") telemetry.record.mockImplementation(() => { throw new TelemetryExportError(); });
      if (failure === "flush") telemetry.forceFlush.mockRejectedValue(new TelemetryExportError());
      if (failure === "shutdown") telemetry.shutdown.mockRejectedValue(new TelemetryExportError());
      const createOtel = vi.fn(async () => {
        if (failure === "initialization") throw new TelemetryExportError();
        return telemetry;
      });
      const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetcher);
      await expect(runServiceWorker({ ...service, mode: "live" }, {
        project: {
          ...project, otel: { enabled: true, destination: "console" },
          healthModel: { ...project.healthModel, subscriptionId: "11111111-1111-4111-8111-111111111111" },
        },
        once: true, env: { ENABLE_LIVE_M365: "true", AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222", ...liveTenantEnv },
        telemetry: events, createOtel,
        handler: async probe => ({ ...baseResult(probe, Date.now()), success: true, durationMs: 1 }),
      })).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(reportCount);
      expect(events.emit.mock.calls.filter(([event]) => event === "health-report-published")).toHaveLength(reportCount);
      if (failure !== "initialization") expect(telemetry.shutdown).toHaveBeenCalledOnce();
    },
  );
  it("preserves a healthy provider report when OTEL diagnostic recording fails", async () => {
    const events = output();
    const recordDiagnostic = vi.fn(() => {}).mockImplementationOnce(() => { throw new TelemetryExportError(); });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(runServiceWorker({ ...service, mode: "live", serviceHealth: true }, {
      project: {
        ...project, otel: { enabled: true, destination: "console" },
        serviceHealth: { ...project.serviceHealth, enabled: true },
        healthModel: { ...project.healthModel, subscriptionId: "11111111-1111-4111-8111-111111111111" },
      },
      once: true, telemetry: events,
      env: { ENABLE_LIVE_M365: "true", AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222", ...liveTenantEnv },
      handler: async probe => ({ ...baseResult(probe, Date.now()), success: true, durationMs: 1 }),
      providers: async context => {
        context.results.recordDiagnostic({
          kind: "overview", service: "exchange", collectedAt: new Date().toISOString(),
          serviceId: "Exchange", serviceName: "Exchange Online", status: "serviceOperational",
        });
        context.results.recordDiagnostic({
          kind: "issue-summary", service: "exchange", collectedAt: new Date().toISOString(), count: 0,
        });
        return { configured: 2, succeeded: 2, failed: 0, skipped: 0, records: 2 };
      },
      createOtel: async () => ({
        record() {},
        recordDiagnostic,
        forceFlush: async () => {},
        shutdown: async () => {},
      }),
    })).rejects.toThrow(TelemetryExportError);
    expect(fetcher).toHaveBeenCalledTimes(reportCount + 2);
    const providerReport = fetcher.mock.calls.find(([url, request]) =>
      String(url).includes("/entities/exchange-service-health/") &&
      JSON.parse(String(request?.body)).signalName === "microsoft-reported-service-status");
    expect(JSON.parse(String(providerReport?.[1]?.body))).toMatchObject({
      signalName: "microsoft-reported-service-status", healthState: "Healthy", value: 100,
    });
    expect(events.emit).toHaveBeenCalledWith("telemetry-output-failed", expect.any(Object));
  });
});

type LogRow = { body: unknown; attributes: Record<string, unknown> };
const stepRows = (rows: LogRow[], step: string) =>
  rows.filter(row => row.body === "synthetic-step" && row.attributes["probe.step"] === step);
const resultRows = (rows: LogRow[]) => rows.filter(row => row.body === "synthetic-result");
const groupIdentities = (rows: LogRow[]) =>
  rows.map(row => [row.attributes["monitoring.group"], row.attributes["monitoring.group_name"]]);
const reportedSteps = ["create-draft", "send", "confirm-delivery"] as const;

async function recordLogs(result: SyntheticResult, context?: ResultContext) {
  const sinks = exporters();
  const telemetry = createResultTelemetry(sinks, output());
  try {
    telemetry.record(result, "live", context);
    await telemetry.forceFlush();
    return {
      rows: [...sinks.logs.getFinishedLogRecords()] as LogRow[],
      metrics: sinks.metrics.getMetrics().flatMap(batch => batch.scopeMetrics.flatMap(scope => scope.metrics)),
    };
  } finally { await telemetry.shutdown(); }
}

function failedWithDetail(): SyntheticResult {
  const result = sample();
  result.steps = result.steps.map(step =>
    step.name === "send" && step.status === "failed" ? { ...step, detail: "schema:value.0.id(invalid_type)" } : step);
  result.diagnosticContext = { httpStatus: 403 };
  return result;
}

describe("log attributes for group, impacted user and error detail", () => {
  const groups = [
    { id: "united-kingdom-users", displayName: "United Kingdom Users" },
    { id: "united-states-users", displayName: "United States Users" },
    { id: "everyone", displayName: "Everyone" },
  ];
  const context: ResultContext = {
    tenant: "consto", user: "test-user-4@example.invalid", peer: "test-user-5@example.invalid", groups: groups.slice(0, 2),
  };

  it("emits one step record and one result record per group the target belongs to, in configured order", async () => {
    const { rows } = await recordLogs(sample(), context);
    expect(rows.filter(row => row.body === "synthetic-step")).toHaveLength(reportedSteps.length * 2);
    expect(resultRows(rows)).toHaveLength(2);
    const expected = [
      ["united-kingdom-users", "United Kingdom Users"], ["united-states-users", "United States Users"],
    ];
    for (const step of reportedSteps) expect(groupIdentities(stepRows(rows, step))).toEqual(expected);
    expect(groupIdentities(resultRows(rows))).toEqual(expected);
  });

  it.each([2, 3])("with %i groups exactly one record per step and result lacks the duplicate marker", async count => {
    const { rows } = await recordLogs(sample(), { ...context, groups: groups.slice(0, count) });
    for (const records of [...reportedSteps.map(step => stepRows(rows, step)), resultRows(rows)]) {
      expect(records).toHaveLength(count);
      const unmarked = records.filter(row => !("monitoring.group_duplicate" in row.attributes));
      const marked = records.filter(row => "monitoring.group_duplicate" in row.attributes);
      expect(unmarked).toHaveLength(1);
      expect(unmarked[0]?.attributes["monitoring.group"]).toBe("united-kingdom-users");
      expect(marked).toHaveLength(count - 1);
      expect(marked.every(row => row.attributes["monitoring.group_duplicate"] === "true")).toBe(true);
    }
  });

  it.each([
    ["a single group", { ...context, groups: groups.slice(0, 1) }, 1],
    ["no group", { ...context, groups: [] }, 0],
  ])("emits a single record per step and result for %s and never marks it as a duplicate", async (_label, input, grouped) => {
    const { rows } = await recordLogs(sample(), input);
    expect(rows).toHaveLength(reportedSteps.length + 1);
    for (const row of rows) {
      expect(row.attributes).not.toHaveProperty("monitoring.group_duplicate");
      expect(row.attributes["monitoring.tenant"]).toBe("consto");
      expect("monitoring.group" in row.attributes).toBe(grouped === 1);
      expect("monitoring.group_name" in row.attributes).toBe(grouped === 1);
    }
  });

  it("emits no monitoring attributes when the caller supplies no context", async () => {
    const { rows } = await recordLogs(sample());
    expect(rows).toHaveLength(reportedSteps.length + 1);
    expect(rows.every(row => Object.keys(row.attributes).every(name => !name.startsWith("monitoring.")))).toBe(true);
  });

  it("attributes the impacted user and peer to every step and result record, omitting what is not set", async () => {
    const both = await recordLogs(sample(), context);
    for (const row of both.rows) {
      expect(row.attributes).toMatchObject({
        "monitoring.tenant": "consto", "monitoring.user": "test-user-4@example.invalid", "monitoring.peer": "test-user-5@example.invalid",
      });
    }
    const { peer: _peer, ...withoutPeer } = context;
    for (const row of (await recordLogs(sample(), withoutPeer)).rows) {
      expect(row.attributes["monitoring.user"]).toBe("test-user-4@example.invalid");
      expect(row.attributes).not.toHaveProperty("monitoring.peer");
    }
    const { user: _user, ...bots } = withoutPeer;
    for (const row of (await recordLogs(sample(), bots)).rows) {
      expect(row.attributes).not.toHaveProperty("monitoring.user");
      expect(row.attributes).not.toHaveProperty("monitoring.peer");
    }
  });

  it("puts the value-free detail on failed step records only and the HTTP status and failed step on the result record", async () => {
    const { rows } = await recordLogs(failedWithDetail(), context);
    for (const row of stepRows(rows, "send")) {
      expect(row.attributes).toMatchObject({
        "probe.step_status": "failed", "probe.diagnostic_category": "send-failure", "probe.detail": "schema:value.0.id(invalid_type)",
      });
    }
    for (const step of ["create-draft", "confirm-delivery"]) {
      for (const row of stepRows(rows, step)) expect(row.attributes).not.toHaveProperty("probe.detail");
    }
    for (const row of resultRows(rows)) {
      expect(row.attributes).toMatchObject({
        "probe.success": false, "probe.diagnostic_category": "send-failure", "probe.http_status": 403, "probe.failed_step": "send",
      });
      expect(row.attributes).not.toHaveProperty("probe.detail");
    }
  });

  it("omits the detail, HTTP status and failed step from records of a healthy result", async () => {
    const healthy = await simulate({ id: "probe", type: "exchange-mail-flow", cohort: "approved-cohort" }, {
      config: { SYNTHETIC_SCENARIO: "healthy", PROBE_TIMEOUT_MS: 45000, POLL_INTERVAL_MS: 100 },
      signal: new AbortController().signal, telemetry: output(), now: () => Date.parse(stamp),
    });
    const { rows } = await recordLogs(healthy, context);
    for (const row of rows) {
      for (const name of ["probe.detail", "probe.http_status", "probe.failed_step"]) expect(row.attributes).not.toHaveProperty(name);
    }
  });

  it("keeps internal authentication and cleanup steps out of the failed step while still reporting the HTTP status", async () => {
    const result = baseResult({ id: "opaque-id", type: "exchange-mail-flow", cohort: "exchange-global" }, Date.parse(stamp));
    result.diagnosticCategory = "authentication-failure";
    result.diagnosticContext = { httpStatus: 401 };
    result.steps = [
      { name: "authenticate", status: "failed", observedAt: stamp, durationMs: 10, diagnosticCategory: "authentication-failure", detail: "private" },
      ...reportedSteps.map(name => ({ name, status: "skipped", observedAt: stamp, reason: "prerequisite-failed" }) as const),
      { name: "cleanup", status: "skipped", observedAt: stamp, reason: "no-mutation" },
    ];
    const { rows } = await recordLogs(result, context);
    for (const row of resultRows(rows)) {
      expect(row.attributes).toMatchObject({ "probe.diagnostic_category": "authentication-failure", "probe.http_status": 401 });
      expect(row.attributes).not.toHaveProperty("probe.failed_step");
    }
    expect(JSON.stringify(rows.map(row => row.attributes))).not.toMatch(/authenticate|cleanup-|private/);
  });

  it("keeps metric dimensions unchanged, free of monitoring attributes and counts each attempt once however many groups", async () => {
    const { metrics } = await recordLogs(failedWithDetail(), { ...context, groups });
    const dimensionNames = (name: string) => [...new Set(metrics.find(metric => metric.descriptor.name === name)?.dataPoints
      .flatMap(point => Object.keys(point.attributes)))].sort();
    expect(dimensionNames("synthetic.probe.success")).toEqual(["probe.journey", "probe.mode", "probe.outcome", "probe.service"]);
    expect(dimensionNames("synthetic.probe.duration")).toEqual(["probe.journey", "probe.mode", "probe.outcome", "probe.service"]);
    expect(dimensionNames("synthetic.step.success")).toEqual(["probe.journey", "probe.mode", "probe.outcome", "probe.service", "probe.step"]);
    expect(metrics.find(metric => metric.descriptor.name === "synthetic.probe.success")?.dataPoints[0]?.value)
      .toMatchObject({ count: 1, sum: 0 });
    expect(metrics.find(metric => metric.descriptor.name === "synthetic.step.success")?.dataPoints).toHaveLength(2);
    expect(JSON.stringify(metrics)).not.toMatch(/monitoring|test-user|probe\.detail|http_status|failed_step/);
  });
});

describe("worker result context", () => {
  function captureLogs() {
    const rows: LogRow[] = [];
    const logs: LogRecordExporter = {
      export(records, callback) {
        rows.push(...records.map(record => ({ body: record.body, attributes: { ...record.attributes } })));
        callback({ code: ExportResultCode.SUCCESS });
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    };
    const metrics = new InMemoryMetricExporter(AggregationTemporality.DELTA);
    return { rows, createOtel: async () => createResultTelemetry({ logs, metrics }, output()) };
  }
  async function runWorker(project: ProjectConfig, type: "exchange" | "teams" | "onedrive") {
    const capture = captureLogs();
    const events = output();
    await runServiceWorker(serviceExecution(project, type), {
      project: { ...project, otel: { enabled: true, destination: "console" } },
      once: true, env: {}, telemetry: events, createOtel: capture.createOtel,
    });
    return { rows: capture.rows, events };
  }
  const centralus = { id: "centralus", displayName: "Central US" };
  const uksouth = { id: "uksouth", displayName: "UK South" };

  it.each([
    ["exchange", "exchange-probe-001", { user: "test-user-1@example.invalid", peer: "test-user-2@example.invalid" }, [centralus]],
    ["exchange", "exchange-probe-002", { user: "test-user-2@example.invalid", peer: "test-user-1@example.invalid" }, [uksouth]],
    ["onedrive", "onedrive-probe-001", { user: "test-user-1@example.invalid" }, [centralus]],
    ["onedrive", "onedrive-probe-002", { user: "test-user-2@example.invalid" }, [uksouth]],
    ["teams", "teams-probe-001", {}, [centralus]],
    ["teams", "teams-meeting-001", {}, [centralus]],
  ] as const)("passes the %s target %s's tenant, users and groups to every OTEL log record", async (service, id, accounts, groups) => {
    const { rows } = await runWorker(selectTenant(documentFixture()), service);
    const records = rows.filter(row => row.attributes["probe.id"] === id);
    const journeys = resultRows(records).map(row => row.attributes["probe.journey"]);
    expect(journeys.length).toBeGreaterThan(0);
    expect(new Set(journeys).size).toBe(journeys.length);
    expect(records.length).toBeGreaterThan(journeys.length);
    for (const row of records) {
      expect(row.attributes["monitoring.tenant"]).toBe("contoso");
      expect(row.attributes["monitoring.user"]).toBe("user" in accounts ? accounts.user : undefined);
      expect(row.attributes["monitoring.peer"]).toBe("peer" in accounts ? accounts.peer : undefined);
      expect(groupIdentities([row])).toEqual([[groups[0].id, groups[0].displayName]]);
    }
  });

  it("writes two records, the second marked as a duplicate, for a user who belongs to two groups", async () => {
    const document = documentFixture();
    document.groups.push({ id: "everyone", displayName: "Everyone", accounts: ["test-user-1@example.invalid"], teams: [] });
    const { rows } = await runWorker(selectTenant(document), "exchange");
    const mine = resultRows(rows).filter(row => row.attributes["probe.id"] === "exchange-probe-001");
    const journeys = new Set(mine.map(row => row.attributes["probe.journey"]));
    expect(mine).toHaveLength(journeys.size * 2);
    for (const journey of journeys) {
      const pair = mine.filter(row => row.attributes["probe.journey"] === journey);
      expect(groupIdentities(pair)).toEqual([["centralus", "Central US"], ["everyone", "Everyone"]]);
      expect(pair.map(row => row.attributes["monitoring.group_duplicate"])).toEqual([undefined, "true"]);
      expect(new Set(pair.map(row => row.attributes["monitoring.user"]))).toEqual(new Set(["test-user-1@example.invalid"]));
    }
    expect(resultRows(rows).filter(row => row.attributes["probe.id"] === "exchange-probe-002")
      .every(row => !("monitoring.group_duplicate" in row.attributes))).toBe(true);
  });

  it("emits a single record without group attributes for a target outside every group", async () => {
    const document = documentFixture();
    document.groups = [];
    const { rows } = await runWorker(selectTenant(document), "exchange");
    const mine = resultRows(rows).filter(row => row.attributes["probe.id"] === "exchange-probe-001");
    expect(mine).toHaveLength(new Set(mine.map(row => row.attributes["probe.journey"])).size);
    for (const row of mine) {
      expect(row.attributes["monitoring.user"]).toBe("test-user-1@example.invalid");
      expect(Object.keys(row.attributes).filter(name => name.startsWith("monitoring.group"))).toEqual([]);
    }
  });

  it("passes the context to OTEL result recording only and keeps it out of the console results", async () => {
    const project = { ...selectTenant(documentFixture()), otel: { enabled: true, destination: "console" as const } };
    const telemetry = { record: vi.fn(), recordDiagnostic: vi.fn(), forceFlush: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) };
    const events = output();
    await runServiceWorker(serviceExecution(project, "exchange"), {
      project, once: true, env: {}, telemetry: events, createOtel: async () => telemetry,
    });
    expect(telemetry.record).toHaveBeenCalledWith(
      expect.objectContaining({ testId: "exchange-probe-001" }), "simulation", {
        tenant: "contoso", user: "test-user-1@example.invalid", peer: "test-user-2@example.invalid", groups: [centralus],
      },
    );
    expect(telemetry.record).toHaveBeenCalledTimes(14);
    const consoleResults = events.emit.mock.calls.filter(([event]) => event === "synthetic-result");
    expect(consoleResults).toHaveLength(14);
    expect(JSON.stringify(consoleResults)).not.toMatch(/monitoring|Central US|centralus/);
  });

  it("carries the checked-in group ids and display names exactly as configured", async () => {
    const project = selectTenant(await checkedInDocument());
    const uk = [["united-kingdom-users", "United Kingdom Users"]];
    const us = [["united-states-users", "United States Users"]];
    const targets: [TestType, string, string[][]][] = [
      ["exchange-mail-flow", "exchange-probe-001", us], ["exchange-meeting", "exchange-probe-002", uk],
      ["exchange-reply", "exchange-probe-003", uk], ["onedrive-roundtrip", "onedrive-probe-002", us],
      ["teams-channel-message", "teams-probe-001", us], ["teams-channel-message", "teams-probe-002", uk],
      ["teams-call", "teams-bot-meeting-001", us],
    ];
    for (const [type, id, expected] of targets) {
      const result = baseResult({ id, type, cohort: "test" }, Date.parse(stamp));
      const { rows } = await recordLogs(result, resultContext(project, result));
      expect(groupIdentities(resultRows(rows))).toEqual(expected);
      expect(resultRows(rows).every(row => row.attributes["monitoring.tenant"] === project.tenant.id)).toBe(true);
    }
  });
});
