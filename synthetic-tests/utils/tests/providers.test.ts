import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeProviders } from "../../exchange/src/providers.js";
import { teamsProviders } from "../../teams/src/providers.js";
import { sharepointProviders } from "../../sharepoint/src/providers.js";
import { GraphClient } from "../src/graph.js";
import { AuthenticatedHttp } from "../src/http.js";
import { baseResult, type ProbeHandler } from "../src/probes.js";
import { collectProviderSources, PROVIDER_SOURCE_TIMEOUT_MS } from "../src/provider-collection.js";
import { providerLog, type ProviderDiagnostic } from "../src/provider-diagnostics.js";
import { createResultOutput } from "../src/results.js";
import { getConnectivityMetricsForExchange, getMessageVolumeMetricsForTeamsChat, serviceActivityPath, serviceActivityWindow } from "../src/service-activity.js";
import { parseServiceConfig, serviceSettings, type ServiceConfig } from "../src/service-config.js";
import { getServiceHealthIssues, getServiceHealthOverviews, normalizeServiceHealthIssue } from "../src/service-health.js";
import { runServiceWorker } from "../src/worker.js";
import * as auth from "../src/auth.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const stamp = "2026-10-16T18:30:00.000Z";
const now = () => Date.parse(stamp);
beforeEach(() => { vi.spyOn(Date, "now").mockImplementation(now); });
const signal = () => new AbortController().signal;
const env = { ENABLE_LIVE_M365: "true", ENABLE_BETA_SERVICE_ACTIVITY: "true" };
const functionNames = {
  exchange: "getConnectivityMetricsForExchange", teams: "getMessageVolumeMetricsForTeamsChat",
} as const;
const collectors = { exchange: exchangeProviders, teams: teamsProviders, sharepoint: sharepointProviders };
const names = { exchange: "Exchange Online", teams: "Microsoft Teams", sharepoint: "SharePoint Online" };
function rawConfig(type: ServiceConfig["type"] = "exchange") {
  const target = type === "exchange" ? { mailbox: "private@example.invalid" }
    : type === "sharepoint" ? { siteId: "site", driveId: "drive", folderId: "folder" }
      : {
        tenantId: "11111111-1111-4111-8111-111111111111", teamId: "22222222-2222-4222-8222-222222222222",
        channelId: "channel", serviceUrl: "https://smba.trafficmanager.net/teams/",
      };
  return {
    type, mode: "live", enabled: true, cohort: `${type}-global`,
    intervalSeconds: 60, timeoutSeconds: 45,
    targets: [{ id: "one", ...target }, { id: "two", ...target }],
  };
}
function client(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const token = vi.fn(async () => ({ token: "test-only-token", expiresOnTimestamp: Date.now() + 100000 }));
  const fetcher = vi.fn<typeof fetch>((url, init) => Promise.resolve(reply(String(url), init)));
  const graph = new GraphClient(new AuthenticatedHttp({ getToken: token }, "https://graph.microsoft.com/.default", {
    fetch: fetcher, sleep: async () => undefined,
  }));
  vi.spyOn(auth, "createLiveGraphClient").mockReturnValue(graph);
  return { graph, fetcher, token };
}
const json = (value: unknown) => new Response(JSON.stringify(value));
const memory = () => {
  const events = { emit: vi.fn() };
  return { events, results: createResultOutput(events) };
};
const overview = (type: Exclude<ServiceConfig["type"], "onedrive"> = "exchange") => ({ id: "reported-service", service: names[type], status: "serviceOperational" });
const activity = (type: "exchange" | "teams" = "exchange") => ({
  intervalStartDateTime: "2026-10-16T18:00:00Z", ...(type === "exchange" ? { percentage: 97.5 } : { value: 42 }),
});

