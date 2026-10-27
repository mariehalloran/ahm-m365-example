import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeProviders } from "../../exchange/src/providers.js";
import { teamsProviders } from "../../teams/src/providers.js";
import { oneDriveProviders } from "../../onedrive/src/providers.js";
import * as auth from "../src/auth.js";
import * as resultOutput from "../src/results.js";
import { ConfigurationError } from "../src/config.js";
import { probeServices, type Probe, type SyntheticResult } from "../src/contracts.js";
import * as healthReports from "../src/health-reports.js";
import { baseResult } from "../src/probes.js";
import { readProjectConfig, type ProjectConfig } from "../src/project-config.js";
import type { ProviderDiagnostic } from "../src/provider-diagnostics.js";
import { parseServiceConfig, type ServiceConfig } from "../src/service-config.js";
import { runServiceWorker } from "../src/worker.js";
import type { ExecutionMode } from "../src/results.js";

const credentials = vi.hoisted(() => ({
  managed: vi.fn(), certificate: vi.fn(),
  token: vi.fn(async () => ({ token: "test-only-token", expiresOnTimestamp: Date.now() + 60000 })),
}));
vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: vi.fn(function (...args) {
    credentials.managed(...args);
    return { getToken: credentials.token };
  }),
  ClientCertificateCredential: vi.fn(function (...args) {
    credentials.certificate(...args);
    return { getToken: credentials.token };
  }),
}));

const checkedIn = await readProjectConfig("../monitoring.config.json");
const env = {
  ENABLE_LIVE_M365: "true", AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
  AZURE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
};
const collectors = { exchange: exchangeProviders, teams: teamsProviders };
const serviceNames = { exchange: "Exchange Online", teams: "Microsoft Teams" };
const results = {
  record: vi.fn<(result: SyntheticResult, mode: ExecutionMode) => void>(),
  recordDiagnostic: vi.fn<(record: ProviderDiagnostic) => void>(),
};
const output = { emit: vi.fn() };
const reportHealth = vi.fn<healthReports.HealthReporter>(async () => undefined);

