import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphClient } from "../src/graph.js";
import { createLiveGraphClient, createLiveTeamsBot } from "../src/auth.js";
import { serviceRuntime } from "../src/runtime.js";
import { TeamsBotClient } from "../src/teams.js";
import { parseServiceConfig, serviceSettings } from "../src/service-config.js";

const credentials = vi.hoisted(() => ({
  certificate: vi.fn(), managed: vi.fn(), default: vi.fn(),
  token: vi.fn(async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 60000 })),
}));
vi.mock("@azure/identity", () => ({
  ClientCertificateCredential: vi.fn(function (...args) { credentials.certificate(...args); return { getToken: credentials.token }; }),
  ManagedIdentityCredential: vi.fn(function (...args) { credentials.managed(...args); return { getToken: credentials.token }; }),
  DefaultAzureCredential: vi.fn(function () { credentials.default(); }),
}));
beforeEach(() => vi.clearAllMocks());
const output = { emit: vi.fn() };
const raw = {
  type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation",
  cohort: "exchange-global", targets: [{ id: "ex-001" }],
};
const certificate = {
  AZURE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
  AZURE_CLIENT_CERTIFICATE_PATH: "certificate.pem",
};

describe("stateless service runtime", () => {
  it("leaves supplied telemetry open when probe initialization fails so the worker can export the failure", async () => {
    const service = parseServiceConfig({
      ...raw, mode: "live", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }],
    });
    const results = {
      record: vi.fn(), recordDiagnostic: vi.fn(), forceFlush: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    };
    await expect(serviceRuntime(
      service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, {}, results,
    )).rejects.toThrow("AZURE_CLIENT_ID");
    expect(results.shutdown).not.toHaveBeenCalled();
  });

  it("does not construct Azure credentials, Graph, ARM clients or state for console simulation", async () => {
    const service = parseServiceConfig(raw);
    const runtime = await serviceRuntime(service, serviceSettings(service, {}), output, {});
    try {
      expect(Object.keys(runtime).sort()).toEqual(["results", "telemetry"]);
      for (const credential of Object.values(credentials)) expect(credential).not.toHaveBeenCalled();
    } finally { await runtime.results.shutdown(); }
  });
  it("uses app-certificate Graph identity, not ARM/Blob identity, for live probes", async () => {
    const service = parseServiceConfig({ ...raw, mode: "live", graphAuthentication: "certificate", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }] });
    const runtime = await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, certificate);
    try {
      expect(runtime.graph).toBeInstanceOf(GraphClient);
      expect(credentials.certificate).toHaveBeenCalledOnce();
      expect(credentials.managed).not.toHaveBeenCalled();
      expect(credentials.default).not.toHaveBeenCalled();
    } finally { await runtime.results.shutdown(); }
  });
  it("validates Azure telemetry before constructing a live Graph client", async () => {
    const service = parseServiceConfig({ ...raw, telemetry: "azure-monitor", mode: "live", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }] });
    await expect(serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, certificate))
      .rejects.toThrow("APPLICATIONINSIGHTS_CONNECTION_STRING");
    expect(credentials.certificate).not.toHaveBeenCalled();
  });
  it("does not use a developer's CLI credentials, client secret, or host identity as a Graph fallback", () => {
    expect(() => createLiveGraphClient({}, "certificate")).toThrow("app-only certificate");
    expect(() => createLiveGraphClient({
      ...certificate, AZURE_CLIENT_CERTIFICATE_PATH: "", AZURE_CLIENT_SECRET: "private-secret", CONTAINER_APP_NAME: "host",
    }, "certificate")).toThrow("AZURE_CLIENT_CERTIFICATE_PATH");
    expect(credentials.default).not.toHaveBeenCalled();
    expect(credentials.managed).not.toHaveBeenCalled();
  });
  it("shuts down initialized providers when live Graph startup fails", async () => {
    const service = parseServiceConfig({ ...raw, mode: "live", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }] });
    await expect(serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, {})).rejects.toThrow("AZURE_CLIENT_ID");
  });
  it("does not echo supplied values in configuration errors", () => {
    expect(() => createLiveGraphClient({ AZURE_TENANT_ID: "private-value", AZURE_CLIENT_ID: "private-value", AZURE_CLIENT_CERTIFICATE_PATH: " " }, "certificate"))
      .toThrow("AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_CERTIFICATE_PATH");
  });
  it("uses separate app-certificate clients for Teams Bot Connector and Graph observation", async () => {
    const service = parseServiceConfig({
      ...raw, type: "teams", mode: "live", graphAuthentication: "certificate", cohort: "teams-global",
      targets: [{
        id: "teams-001", tenantId: certificate.AZURE_TENANT_ID,
        teamId: "33333333-3333-4333-8333-333333333333",
        channelId: "approved-channel", serviceUrl: "https://smba.trafficmanager.net/teams/",
      }],
    });
    const runtime = await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, {
      ...certificate,
      BOT_TENANT_ID: certificate.AZURE_TENANT_ID,
      BOT_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
      BOT_CLIENT_CERTIFICATE_PATH: "bot-certificate.pem",
    });
    try {
      expect(runtime.graph).toBeInstanceOf(GraphClient);
      expect(runtime.teamsBot).toBeInstanceOf(TeamsBotClient);
      expect(credentials.certificate).toHaveBeenCalledTimes(2);
      expect(credentials.default).not.toHaveBeenCalled();
    } finally {
      await runtime.results.shutdown();
    }
  });
  it("rejects missing bot credentials and mismatched tenants without acquiring tokens", () => {
    const config = serviceSettings(parseServiceConfig({ ...raw, type: "teams" }), {});
    expect(() => createLiveTeamsBot(config, certificate)).toThrow("BOT_TENANT_ID");
    expect(() => createLiveTeamsBot(config, {
      ...certificate,
      BOT_TENANT_ID: "33333333-3333-4333-8333-333333333333",
      BOT_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
      BOT_CLIENT_CERTIFICATE_PATH: "bot-certificate.pem",
    })).toThrow("same approved tenant");
    expect(credentials.certificate).not.toHaveBeenCalled();
  });
  it("defaults to only the explicitly selected user-assigned Graph managed identity", async () => {
    const service = parseServiceConfig({ ...raw, mode: "live", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }] });
    const runtime = await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, {
      AZURE_CLIENT_ID: certificate.AZURE_CLIENT_ID, AZURE_CLIENT_SECRET: "must-not-use",
    });
    try {
      expect(runtime.graph).toBeInstanceOf(GraphClient);
      expect(credentials.managed).toHaveBeenCalledExactlyOnceWith({ clientId: certificate.AZURE_CLIENT_ID });
      expect(credentials.certificate).not.toHaveBeenCalled();
      expect(credentials.default).not.toHaveBeenCalled();
      await runtime.graph?.authenticate(new AbortController().signal);
      expect(credentials.token).toHaveBeenCalledWith("https://graph.microsoft.com/.default", { abortSignal: expect.any(AbortSignal) });
    } finally { await runtime.results.shutdown(); }
  });
  it.each([undefined, "", "private-value"])("rejects absent/invalid MI client ID %s without credential fallback", value => {
    expect(() => createLiveGraphClient(value === undefined ? {} : { AZURE_CLIENT_ID: value })).toThrow("AZURE_CLIENT_ID");
    expect(credentials.managed).not.toHaveBeenCalled();
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(credentials.default).not.toHaveBeenCalled();
  });
  it("does not fall back when the explicitly selected managed identity cannot acquire a Graph token", async () => {
    credentials.token.mockRejectedValueOnce(new Error("private identity details"));
    const graph = createLiveGraphClient(certificate);
    await expect(graph.authenticate(new AbortController().signal)).rejects.toMatchObject({ category: "authentication-failure" });
    expect(credentials.managed).toHaveBeenCalledExactlyOnceWith({ clientId: certificate.AZURE_CLIENT_ID });
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(credentials.default).not.toHaveBeenCalled();
  });
  it("rejects unrecognized authentication modes rather than falling back", () => {
    expect(() => createLiveGraphClient(certificate, "unsupported" as never)).toThrow("graphAuthentication");
    expect(credentials.managed).not.toHaveBeenCalled();
    expect(credentials.certificate).not.toHaveBeenCalled();
  });
  it("keeps Teams MI Graph observation separate from certificate Bot Connector authentication", async () => {
    const service = parseServiceConfig({
      ...raw, type: "teams", mode: "live",
      targets: [{
        id: "teams-001", tenantId: certificate.AZURE_TENANT_ID,
        teamId: "33333333-3333-4333-8333-333333333333",
        channelId: "approved-channel", serviceUrl: "https://smba.trafficmanager.net/teams/",
      }],
    });
    const runtime = await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, {
      AZURE_TENANT_ID: certificate.AZURE_TENANT_ID, AZURE_CLIENT_ID: certificate.AZURE_CLIENT_ID,
      BOT_TENANT_ID: certificate.AZURE_TENANT_ID,
      BOT_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
      BOT_CLIENT_CERTIFICATE_PATH: "bot.pem",
    });
    try {
      expect(credentials.managed).toHaveBeenCalledExactlyOnceWith({ clientId: certificate.AZURE_CLIENT_ID });
      expect(credentials.certificate).toHaveBeenCalledExactlyOnceWith(
        certificate.AZURE_TENANT_ID, "44444444-4444-4444-8444-444444444444", "bot.pem",
      );
    } finally { await runtime.results.shutdown(); }
    expect(() => createLiveTeamsBot(serviceSettings(service, { ENABLE_LIVE_M365: "true" }), {
      BOT_TENANT_ID: certificate.AZURE_TENANT_ID,
      BOT_CLIENT_ID: certificate.AZURE_CLIENT_ID, BOT_CLIENT_CERTIFICATE_PATH: "bot.pem",
    })).toThrow("AZURE_TENANT_ID");
  });
});