describe("strict optional provider configuration", () => {
  it("defaults all providers off without expanding permissions", () => {
    expect(parseServiceConfig(rawConfig())).toMatchObject({
      serviceHealth: false, serviceActivity: { enabled: false, aggregationIntervalMinutes: 15, lookbackMinutes: 30 },
    });
  });
  it.each([null, "true", 1, {}, []])("rejects non-boolean serviceHealth %j", serviceHealth => {
    expect(() => parseServiceConfig({ ...rawConfig(), serviceHealth })).toThrow("serviceHealth");
  });
  it.each([
    null, true, { enabled: "true" }, { unexpected: true },
    { aggregationIntervalMinutes: 1 }, { aggregationIntervalMinutes: 20 },
    { lookbackMinutes: 0 }, { lookbackMinutes: 1441 }, { lookbackMinutes: 15.5 },
    { lookbackMinutes: 10, aggregationIntervalMinutes: 15 }, { lookbackMinutes: 31 },
    { functions: [] }, { functions: ["https://untrusted.invalid/function"] },
    { functions: ["unsupportedFunction"] },
    { functions: ["getConnectivityMetricsForExchange", "getConnectivityMetricsForExchange"] },
  ])("rejects invalid/unknown beta fields %j", serviceActivity => {
    expect(() => parseServiceConfig({ ...rawConfig(), serviceActivity })).toThrow();
  });
  it.each([5, 10, 15, 30])("accepts bounded multiples for %i-minute aggregation", aggregationIntervalMinutes => {
    for (const lookbackMinutes of [aggregationIntervalMinutes, 1440]) {
      expect(parseServiceConfig({ ...rawConfig(), serviceActivity: { aggregationIntervalMinutes, lookbackMinutes } }).serviceActivity.lookbackMinutes)
        .toBe(lookbackMinutes);
    }
  });
  it.each(["exchange", "teams"] as const)("only accepts the verified %s function", type => {
    expect(parseServiceConfig({ ...rawConfig(type), serviceActivity: { functions: [functionNames[type]] } })).toBeDefined();
    expect(() => parseServiceConfig({
      ...rawConfig(type), serviceActivity: { functions: [functionNames[type === "exchange" ? "teams" : "exchange"]] },
    })).toThrow("Unsupported serviceActivity");
  });
  it("rejects SharePoint beta even without an explicit function, before initialization/mutations", async () => {
    const createDependencies = vi.fn();
    const handler = vi.fn();
    await expect(runServiceWorker({
      ...rawConfig("sharepoint"), serviceActivity: { enabled: true },
    } as unknown as ServiceConfig, { createDependencies, handler, env })).rejects.toThrow("SharePoint");
    expect(createDependencies).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it.each([undefined, "false", "TRUE", "1"])("requires exact beta acknowledgement %s before all runtime creation", async acknowledgement => {
    const createDependencies = vi.fn();
    await expect(runServiceWorker(parseServiceConfig({
      ...rawConfig(), serviceActivity: { enabled: true, functions: ["getConnectivityMetricsForExchange"] },
    }), { createDependencies, providers: exchangeProviders, env: { ENABLE_LIVE_M365: "true", ENABLE_BETA_SERVICE_ACTIVITY: acknowledgement } }))
      .rejects.toThrow("ENABLE_BETA_SERVICE_ACTIVITY=true");
    expect(createDependencies).not.toHaveBeenCalled();
  });
  it("requires beta acknowledgement in simulation too; live acknowledgement remains independent", () => {
    const config = parseServiceConfig({ ...rawConfig(), mode: "simulation", serviceActivity: { enabled: true } });
    expect(() => serviceSettings(config, {})).toThrow("ENABLE_BETA");
    expect(() => serviceSettings(config, env)).not.toThrow();
    expect(() => serviceSettings(parseServiceConfig({ ...config, mode: "live" }), { ENABLE_BETA_SERVICE_ACTIVITY: "true" })).toThrow("ENABLE_LIVE_M365");
  });
});

describe("bounded UTC beta report windows", () => {
  it("constructs the user's exact unquoted DateTimeOffset function call", () => {
    const window = serviceActivityWindow({}, Date.parse("2026-10-16T18:32:47.123Z"));
    expect(window).toEqual({ start: "2026-10-16T18:00:00.000Z", end: stamp, aggregationIntervalMinutes: 15 });
    expect(serviceActivityPath("getConnectivityMetricsForExchange", window)).toBe(
      "/reports/serviceActivity/getConnectivityMetricsForExchange(inclusiveIntervalStartDateTime=2026-10-16T18:00:00Z,exclusiveIntervalEndDateTime=2026-10-16T18:30:00Z,aggregationIntervalInMinutes=15)",
    );
  });
  it.each([5, 10, 15, 30] as const)("floors %i-minute UTC boundaries across midnight and offsets", aggregationIntervalMinutes => {
    const current = Date.parse("2026-10-17T02:00:00+02:00");
    const exact = serviceActivityWindow({ aggregationIntervalMinutes }, current);
    const before = serviceActivityWindow({ aggregationIntervalMinutes }, current - 1);
    expect(exact.end).toBe("2026-10-17T00:00:00.000Z");
    expect(Date.parse(before.end)).toBe(current - aggregationIntervalMinutes * 60000);
    expect(Date.parse(before.end)).toBeLessThan(current - 1);
    const fullDay = serviceActivityWindow({ aggregationIntervalMinutes, lookbackMinutes: 1440 }, current);
    expect(Date.parse(fullDay.end) - Date.parse(fullDay.start)).toBe(86400000);
  });
  it.each([NaN, Infinity])("rejects invalid wall clocks %s", time => {
    expect(() => serviceActivityWindow({}, time)).toThrow();
  });
  it("does not permit arbitrary function identifiers even through untyped calls", () => {
    expect(() => serviceActivityPath("https://untrusted.invalid" as never, serviceActivityWindow({}, now()))).toThrow();
  });
});

describe("read-only Graph provider clients", () => {
  it("uses stable v1.0 paths, Graph scope and bearer with redirect protection", async () => {
    const http = client(url => json({ value: url.includes("healthOverviews") ? [overview()] : [] }));
    await getServiceHealthOverviews(http.graph, signal());
    await getServiceHealthIssues(http.graph, signal());
    expect(http.fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/healthOverviews?$top=100",
      "https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/issues?$top=100",
    ]);
    for (const [, init] of http.fetcher.mock.calls) {
      expect(init).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer test-only-token" } });
    }
    expect(http.token).toHaveBeenCalledWith("https://graph.microsoft.com/.default", expect.anything());
  });
  it.each(["exchange", "teams"] as const)("uses beta only for the verified %s report", async type => {
    const http = client(() => json({ value: [activity(type)] }));
    const window = serviceActivityWindow({}, now());
    await (type === "exchange" ? getConnectivityMetricsForExchange : getMessageVolumeMetricsForTeamsChat)(http.graph, window, signal());
    expect(http.fetcher.mock.calls[0]?.[0]).toBe(`https://graph.microsoft.com/beta${serviceActivityPath(functionNames[type], window)}`);
  });
  it.each([
    ["https://untrusted.invalid/v1.0/admin/serviceAnnouncement/issues", "read-failure"],
    ["https://graph.microsoft.com/beta/admin/serviceAnnouncement/issues", "read-failure"],
    ["https://graph.microsoft.com/v1.0/users", "read-failure"],
    ["https://user:secret@graph.microsoft.com/v1.0/admin/serviceAnnouncement/issues", "read-failure"],
    ["https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/issues#fragment", "read-failure"],
  ])("rejects escaped pagination %s before acquiring another token", async (next, category) => {
    const http = client(() => json({ value: [], "@odata.nextLink": next }));
    await expect(getServiceHealthIssues(http.graph, signal())).rejects.toMatchObject({ category });
    expect(http.fetcher).toHaveBeenCalledOnce();
    expect(http.token).toHaveBeenCalledOnce();
  });
  it("follows all stable pages before filtering; strips unapproved metadata", async () => {
    let page = 0;
    const http = client(() => json(++page === 1 ? {
      value: [{ id: "other", service: "Other Service", status: "unknown", token: "never-log" }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/healthOverviews?$skiptoken=two",
    } : { value: [{ ...overview(), token: "never-log" }] }));
    const records = await getServiceHealthOverviews(http.graph, signal());
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual(overview());
    expect(http.fetcher.mock.calls[1]?.[0]).toContain("?$skiptoken=two");
  });
  it("fails a page budget rather than returning partial overviews", async () => {
    let page = 0;
    const http = client(() => json({
      value: [overview()], "@odata.nextLink": `https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/healthOverviews?$skiptoken=${++page}`,
    }));
    await expect(getServiceHealthOverviews(http.graph, signal())).rejects.toMatchObject({ category: "pagination-budget" });
    expect(http.fetcher).toHaveBeenCalledTimes(5);
  });
  it("rejects cycles within the pagination budget", async () => {
    const http = client(() => json({
      value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/issues?$top=100",
    }));
    await expect(getServiceHealthIssues(http.graph, signal())).rejects.toMatchObject({ category: "pagination-budget" });
    expect(http.fetcher).toHaveBeenCalledOnce();
  });
  it.each([null, {}, { value: {} }, { value: [{}] }, { value: [], "@odata.nextLink": null }])(
    "rejects malformed stable payloads %j", async payload => {
      const http = client(() => json(payload));
      await expect(getServiceHealthOverviews(http.graph, signal())).rejects.toMatchObject({ category: "malformed-response" });
    },
  );
  it.each([
    {}, { percentage: -1 }, { percentage: 101 }, { percentage: "98" },
    { percentage: 90, intervalStartDateTime: "not-date" },
    { percentage: 90, intervalStartDateTime: "2026-10-16T17:45:00Z" },
    { percentage: 90, intervalStartDateTime: "2026-10-16T18:30:00Z" },
    { percentage: 90, intervalStartDateTime: "2026-10-16T18:01:00Z" },
  ])("rejects invalid percentages and outside/misaligned intervals %j", async data => {
    const http = client(() => json({ value: [{ intervalStartDateTime: "2026-10-16T18:00:00Z", ...data }] }));
    await expect(getConnectivityMetricsForExchange(http.graph, serviceActivityWindow({}, now()), signal())).rejects.toMatchObject({ category: "malformed-response" });
  });
  it.each([-1, 1.25, "42", Number.MAX_SAFE_INTEGER + 1, null])("does not round invalid Int64 report values %s", async value => {
    const http = client(() => json({ value: [{ ...activity("teams"), value }] }));
    await expect(getMessageVolumeMetricsForTeamsChat(http.graph, serviceActivityWindow({}, now()), signal())).rejects.toMatchObject({ category: "malformed-response" });
  });
  it("preserves the largest safe integer and zero percentages/counts", async () => {
    for (const value of [0, Number.MAX_SAFE_INTEGER]) {
      const http = client(() => json({ value: [{ ...activity("teams"), value }] }));
      expect((await getMessageVolumeMetricsForTeamsChat(http.graph, serviceActivityWindow({}, now()), signal()))[0]?.value).toBe(value);
    }
    const http = client(() => json({ value: [{ ...activity(), percentage: 0 }] }));
    expect((await getConnectivityMetricsForExchange(http.graph, serviceActivityWindow({}, now()), signal()))[0]?.percentage).toBe(0);
  });
  it("rejects duplicate intervals and empty beta collections explicitly", async () => {
    for (const rows of [[], [activity(), activity()]]) {
      const http = client(() => json({ value: rows }));
      await expect(getConnectivityMetricsForExchange(http.graph, serviceActivityWindow({}, now()), signal())).rejects.toMatchObject({
        category: rows.length ? "malformed-response" : "no-data",
      });
    }
  });
  it("accepts the complete maximum one-day report in one page (288 five-minute buckets)", async () => {
    const window = serviceActivityWindow({ aggregationIntervalMinutes: 5, lookbackMinutes: 1440 }, now());
    const rows = Array.from({ length: 288 }, (_, index) => ({
      intervalStartDateTime: new Date(Date.parse(window.start) + index * 5 * 60_000).toISOString(), value: index,
    }));
    const http = client(() => json({ value: rows }));
    expect(await getMessageVolumeMetricsForTeamsChat(http.graph, window, signal())).toHaveLength(288);
    expect(http.fetcher).toHaveBeenCalledOnce();
  });
  it("rejects direct future/older-than-30-day windows before tokens or network", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now());
    const http = client(() => json({ value: [] }));
    for (const time of [now() + 60 * 60_000, now() - 31 * 86400000]) {
      const window = serviceActivityWindow({}, time);
      await expect(getConnectivityMetricsForExchange(http.graph, window, signal())).rejects.toMatchObject({ category: "collector-failure" });
    }
    expect(http.token).not.toHaveBeenCalled();
    expect(http.fetcher).not.toHaveBeenCalled();
  });
  it("bounds streamed provider pages in bytes and cancels oversized responses", async () => {
    const cancel = vi.fn();
    const http = client(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2_000_001)); },
      cancel,
    })));
    await expect(getServiceHealthIssues(http.graph, signal())).rejects.toMatchObject({ category: "malformed-response" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("allows continuation only for the exact beta function and interval", async () => {
    const window = serviceActivityWindow({}, now());
    const path = serviceActivityPath("getConnectivityMetricsForExchange", window);
    let page = 0;
    const http = client(() => json(++page === 1 ? {
      value: [activity()], "@odata.nextLink": `https://graph.microsoft.com/beta${path}?$skiptoken=next`,
    } : { value: [{ ...activity(), intervalStartDateTime: "2026-10-16T18:15:00Z" }] }));
    expect(await getConnectivityMetricsForExchange(http.graph, window, signal())).toHaveLength(2);
    const escaped = client(() => json({ value: [], "@odata.nextLink": `https://graph.microsoft.com/v1.0${path}?$skiptoken=next` }));
    await expect(getConnectivityMetricsForExchange(escaped.graph, window, signal())).rejects.toMatchObject({ category: "read-failure" });
    expect(escaped.fetcher).toHaveBeenCalledOnce();
  });
});