function project(): ProjectConfig {
  const configured = structuredClone(checkedIn);
  configured.serviceHealth.enabled = true;
  configured.healthModel.subscriptionId = env.AZURE_TENANT_ID;
  configured.services.exchange.targets = [{ id: "exchange-one", mailbox: "dedicated@example.invalid" }];
  configured.services.exchange.scenarios = {
    "send-receive-mail": true, "edit-reopen-draft": true, "attachment-mail": false,
    "reply-mail": false,
    "distribution-list-mail": false, "recurring-calendar": false, "meeting-invitation": false,
  };
  configured.services.teams.targets = [{
    id: "teams-one", tenantId: env.AZURE_TENANT_ID, teamId: "33333333-3333-4333-8333-333333333333",
    channelId: "approved-channel", serviceUrl: "https://smba.trafficmanager.net/teams/",
  }];
  configured.services.teams.scenarios["scheduled-meeting"] = false;
  return configured;
}
function service(type: ServiceConfig["type"]): ServiceConfig {
  return parseServiceConfig({
    type, enabled: true, mode: "live", serviceHealth: true, teamsAuthentication: "bot",
    cohort: `${type}-global`, intervalSeconds: 60, timeoutSeconds: 45, targets: [{ id: `${type}-one` }],
  });
}
function providerTraffic(type: Exclude<ServiceConfig["type"], "onedrive">, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (!String(url).startsWith("https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/")) {
      throw new Error("Unexpected endpoint");
    }
    if (status !== 200) return new Response("PRIVATE-PROVIDER-ERROR", { status });
    return new Response(JSON.stringify({
      value: String(url).includes("healthOverviews")
        ? [{ id: "provider-service", service: serviceNames[type], status: "serviceOperational" }]
        : [],
    }));
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
function successfulJourney(probe: Probe) {
  const observedAt = new Date().toISOString();
  return {
    ...baseResult(probe, Date.now()), success: true, durationMs: 1,
    steps: probeServices[probe.type].steps.map(name => ({
      name, status: "succeeded" as const, observedAt, durationMs: 1,
    })),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(resultOutput, "createResultOutput").mockReturnValue(results);
  vi.spyOn(healthReports, "createHealthReporter").mockReturnValue(reportHealth);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("stable provider collection independent of live journey initialization", () => {
  it.each([200, 401, 403])("publishes OneDrive stable signals on one suppressed-context destination without changing journey success (Graph %s)", async status => {
    vi.mocked(healthReports.createHealthReporter).mockRestore();
    const configured = project();
    configured.services.onedrive.targets = [{
      id: "onedrive-one", userId: "33333333-3333-4333-8333-333333333333", userPrincipalName: "owned@example.invalid",
      driveId: "owned-drive", folderId: "owned-folder", folderName: "synthetic-owned-folder",
    }];
    const publications: { url: string; body: Record<string, unknown> }[] = [];
    const graphPaths: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).startsWith("https://management.azure.com/")) {
        publications.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: 204 });
      }
      graphPaths.push(String(url));
      if (status !== 200) return new Response("PRIVATE-PROVIDER-ERROR", { status });
      return new Response(JSON.stringify({
        value: String(url).includes("healthOverviews")
          ? [
              { id: "OneDriveForBusiness", service: "Microsoft OneDrive", status: "serviceOperational" },
              { id: "SharePoint", service: "SharePoint Online", status: "serviceInterruption" },
            ] : [],
      }));
    }));
    await runServiceWorker(service("onedrive"), {
      project: configured, once: true, env, providers: oneDriveProviders, telemetry: output,
      handler: async probe => successfulJourney(probe),
    });
    expect(graphPaths).toHaveLength(2);
    expect(graphPaths.every(path => path.startsWith("https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/"))).toBe(true);
    expect(graphPaths.some(path => path.includes("/healthOverviews/"))).toBe(false);
    const provider = publications.filter(({ body }) => String(body.signalName).startsWith("microsoft-"));
    expect(provider).toHaveLength(status === 200 ? 2 : 0);
    expect(provider.every(({ url }) => url.includes("/healthmodels/m365-experience-poc-onedrive/entities/onedrive-service-health/"))).toBe(true);
    if (status === 200) {
      expect(provider[0]?.body).toMatchObject({ healthState: "Healthy", value: 100 });
      expect(provider[1]?.body).toMatchObject({ healthState: "Unknown", value: 0 });
    } else {
      expect(results.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        kind: "failure", category: status === 401 ? "authentication-failure" : "permission-failure", httpStatus: status,
      }));
    }
    expect(results.record).toHaveBeenCalledTimes(3);
    expect(results.record.mock.calls.every(([result]) => result.success)).toBe(true);
    expect(JSON.stringify(publications)).not.toMatch(/PRIVATE-PROVIDER-ERROR|test-only-token|SharePoint/);
  });

  it.each([200, 401, 403])("publishes separate observed provider reports despite journey initialization failure (Graph %s)", async status => {
    vi.mocked(healthReports.createHealthReporter).mockRestore();
    const configured = project();
    configured.services.teams.targets = [{ id: "teams-one" }];
    const publications: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).startsWith("https://management.azure.com/")) {
        publications.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: 204 });
      }
      if (status !== 200) return new Response("PRIVATE-PROVIDER-ERROR", { status });
      return new Response(JSON.stringify({
        value: String(url).includes("healthOverviews")
          ? [{ id: "Teams", service: "Microsoft Teams", status: "serviceDegradation" }] : [],
      }));
    }));
    await expect(runServiceWorker(service("teams"), {
      project: configured, once: true, env, providers: teamsProviders, telemetry: output,
    })).rejects.toThrow("Missing dedicated resources");
    const provider = publications.filter(({ body }) => body.signalName === "microsoft-reported-service-status");
    expect(provider).toHaveLength(status === 200 ? 1 : 0);
    expect(JSON.stringify(publications)).not.toMatch(/PRIVATE-PROVIDER-ERROR|test-only-token/);
    const issues = publications.filter(({ body }) => body.signalName === "microsoft-reported-issue-count");
    expect(issues).toHaveLength(status === 200 ? 1 : 0);
    if (status === 200) {
      expect(provider[0]?.url).toContain("/healthmodels/m365-experience-poc-teams/entities/teams-service-health/");
      expect(provider[0]?.body).toMatchObject({ healthState: "Degraded", value: 50 });
      expect(issues[0]?.url).toBe(provider[0]?.url);
      expect(issues[0]?.body).toMatchObject({ healthState: "Unknown", value: 0 });
    } else {
      expect(results.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        kind: "failure", category: status === 401 ? "authentication-failure" : "permission-failure", httpStatus: status,
      }));
    }
    const synthetic = publications.filter(({ body }) => String(body.signalName).startsWith("synthetic-"));
    expect(synthetic.filter(({ body }) => body.healthState === "Unhealthy")).toHaveLength(1);
    expect(synthetic.filter(({ url }) => !url.includes("/entities/teams-global/"))
      .every(({ body }) => body.healthState === "Unknown" && body.value === undefined)).toBe(true);
  });

  it("collects stable Teams context when the selected channel journey has no dedicated resources", async () => {
    const type = "teams";
    const configured = project();
    configured.services[type].targets = [{ id: `${type}-one` }];
    const fetcher = providerTraffic(type);
    const providers = vi.fn(collectors[type]);
    await expect(runServiceWorker(service(type), {
      project: configured, once: true, env, providers, telemetry: output,
    })).rejects.toThrow("Missing dedicated resources");
    expect(providers).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url, init]) =>
      String(url).includes("/v1.0/") && init?.method === "GET")).toBe(true);
    expect(results.record).toHaveBeenCalledOnce();
    expect(results.record.mock.calls.map(([result]) => result.testType)).toEqual(["teams-channel-message"]);
    expect(results.record.mock.calls.every(([result]) =>
      !result.success && result.steps.length === 0 && result.diagnosticCategory === "configuration-failure")).toBe(true);
    expect(reportHealth).toHaveBeenCalledWith(expect.objectContaining({ results: expect.any(Array) }));
    expect(results.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "overview", service: type }));
    expect(output.emit).toHaveBeenCalledWith("service-provider-summary", expect.objectContaining({
      providers: { configured: 2, succeeded: 2, failed: 0, skipped: 0, records: 2 },
    }));
    expect(output.emit).not.toHaveBeenCalledWith("service-cycle-summary", expect.anything());
    expect(credentials.managed).toHaveBeenCalledExactlyOnceWith({ clientId: env.AZURE_CLIENT_ID });
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(reportHealth).toHaveBeenCalledTimes(2);
    expect(reportHealth).toHaveBeenCalledWith(expect.objectContaining({
      providerDiagnostics: expect.arrayContaining([
        expect.objectContaining({ kind: "overview", service: type, status: "serviceOperational" }),
        expect.objectContaining({ kind: "issue-summary", service: type, count: 0 }),
      ]),
    }));
  });

  it("emits sanitized permission-failure diagnostics, never healthy context, when the real Graph path denies collection", async () => {
    const configured = project();
    configured.services.teams.targets = [{ id: "teams-one" }];
    const fetcher = providerTraffic("teams", 403);
    await expect(runServiceWorker(service("teams"), {
      project: configured, once: true, env, providers: teamsProviders, telemetry: output,
    })).rejects.toThrow("Missing dedicated resources");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(results.recordDiagnostic.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({ kind: "failure", category: "permission-failure", httpStatus: 403, apiVersion: "v1.0" }),
      expect.objectContaining({ kind: "failure", category: "permission-failure", httpStatus: 403, apiVersion: "v1.0" }),
    ]);
    expect(output.emit).toHaveBeenCalledWith("service-provider-summary", expect.objectContaining({
      providers: { configured: 2, succeeded: 0, failed: 2, skipped: 0, records: 0 },
    }));
    expect(JSON.stringify([...results.recordDiagnostic.mock.calls, ...output.emit.mock.calls]))
      .not.toMatch(/PRIVATE-PROVIDER-ERROR|test-only-token|serviceOperational/);
    expect(reportHealth).toHaveBeenCalledWith(expect.objectContaining({
      providerDiagnostics: [
        expect.objectContaining({ source: "serviceAnnouncement.healthOverviews", category: "permission-failure", httpStatus: 403 }),
        expect.objectContaining({ source: "serviceAnnouncement.issues", category: "permission-failure", httpStatus: 403 }),
      ],
    }));
  });

  it("recollects stable context on every cadence while the channel journey remains unconfigured", async () => {
    const configured = project();
    configured.services.teams.targets = [{ id: "teams-one" }];
    const fetcher = providerTraffic("teams");
    const providers = vi.fn(teamsProviders);
    const stop = new AbortController();
    let clock = 0;
    await runServiceWorker(service("teams"), {
      project: configured, env, providers, telemetry: output, signal: stop.signal, now: () => clock,
      sleep: async milliseconds => { clock += milliseconds; if (clock >= 600000) stop.abort(); },
    });
    expect(providers.mock.calls.length).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledTimes(providers.mock.calls.length * 2);
    expect(results.record.mock.calls.length).toBeGreaterThan(0);
    expect(resultOutput.createResultOutput).toHaveBeenCalledOnce();
    expect(reportHealth.mock.calls.filter(([cycle]) => "providerDiagnostics" in cycle)).toHaveLength(providers.mock.calls.length);
  });

  it("reports provider setup failures without creating credentials, making requests, or inventing snapshots", async () => {
    const configured = project();
    configured.services.teams.targets = [{ id: "teams-one" }];
    const fetcher = providerTraffic("teams");
    await expect(runServiceWorker(service("teams"), {
      project: configured, once: true, env: { ...env, AZURE_CLIENT_ID: "" },
      providers: teamsProviders, telemetry: output,
    })).rejects.toBeInstanceOf(AggregateError);
    expect(results.recordDiagnostic.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({ kind: "failure", category: "collector-failure", apiVersion: "v1.0" }),
      expect.objectContaining({ kind: "failure", category: "collector-failure", apiVersion: "v1.0" }),
      expect.objectContaining({ kind: "failure", category: "configuration-failure", apiVersion: "v1.0" }),
    ]);
    expect(output.emit).toHaveBeenCalledWith("service-provider-summary", expect.objectContaining({
      providers: { configured: 2, succeeded: 0, failed: 2, skipped: 0, records: 0 },
    }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(credentials.managed).not.toHaveBeenCalled();
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(reportHealth).toHaveBeenCalledWith(expect.objectContaining({
      providerDiagnostics: expect.arrayContaining([expect.objectContaining({ category: "configuration-failure" })]),
    }));
  });

  it("collects Teams context even when the channel journey lacks Bot Connector credentials", async () => {
    const fetcher = providerTraffic("teams");
    await expect(runServiceWorker(service("teams"), {
      project: project(), once: true, env, providers: teamsProviders, telemetry: output,
    })).rejects.toThrow("explicit bot settings");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(results.record).toHaveBeenCalledOnce();
    expect(results.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "overview" }));
    expect(credentials.managed).toHaveBeenCalledTimes(2);
    expect(credentials.certificate).not.toHaveBeenCalled();
  });

  it("creates a separate provider Graph client when journey Graph construction fails", async () => {
    const createGraph = auth.createLiveGraphClient;
    vi.spyOn(auth, "createLiveGraphClient")
      .mockImplementationOnce(() => { throw new ConfigurationError("Journey Graph setup failed"); })
      .mockImplementation(createGraph);
    const fetcher = providerTraffic("exchange");
    await expect(runServiceWorker(service("exchange"), {
      project: project(), once: true, env, providers: exchangeProviders, telemetry: output,
    })).rejects.toThrow("Journey Graph setup failed");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(results.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: "overview" }));
    expect(results.record).toHaveBeenCalledTimes(2);
  });

  it.each(["exchange", "teams"] as const)("runs selected %s journeys but calls its stable collector only once", async type => {
    const fetcher = providerTraffic(type);
    const providers = vi.fn(collectors[type]);
    const handler = vi.fn(successfulJourney);
    await runServiceWorker(service(type), {
      project: project(), once: true, env: {
        ...env, BOT_TENANT_ID: env.AZURE_TENANT_ID,
        BOT_CLIENT_ID: "44444444-4444-4444-8444-444444444444", BOT_CLIENT_CERTIFICATE_PATH: "test-only.pem",
      },
      providers, handler: async probe => handler(probe), telemetry: output,
    });
    expect(handler).toHaveBeenCalledTimes(type === "exchange" ? 2 : 1);
    expect(results.record).toHaveBeenCalledTimes(type === "exchange" ? 2 : 1);
    expect(results.record.mock.calls.every(([result]) =>
      result.success && result.steps.some(step => step.name === "authenticate") && result.steps.some(step => step.name === "cleanup"))).toBe(true);
    expect(providers).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(output.emit).toHaveBeenCalledWith("service-provider-summary", expect.objectContaining({
      providers: { configured: 2, succeeded: 2, failed: 0, skipped: 0, records: 2 },
    }));
  });

  it("settles and publishes late provider failures even after the channel journey fails initialization", async () => {
    vi.useFakeTimers();
    const configured = project();
    configured.services.teams.targets = [{ id: "teams-one" }];
    const worker = runServiceWorker(service("teams"), {
      project: configured, once: true, env, telemetry: output,
      providers: async context => {
        await new Promise(resolve => setTimeout(resolve, 100));
        context.results.recordDiagnostic({
          kind: "failure", service: "teams", collectedAt: new Date().toISOString(),
          source: "serviceAnnouncement.issues", apiVersion: "v1.0", category: "collector-failure",
        });
        throw new Error("Provider execution failed");
      },
    });
    const rejected = expect(worker).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining("Missing dedicated resources") }),
        expect.objectContaining({ message: "Provider execution failed" })],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(results.record).toHaveBeenCalledOnce();
    expect(reportHealth).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(reportHealth).toHaveBeenCalledTimes(2);
    expect(reportHealth).toHaveBeenLastCalledWith(expect.objectContaining({
      providerDiagnostics: expect.arrayContaining([
        expect.objectContaining({ source: "serviceAnnouncement.healthOverviews", kind: "failure", category: "collector-failure" }),
      ]),
    }));
  });

  it("waits for late journeys and outputs their results when provider collection fails first", async () => {
    vi.useFakeTimers();
    const worker = runServiceWorker(service("exchange"), {
      project: project(), once: true, env, telemetry: output,
      providers: async () => { throw new Error("Provider export failed"); },
      handler: async probe => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return successfulJourney(probe);
      },
    });
    const rejected = expect(worker).rejects.toThrow("Provider export failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(results.record).not.toHaveBeenCalled();
    expect(reportHealth).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(results.record).toHaveBeenCalledTimes(2);
    expect(reportHealth).toHaveBeenCalledTimes(3);
  });
});