describe("isolated once-per-cycle provider diagnostics", () => {
  it("starts the journey without waiting for a slow diagnostic source and outputs its late records", async () => {
    vi.useFakeTimers();
    client(() => json({ value: [] }));
    const results = {
      record: vi.fn(),
      recordDiagnostic: vi.fn(),
    };
    const events = { emit: vi.fn() };
    const handler = vi.fn(async probe => ({
      ...baseResult(probe, now()), success: true, durationMs: 100,
    }));
    const pending = runServiceWorker(parseServiceConfig({
      ...rawConfig(), serviceActivity: { enabled: true },
    }), {
      once: true, env, telemetry: events, handler,
      createDependencies: () => ({ results, telemetry: events }),
      providers: async context => {
        await new Promise(resolve => setTimeout(resolve, PROVIDER_SOURCE_TIMEOUT_MS));
        context.results.recordDiagnostic({
          kind: "failure", service: "exchange", collectedAt: stamp,
          source: "getConnectivityMetricsForExchange", apiVersion: "beta", category: "collection-budget",
        });
        return { configured: 1, succeeded: 0, failed: 1, skipped: 0, records: 0 };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(results.record).toHaveBeenCalledTimes(2);
    expect(events.emit.mock.calls.filter(([event]) => event === "provider-diagnostic")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(PROVIDER_SOURCE_TIMEOUT_MS);
    await pending;
    expect(events.emit.mock.calls.filter(([event]) => event === "provider-diagnostic")).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledWith("service-provider-summary", expect.objectContaining({
      providers: { configured: 1, succeeded: 0, failed: 1, skipped: 0, records: 0 },
    }));
    expect(results.record.mock.calls.every(([attempt]) => attempt.success)).toBe(true);
  });
  it.each(["exchange", "teams", "sharepoint"] as const)("collects each %s source once with two targets and preserves journey counts", async type => {
    const service = parseServiceConfig({
      ...rawConfig(type), serviceHealth: true, serviceActivity: {
        enabled: type !== "sharepoint", ...(type === "sharepoint" ? {} : { functions: [functionNames[type]] }),
      },
    });
    const http = client(url => json({
      value: url.includes("healthOverviews") ? [overview(type), overview(type === "exchange" ? "teams" : "exchange")]
        : url.includes("/issues") ? [{ id: "issue", service: names[type], status: "serviceDegradation", title: "Provider announcement" }]
          : [{ intervalStartDateTime: new Date(Date.now() - 30 * 60_000).toISOString().replace(/:\d\d\.\d\d\dZ$/, ":00.000Z"), percentage: 99, value: 2 }],
    }));
    vi.spyOn(Date, "now").mockReturnValue(now());
    const telemetry = memory();
    const stepName = type === "exchange" ? "create-draft" : type === "teams" ? "post-message" : "verify-drive";
    const handler = vi.fn<ProbeHandler>(async probe => ({
      ...baseResult(probe, now()), success: true, durationMs: 100,
      steps: [{ name: stepName, status: "succeeded" as const, observedAt: stamp, durationMs: 10 }],
    }));
    try {
      await runServiceWorker(service, {
        once: true, env, providers: collectors[type], handler, telemetry: telemetry.events,
        createDependencies: () => ({ ...telemetry, telemetry: telemetry.events, graph: http.graph }),
      });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(http.fetcher).toHaveBeenCalledTimes(type === "sharepoint" ? 2 : 3);
      expect(http.fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
      const records = telemetry.events.emit.mock.calls.filter(([event]) => event === "provider-diagnostic").map(([, data]) => data);
      expect(records.filter(record => record.body === "m365-service-health-overview")).toHaveLength(1);
      expect(records.filter(record => record.body === "m365-service-health-issue")).toHaveLength(1);
      expect(records.filter(record => record.body === "m365-service-activity")).toHaveLength(type === "sharepoint" ? 0 : 1);
      const observations = telemetry.events.emit.mock.calls.filter(([event]) => event === "synthetic-result").map(([, data]) => data.result);
      expect(observations).toHaveLength(2);
      expect(observations.every(result => result.success && result.steps.length === 1)).toBe(true);
      expect(JSON.stringify(observations)).not.toContain("provider.");
      expect(telemetry.events.emit).toHaveBeenCalledWith("service-provider-summary", expect.objectContaining({
        providers: { configured: type === "sharepoint" ? 2 : 3, succeeded: type === "sharepoint" ? 2 : 3, failed: 0, skipped: 0, records: type === "sharepoint" ? 3 : 4 },
      }));
    } finally {
      vi.restoreAllMocks();
    }
  });
  it.each([
    [403, "permission-failure"], [429, "graph-throttling"], [500, "graph-unavailable"],
  ] as const)("sanitizes HTTP %i without blocking stable issues/beta or altering successful probe 1/0", async (status, category) => {
    vi.spyOn(Date, "now").mockReturnValue(now());
    const http = client(url => url.includes("healthOverviews")
      ? new Response("PRIVATE-ERROR-BODY", { status, headers: { "retry-after": "0" } })
      : json({ value: url.includes("/issues") ? [] : [activity()] }));
    const telemetry = memory();
    try {
      await runServiceWorker(parseServiceConfig({
        ...rawConfig(), serviceHealth: true, serviceActivity: { enabled: true, functions: ["getConnectivityMetricsForExchange"] },
      }), {
        once: true, env, providers: exchangeProviders, telemetry: telemetry.events,
        handler: async probe => ({ ...baseResult(probe, now()), success: true, durationMs: 100 }),
        createDependencies: () => ({ ...telemetry, telemetry: telemetry.events, graph: http.graph }),
      });
      const records = telemetry.events.emit.mock.calls.filter(([event]) => event === "provider-diagnostic").map(([, data]) => data);
      expect(records.find(record => record.body === "m365-provider-collection-failed")?.attributes).toMatchObject({
        "provider.source": "serviceAnnouncement.healthOverviews", "provider.category": category,
        "provider.http_status": status, "provider.api_version": "v1.0", "provider.mode": "live",
      });
      expect(records.filter(record => record.body === "m365-service-activity")).toHaveLength(1);
      expect(telemetry.events.emit).toHaveBeenCalledWith("service-provider-summary", expect.objectContaining({
        providers: { configured: 3, succeeded: 2, failed: 1, skipped: 0, records: 2 },
      }));
      expect(JSON.stringify(records)).not.toMatch(/PRIVATE-ERROR-BODY|test-only-token|private@example/);
      expect(telemetry.events.emit.mock.calls.filter(([event]) => event === "synthetic-result").map(([, data]) => data.result.success)).toEqual([true, true]);
    } finally { vi.restoreAllMocks(); }
  });
  it("reports no-data for missing exact service and invalid beta without fabricating serviceOperational", async () => {
    const http = client(url => json({
      value: url.includes("healthOverviews") ? [{ ...overview(), service: "Exchange" }]
        : url.includes("/issues") ? [] : [{ ...activity(), percentage: 200 }],
    }));
    const recordDiagnostic = vi.fn();
    const summary = await exchangeProviders({
      service: parseServiceConfig({ ...rawConfig(), serviceHealth: true, serviceActivity: { enabled: true, functions: ["getConnectivityMetricsForExchange"] } }),
      graph: http.graph, signal: signal(), results: { recordDiagnostic }, now,
    });
    expect(summary).toEqual({ configured: 3, succeeded: 1, failed: 2, skipped: 0, records: 1 });
    expect(recordDiagnostic.mock.calls.filter(([record]) => record.kind === "failure").map(([record]) => record.category).sort())
      .toEqual(["malformed-response", "no-data"]);
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "issue-summary", count: 0 }));
    expect(JSON.stringify(recordDiagnostic.mock.calls)).not.toContain("serviceOperational");
  });
  it.each(["invalid-value", "empty", "http-error", "invalid-json"] as const)(
    "keeps beta %s diagnostic-only while stable context and successful journey results report", async failure => {
      const http = client(url => {
        if (url.includes("healthOverviews")) return json({ value: [overview()] });
        if (url.includes("/issues")) return json({ value: [] });
        if (failure === "http-error") return new Response("PRIVATE-BETA-FAILURE", { status: 500 });
        if (failure === "invalid-json") return new Response("PRIVATE-BETA-FAILURE");
        return json({ value: failure === "empty" ? [] : [{ ...activity(), percentage: 500 }] });
      });
      const telemetry = memory();
      try {
        await runServiceWorker(parseServiceConfig({
          ...rawConfig(), serviceHealth: true, serviceActivity: { enabled: true, functions: ["getConnectivityMetricsForExchange"] },
        }), {
          once: true, env, providers: exchangeProviders, telemetry: telemetry.events,
          handler: async probe => ({ ...baseResult(probe, now()), success: true, durationMs: 100 }),
          createDependencies: () => ({ ...telemetry, telemetry: telemetry.events, graph: http.graph }),
        });
        const logs = telemetry.events.emit.mock.calls.filter(([event]) => event === "provider-diagnostic").map(([, data]) => data);
        expect(logs.filter(log => log.body === "m365-service-health-overview")).toHaveLength(1);
        expect(logs.filter(log => log.body === "m365-service-activity")).toHaveLength(0);
        expect(logs.find(log => log.body === "m365-provider-collection-failed")?.attributes).toMatchObject({
          "provider.api_version": "beta", "provider.source": "getConnectivityMetricsForExchange",
        });
        const results = telemetry.events.emit.mock.calls.filter(([event]) => event === "synthetic-result").map(([, data]) => data.result);
        expect(results).toHaveLength(2);
        expect(results.every(result => result.success)).toBe(true);
        expect(telemetry.events.emit).toHaveBeenCalledWith("service-provider-summary", expect.objectContaining({
          providers: { configured: 3, succeeded: 2, failed: 1, skipped: 0, records: 2 },
        }));
        expect(JSON.stringify(logs)).not.toContain("PRIVATE-BETA-FAILURE");
      } finally { vi.restoreAllMocks(); }
    },
  );
  it("recollects stateless windows each cycle rather than reusing a watermark or appending metrics", async () => {
    let clock = now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const http = client(() => json({
      value: [{
        intervalStartDateTime: new Date(clock - 30 * 60_000).toISOString(), percentage: 99,
      }],
    }));
    const recordDiagnostic = vi.fn();
    const service = parseServiceConfig({ ...rawConfig(), serviceActivity: { enabled: true, functions: ["getConnectivityMetricsForExchange"] } });
    await exchangeProviders({ service, graph: http.graph, signal: signal(), results: { recordDiagnostic }, now: () => clock });
    clock += 15 * 60_000;
    await exchangeProviders({ service, graph: http.graph, signal: signal(), results: { recordDiagnostic }, now: () => clock });
    expect(http.fetcher).toHaveBeenCalledTimes(2);
    expect(String(http.fetcher.mock.calls[0]?.[0])).toContain("exclusiveIntervalEndDateTime=2026-10-16T18:30:00Z");
    expect(String(http.fetcher.mock.calls[1]?.[0])).toContain("exclusiveIntervalEndDateTime=2026-10-16T18:45:00Z");
    expect(recordDiagnostic.mock.calls.every(([record]) => record.kind === "activity")).toBe(true);
  });
  it("bounds a non-cooperative provider and does not delay other source completion", async () => {
    vi.useFakeTimers();
    const recordDiagnostic = vi.fn();
    const graph = client(() => json({ value: [] })).graph;
    const pending = collectProviderSources({
      service: parseServiceConfig(rawConfig()), graph, signal: signal(), results: { recordDiagnostic }, now,
    }, [
      { source: "serviceAnnouncement.issues", apiVersion: "v1.0", collect: () => new Promise(() => undefined) },
      { source: "serviceAnnouncement.healthOverviews", apiVersion: "v1.0", collect: async () => [] },
    ]);
    await vi.advanceTimersByTimeAsync(PROVIDER_SOURCE_TIMEOUT_MS);
    expect(await pending).toMatchObject({ succeeded: 1, failed: 1 });
    expect(recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ category: "collection-budget" }));
  });
  it("does no Graph I/O or authentication for simulation and disabled/default providers", async () => {
    const http = client(() => { throw new Error("network forbidden"); });
    const recordDiagnostic = vi.fn();
    const config = parseServiceConfig({
      ...rawConfig(), mode: "simulation", serviceHealth: true, serviceActivity: { enabled: true, functions: ["getConnectivityMetricsForExchange"] },
    });
    expect(await exchangeProviders({ service: config, graph: http.graph, signal: signal(), results: { recordDiagnostic }, now }))
      .toEqual({ configured: 3, succeeded: 0, failed: 0, skipped: 3, records: 0 });
    expect(recordDiagnostic.mock.calls.every(([record]) => record.kind === "skipped")).toBe(true);
    expect(await exchangeProviders({ service: parseServiceConfig(rawConfig()), graph: http.graph, signal: signal(), results: { recordDiagnostic }, now }))
      .toMatchObject({ configured: 0 });
    const createDependencies = vi.fn();
    await runServiceWorker(parseServiceConfig({ ...config, enabled: false }), { createDependencies, env: {} });
    expect(createDependencies).not.toHaveBeenCalled();
    expect(http.fetcher).not.toHaveBeenCalled();
    expect(http.token).not.toHaveBeenCalled();
  });
  it("runs configured simulation through the real runtime without creating Graph credentials or making fetch calls", async () => {
    const createGraph = vi.spyOn(auth, "createLiveGraphClient");
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const events = { emit: vi.fn() };
    await runServiceWorker(parseServiceConfig({
      ...rawConfig(), mode: "simulation", serviceHealth: true, serviceActivity: { enabled: true, functions: ["getConnectivityMetricsForExchange"] },
    }), { once: true, env, providers: exchangeProviders, telemetry: events });
    expect(createGraph).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    const diagnostics = events.emit.mock.calls.filter(([event]) => event === "provider-diagnostic");
    expect(diagnostics).toHaveLength(3);
    expect(JSON.stringify(diagnostics)).not.toMatch(/serviceOperational|provider.status/);
    expect(events.emit).toHaveBeenCalledWith("service-provider-summary", expect.objectContaining({
      providers: { configured: 3, succeeded: 0, failed: 0, skipped: 3, records: 0 },
    }));
  });
});

describe("approved flat provider log contract and bounded issue history", () => {
  it("matches the parent model's exact live v1.0 overview selectors and collection timestamp", () => {
    const log = providerLog({
      kind: "overview", service: "exchange", collectedAt: stamp,
      serviceId: "Exchange", serviceName: "Exchange Online", status: "serviceDegradation",
    });
    expect(log).toEqual({
      body: "m365-service-health-overview", timestamp: new Date(stamp),
      attributes: {
        "provider.service": "exchange", "provider.mode": "live", "provider.api_version": "v1.0",
        "provider.collected_at": stamp, "provider.source": "serviceAnnouncement.healthOverviews",
        "provider.service_id": "Exchange", "provider.service_name": "Exchange Online", "provider.status": "serviceDegradation",
      },
    });
  });
  it("preserves approved issue metadata and post history with explicit truncation", () => {
    const issue = {
      id: "EX123", service: names.exchange, status: "serviceDegradation", classification: "incident",
      title: "Provider incident", impactDescription: "Reported impact", feature: "Mail", featureGroup: "Transport",
      startDateTime: stamp, endDateTime: null, lastModifiedDateTime: stamp, isResolved: false,
      posts: [{ createdDateTime: stamp, postType: "regular", description: { contentType: "text", content: "History entry" } }],
    };
    const record = normalizeServiceHealthIssue(issue, "exchange", stamp);
    if (record.kind !== "issue") throw new Error("wrong fixture");
    expect(JSON.parse(record.metadata)).toMatchObject({ ...issue, postsTotal: 1, truncated: false });
    const large = normalizeServiceHealthIssue({
      ...issue, impactDescription: "\u0001".repeat(10000),
      posts: Array.from({ length: 50 }, () => ({ ...issue.posts[0]!, description: { contentType: "html", content: "\u0001".repeat(10000) } })),
    }, "exchange", stamp);
    if (large.kind !== "issue") throw new Error("wrong fixture");
    expect(large.truncated).toBe(true);
    expect(large.metadata.length).toBeLessThanOrEqual(6000);
    expect(JSON.parse(large.metadata)).toMatchObject({ postsTotal: 50, truncated: true });
    expect(providerLog(large).attributes["provider.truncated"]).toBe(true);
  });
  it("rejects arbitrary attributes, unsupported records and crossed beta/health semantics", () => {
    const base = { kind: "overview", service: "exchange", collectedAt: stamp, serviceId: "id", serviceName: names.exchange, status: "raw" };
    expect(() => providerLog({ ...base, Authorization: "secret" } as unknown as ProviderDiagnostic)).toThrow();
    expect(() => providerLog({
      kind: "activity", service: "exchange", collectedAt: stamp,
      function: "getMessageVolumeMetricsForTeamsChat", intervalStart: stamp, intervalEnd: stamp, aggregationIntervalMinutes: 15, value: 1,
    })).toThrow();
    const beta = providerLog({
      kind: "activity", service: "exchange", collectedAt: stamp, function: "getConnectivityMetricsForExchange",
      intervalStart: "2026-10-16T18:00:00.000Z", intervalEnd: "2026-10-16T18:15:00.000Z", aggregationIntervalMinutes: 15, percentage: 90,
    });
    expect(beta.body).toBe("m365-service-activity");
    expect(beta.attributes).toMatchObject({ "provider.api_version": "beta", "provider.percentage": 90 });
    expect(beta.attributes).not.toHaveProperty("provider.status");
    expect(JSON.stringify(beta)).not.toMatch(/synthetic|probe\./);
  });
});
