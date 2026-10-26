import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphClient } from "../src/graph.js";
import { createLiveGraphClient, createLiveTeamsBot, createTeamsReadbackGraph } from "../src/auth.js";
import { createHealthReporter } from "../src/health-reports.js";
import { readProjectConfig } from "../src/project-config.js";
import { providerGraphClient, serviceRuntime } from "../src/runtime.js";
import { TeamsBotClient } from "../src/teams.js";
import { TeamsUserClient } from "../src/teams-user.js";
import { parseServiceConfig, serviceSettings } from "../src/service-config.js";

const credentials = vi.hoisted(() => ({
  certificate: vi.fn(), managed: vi.fn(), default: vi.fn(), assertion: vi.fn(),
  token: vi.fn(async (_scope?: string | string[], _options?: unknown) => ({ token: "test-token", expiresOnTimestamp: Date.now() + 60000 })),
}));
const calling = vi.hoisted(() => {
  const shutdown = vi.fn(async () => undefined);
  return { verify: vi.fn(async () => undefined), shutdown, start: vi.fn(async () => ({ shutdown, port: 8080 })) };
});
vi.mock("../src/teams-calling-auth.js", () => ({ createTeamsCallingVerifier: async () => calling.verify }));
vi.mock("../src/teams-calling-callback.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/teams-calling-callback.js")>(), startTeamsCallingCallback: calling.start,
}));
vi.mock("@azure/identity", () => ({
  ClientAssertionCredential: vi.fn(function (...args) { credentials.assertion(...args); return { getToken: credentials.token }; }),
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
  M365_TENANT_ID: "55555555-5555-4555-8555-555555555555",
  M365_CLIENT_ID: "66666666-6666-4666-8666-666666666666",
  M365_CLIENT_CERTIFICATE_PATH: "graph-certificate.pem",
  AZURE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
  AZURE_CLIENT_CERTIFICATE_PATH: "certificate.pem",
};
const project = await readProjectConfig("../monitoring.config.json");

describe("independent Graph and health-report identities", () => {
  it("rejects a substituted call recipient before credentials, discovery, listener or Graph I/O", async () => {
    const service = parseServiceConfig({
      ...raw, type: "teams", targets: [], callTargets: [{
        id: "approved-call", tenantId: certificate.AZURE_TENANT_ID, callUserId: certificate.M365_CLIENT_ID,
      }],
    });
    const config = serviceSettings(service, {}, { "call-test-user": true });
    config.probes[0]!.callUserId = certificate.AZURE_CLIENT_ID;
    await expect(serviceRuntime(service, config, output, {})).rejects.toThrow("root-configured individual users");
    expect(credentials.managed).not.toHaveBeenCalled();
    expect(credentials.token).not.toHaveBeenCalled();
    expect(calling.start).not.toHaveBeenCalled();
  });
  it("uses only BOT identity for call-only Graph access and closes its authenticated callback on shutdown", async () => {
    const service = parseServiceConfig({
      ...raw, type: "teams", mode: "live", teamsAuthentication: "user-delegated",
      graphAuthentication: "certificate", teamsCallingCallbackUrl: "https://approved.example.invalid/api/calls",
      targets: [],
      callTargets: [{
        id: "call-only", tenantId: certificate.AZURE_TENANT_ID,
        callUserId: certificate.M365_CLIENT_ID,
      }],
    });
    const config = serviceSettings(service, { ENABLE_LIVE_M365: "true" }, {
      "publish-channel-message": false, "reply-channel-message": false, "call-test-user": true,
    });
    const env = {
      AZURE_TENANT_ID: certificate.AZURE_TENANT_ID, AZURE_CLIENT_ID: certificate.AZURE_CLIENT_ID,
      BOT_TENANT_ID: certificate.AZURE_TENANT_ID, BOT_CLIENT_ID: certificate.M365_CLIENT_ID,
    };
    const runtime = await serviceRuntime(service, config, output, env);
    expect(runtime.graph).toBeUndefined();
    expect(runtime.teamsBot).toBeUndefined();
    expect(runtime.clientsForProbe).toBeUndefined();
    await runtime.teamsCalling!.authenticate(new AbortController().signal);
    expect(credentials.managed).toHaveBeenCalledExactlyOnceWith({ clientId: env.BOT_CLIENT_ID });
    expect(credentials.token).toHaveBeenCalledWith("00000003-0000-0000-c000-000000000000/.default", expect.anything());
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(calling.start).toHaveBeenCalledWith(expect.objectContaining({ port: 8080, verify: calling.verify }));
    await runtime.shutdown!();
    expect(calling.shutdown).toHaveBeenCalledOnce();
  });
  function botService(overrides: Record<string, unknown> = {}) {
    return parseServiceConfig({
      ...raw, type: "teams", mode: "live",
      targets: [{
        id: "teams-bot-001", tenantId: certificate.AZURE_TENANT_ID,
        teamId: "33333333-3333-4333-8333-333333333333",
        channelId: "dedicated-channel", serviceUrl: "https://smba.trafficmanager.net/teams/",
      }], ...overrides,
    });
  }
  const botEnv = {
    AZURE_CLIENT_ID: certificate.AZURE_CLIENT_ID, AZURE_TENANT_ID: certificate.AZURE_TENANT_ID,
    BOT_CLIENT_ID: "44444444-4444-4444-8444-444444444444", BOT_TENANT_ID: certificate.AZURE_TENANT_ID,
  };
  it("keeps readback and provider federation on their distinct configured applications when both are enabled", async () => {
    const teamsReadbackClientId = "77777777-7777-4777-8777-777777777777";
    const providerClientId = "88888888-8888-4888-8888-888888888888";
    const service = botService({ serviceHealth: true, teamsReadbackClientId, providerClientId });
    const env = { ...botEnv, ENABLE_LIVE_M365: "true" };
    const provider = providerGraphClient(service, env)!;
    const runtime = await serviceRuntime(service, serviceSettings(service, env), output, env);
    expect(credentials.assertion.mock.calls.map(args => args.slice(0, 2))).toEqual([
      [botEnv.AZURE_TENANT_ID, providerClientId],
      [botEnv.AZURE_TENANT_ID, teamsReadbackClientId],
    ]);
    await Promise.all([
      provider.authenticate(new AbortController().signal),
      runtime.graph!.authenticate(new AbortController().signal),
    ]);
    expect(runtime.graph).not.toBe(provider);
    expect(runtime.teamsBot).toBeInstanceOf(TeamsBotClient);
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(credentials.default).not.toHaveBeenCalled();
  });
  it("federates provider access without changing synthetic Graph or Bot Connector identities", async () => {
    const providerClientId = "88888888-8888-4888-8888-888888888888";
    const service = botService({ serviceHealth: true, providerClientId });
    const graph = providerGraphClient(service, { ...botEnv, ENABLE_LIVE_M365: "true" });
    expect(graph).toBeInstanceOf(GraphClient);
    expect(credentials.assertion).toHaveBeenCalledExactlyOnceWith(
      botEnv.AZURE_TENANT_ID, providerClientId, expect.any(Function),
    );
    const assertion = credentials.assertion.mock.calls[0]![2] as () => Promise<string>;
    await expect(assertion()).resolves.toBe("test-token");
    expect(credentials.token).toHaveBeenCalledWith("api://AzureADTokenExchange/.default");
    const runtime = await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, botEnv);
    expect(runtime.teamsBot).toBeInstanceOf(TeamsBotClient);
    expect(credentials.assertion).toHaveBeenCalledOnce();
    expect(credentials.managed.mock.calls).toEqual([
      [{ clientId: botEnv.AZURE_CLIENT_ID }], [{ clientId: botEnv.AZURE_CLIENT_ID }], [{ clientId: botEnv.BOT_CLIENT_ID }],
    ]);
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(credentials.default).not.toHaveBeenCalled();
  });
  it.each([
    { mode: "simulation", serviceHealth: true },
    { mode: "live", serviceHealth: false },
    { mode: "live", serviceHealth: true, enabled: false },
  ])("does not initialize optional provider federation without enabled live collection", overrides => {
    const service = botService({ providerClientId: certificate.M365_CLIENT_ID, ...overrides });
    expect(providerGraphClient(service, {})).toBeUndefined();
    expect(credentials.managed).not.toHaveBeenCalled();
    expect(credentials.assertion).not.toHaveBeenCalled();
  });
  it("rejects certificate/provider federation conflicts and malformed application IDs", () => {
    expect(() => botService({ providerClientId: certificate.M365_CLIENT_ID, graphAuthentication: "certificate" }))
      .toThrow("providerClientId requires managed-identity");
    expect(() => botService({ providerClientId: "not-a-uuid" })).toThrow("providerClientId");
  });
  it("fails provider federation explicitly without host identity/tenant or live approval", () => {
    const service = botService({ serviceHealth: true, providerClientId: certificate.M365_CLIENT_ID });
    for (const env of [{}, { ...botEnv, AZURE_TENANT_ID: "" }, { ...botEnv, AZURE_CLIENT_ID: "" }]) {
      expect(() => providerGraphClient(service, { ...env, ENABLE_LIVE_M365: "true" })).toThrow();
    }
    expect(() => providerGraphClient(service, botEnv)).toThrow("ENABLE_LIVE_M365");
    expect(credentials.token).not.toHaveBeenCalled();
    expect(credentials.assertion).not.toHaveBeenCalled();
  });
  it("uses explicit readback app federation without changing the Bot Connector identity or provider identity", async () => {
    const readbackId = "77777777-7777-4777-8777-777777777777";
    const service = botService({ teamsReadbackClientId: readbackId, serviceHealth: true });
    const runtime = await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, botEnv);
    expect(credentials.assertion).toHaveBeenCalledExactlyOnceWith(botEnv.BOT_TENANT_ID, readbackId, expect.any(Function));
    const assertion = credentials.assertion.mock.calls[0]![2] as () => Promise<string>;
    await expect(assertion()).resolves.toBe("test-token");
    expect(credentials.token).toHaveBeenCalledWith("api://AzureADTokenExchange/.default");
    expect(credentials.managed.mock.calls).toEqual([
      [{ clientId: botEnv.AZURE_CLIENT_ID }], [{ clientId: botEnv.BOT_CLIENT_ID }],
    ]);
    expect(runtime.teamsBot).toBeInstanceOf(TeamsBotClient);
    providerGraphClient(service, { ...botEnv, ENABLE_LIVE_M365: "true" });
    expect(credentials.assertion).toHaveBeenCalledOnce();
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(credentials.default).not.toHaveBeenCalled();
  });
  it("does not fall back if the federation assertion cannot be obtained", async () => {
    createTeamsReadbackGraph(botEnv, certificate.M365_CLIENT_ID);
    const assertion = credentials.assertion.mock.calls[0]![2] as () => Promise<string>;
    credentials.token.mockRejectedValueOnce(new Error("Managed identity unavailable"));
    await expect(assertion()).rejects.toThrow("Managed identity unavailable");
    expect(credentials.default).not.toHaveBeenCalled();
    expect(credentials.certificate).not.toHaveBeenCalled();
  });
  it.each([
    { ...botEnv, BOT_TENANT_ID: certificate.M365_TENANT_ID },
    { ...botEnv, AZURE_CLIENT_ID: "" },
    { ...botEnv, AZURE_TENANT_ID: "" },
  ])("rejects invalid federation identity settings before tokens are requested", env => {
    expect(() => createTeamsReadbackGraph(env, certificate.M365_CLIENT_ID)).toThrow();
    expect(credentials.token).not.toHaveBeenCalled();
    expect(credentials.assertion).not.toHaveBeenCalled();
  });
  it.each([
    { type: "exchange" }, { teamsAuthentication: "user-delegated" }, { graphAuthentication: "certificate" },
  ])("rejects readback federation configured for an incompatible authentication mode", overrides => {
    expect(() => botService({ teamsReadbackClientId: certificate.M365_CLIENT_ID, ...overrides })).toThrow();
  });
  it("defaults to a separately selected Bot Connector MI and audience without user/cache/certificate settings", async () => {
    const service = botService();
    expect(service).toMatchObject({ teamsAuthentication: "bot", botAuthentication: "managed-identity" });
    const runtime = await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, {
      ...botEnv, BOT_CLIENT_CERTIFICATE_PATH: "", BOT_CLIENT_SECRET: "never-use",
    });
    expect(runtime.teamsBot).toBeInstanceOf(TeamsBotClient);
    expect(runtime.clientsForProbe).toBeUndefined();
    expect(credentials.managed.mock.calls).toEqual([
      [{ clientId: botEnv.AZURE_CLIENT_ID }], [{ clientId: botEnv.BOT_CLIENT_ID }],
    ]);
    await runtime.graph!.authenticate(new AbortController().signal);
    await runtime.teamsBot!.authenticate(new AbortController().signal);
    expect(credentials.token.mock.calls.map(([scope]) => scope)).toEqual([
      "https://graph.microsoft.com/.default", "https://api.botframework.com/.default",
    ]);
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(credentials.default).not.toHaveBeenCalled();
  });
  it("keeps bot MI separate when its same-tenant application Graph observer explicitly uses a certificate", async () => {
    const service = botService({ graphAuthentication: "certificate" });
    const runtime = await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, {
      ...certificate, ...botEnv, M365_TENANT_ID: botEnv.BOT_TENANT_ID,
    });
    expect(credentials.managed).toHaveBeenCalledExactlyOnceWith({ clientId: botEnv.BOT_CLIENT_ID });
    expect(credentials.certificate).toHaveBeenCalledExactlyOnceWith(
      botEnv.BOT_TENANT_ID, certificate.M365_CLIENT_ID, certificate.M365_CLIENT_CERTIFICATE_PATH,
    );
    expect(runtime.teamsBot).toBeInstanceOf(TeamsBotClient);
  });
  it.each(["BOT_CLIENT_ID", "BOT_TENANT_ID", "AZURE_TENANT_ID"])(
    "rejects missing/malformed bot MI %s without using available certificates or Azure-client fallback", field => {
      const config = serviceSettings(botService(), { ENABLE_LIVE_M365: "true" });
      for (const value of [undefined, "", "private-invalid-value"]) {
        const env: NodeJS.ProcessEnv = { ...certificate, ...botEnv, M365_TENANT_ID: botEnv.BOT_TENANT_ID, BOT_CLIENT_CERTIFICATE_PATH: "unused.pem" };
        if (value === undefined) delete env[field]; else env[field] = value;
        expect(() => createLiveTeamsBot(config, env)).toThrow(field);
      }
      expect(credentials.managed).not.toHaveBeenCalled();
      expect(credentials.certificate).not.toHaveBeenCalled();
      expect(credentials.default).not.toHaveBeenCalled();
      expect(credentials.token).not.toHaveBeenCalled();
    },
  );
  it("rejects a bot MI outside the Azure host tenant even when Graph and bot metadata agree", () => {
    const service = botService();
    const config = serviceSettings(service, { ENABLE_LIVE_M365: "true" });
    expect(() => createLiveTeamsBot(config, {
      ...botEnv, M365_TENANT_ID: botEnv.BOT_TENANT_ID, AZURE_TENANT_ID: certificate.M365_TENANT_ID,
    })).toThrow("same approved bot tenant");
    expect(credentials.managed).not.toHaveBeenCalled();
  });
  it("does not fall back after bot MI token failure or an unsupported bot authentication mode", async () => {
    const config = serviceSettings(botService(), { ENABLE_LIVE_M365: "true" });
    const bot = createLiveTeamsBot(config, botEnv);
    credentials.token.mockRejectedValueOnce(new Error("private identity detail"));
    await expect(bot.authenticate(new AbortController().signal)).rejects.toMatchObject({ category: "authentication-failure" });
    expect(() => createLiveTeamsBot({ ...config, BOT_AUTHENTICATION: "fallback" as never }, botEnv))
      .toThrow("BOT_AUTHENTICATION");
    expect(credentials.managed).toHaveBeenCalledExactlyOnceWith({ clientId: botEnv.BOT_CLIENT_ID });
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(credentials.default).not.toHaveBeenCalled();
  });
  it("requires explicit bot certificate mode and path, never switching to MI for missing certificate settings", () => {
    const config = serviceSettings(botService({ botAuthentication: "certificate" }), { ENABLE_LIVE_M365: "true" });
    expect(() => createLiveTeamsBot(config, botEnv)).toThrow("BOT_CLIENT_CERTIFICATE_PATH");
    expect(credentials.managed).not.toHaveBeenCalled();
    expect(credentials.certificate).not.toHaveBeenCalled();
  });
  it("keeps default bot simulation completely credential-free and preserves both retention selections", async () => {
    const service = botService({ mode: "simulation", teamsCleanupEnabled: false, exchangeCleanupEnabled: false });
    const config = serviceSettings(service, { BOT_AUTHENTICATION: "certificate" });
    expect(config).toMatchObject({ BOT_AUTHENTICATION: "managed-identity", TEAMS_CLEANUP_ENABLED: "false", EXCHANGE_CLEANUP_ENABLED: "false" });
    const runtime = await serviceRuntime(service, config, output, {});
    expect(Object.keys(runtime).sort()).toEqual(["results", "telemetry"]);
    for (const credential of Object.values(credentials)) expect(credential).not.toHaveBeenCalled();
  });
  it("never reuses the delegated user client for application providers or ARM reports", async () => {
    const service = parseServiceConfig({
      ...raw, type: "teams", mode: "live", teamsAuthentication: "user-delegated", serviceHealth: true,
      targets: [{
        id: "teams-001", tenantId: certificate.AZURE_TENANT_ID, userPrincipalName: "test@example.invalid",
        teamId: "33333333-3333-4333-8333-333333333333", channelId: "standard-channel",
      }],
    });
    const env = {
      ...certificate, ENABLE_LIVE_M365: "true",
      TEAMS_PUBLIC_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
      TEAMS_CACHE_ACCOUNT_URL: "https://approvedcache.blob.core.windows.net",
    };
    const runtime = await serviceRuntime(service, serviceSettings(service, env), output, env);
    const selected = runtime.clientsForProbe!(serviceSettings(service, env).probes[0]!);
    expect(selected.teamsBot).toBeInstanceOf(TeamsUserClient);
    expect(runtime.graph).toBeUndefined();
    expect(runtime.teamsBot).toBeUndefined();
    const provider = providerGraphClient(service, env)!;
    expect(provider).not.toBe(selected.graph);
    await provider.authenticate(new AbortController().signal);
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await createHealthReporter(project, service, output, env, { fetch: fetcher })({ cycleId: "delegated", results: [] });
    expect(credentials.managed).toHaveBeenCalledTimes(3);
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(credentials.default).not.toHaveBeenCalled();
    expect(credentials.token).toHaveBeenCalledWith("https://graph.microsoft.com/.default", expect.anything());
    expect(credentials.token).toHaveBeenCalledWith("https://management.azure.com/.default", expect.anything());
  });
  it("publishes ARM reports with Azure MI while Graph observes a different tenant with its certificate", async () => {
    const service = parseServiceConfig({
      ...raw, mode: "live", graphAuthentication: "certificate",
      targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }],
    });
    const runtime = await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, certificate);
    await runtime.graph!.authenticate(new AbortController().signal);
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await createHealthReporter(project, service, output, certificate, { fetch: fetcher })({
      cycleId: "cross-tenant", results: [],
    });
    expect(credentials.certificate).toHaveBeenCalledExactlyOnceWith(
      certificate.M365_TENANT_ID, certificate.M365_CLIENT_ID, certificate.M365_CLIENT_CERTIFICATE_PATH,
    );
    expect(credentials.managed).toHaveBeenCalledExactlyOnceWith({ clientId: certificate.AZURE_CLIENT_ID });
    expect(credentials.token).toHaveBeenCalledWith("https://graph.microsoft.com/.default", expect.anything());
    expect(credentials.token).toHaveBeenCalledWith("https://management.azure.com/.default", expect.anything());
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(credentials.default).not.toHaveBeenCalled();
  });
  it.each(["managed-identity", "certificate"] as const)(
    "uses only explicitly selected Azure report certificates independently of Graph %s", async graphAuthentication => {
      const service = parseServiceConfig({ ...raw, mode: "live", graphAuthentication, healthReportAuthentication: "certificate" });
      await createHealthReporter(project, service, output, {
        AZURE_TENANT_ID: certificate.AZURE_TENANT_ID, AZURE_CLIENT_ID: certificate.AZURE_CLIENT_ID,
        AZURE_CLIENT_CERTIFICATE_PATH: certificate.AZURE_CLIENT_CERTIFICATE_PATH,
      }, {
        fetch: async () => new Response(null, { status: 204 }),
      })({ cycleId: "local", results: [] });
      expect(credentials.certificate).toHaveBeenCalledExactlyOnceWith(
        certificate.AZURE_TENANT_ID, certificate.AZURE_CLIENT_ID, certificate.AZURE_CLIENT_CERTIFICATE_PATH,
      );
      expect(credentials.managed).not.toHaveBeenCalled();
      expect(credentials.token).toHaveBeenCalledWith("https://management.azure.com/.default", expect.anything());
    },
  );
  it.each(["M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_CERTIFICATE_PATH"])(
    "rejects missing %s despite complete Azure certificate credentials", field => {
      const env: NodeJS.ProcessEnv = { ...certificate };
      delete env[field];
      expect(() => createLiveGraphClient(env, "certificate")).toThrow(field);
      const service = parseServiceConfig({ ...raw, mode: "live", serviceHealth: true, graphAuthentication: "certificate" });
      expect(() => providerGraphClient(service, { ...env, ENABLE_LIVE_M365: "true" })).toThrow(field);
      expect(credentials.certificate).not.toHaveBeenCalled();
      expect(credentials.managed).not.toHaveBeenCalled();
    },
  );
  it("never reuses Graph certificates for ARM or falls back from missing report certificate fields", () => {
    const service = parseServiceConfig({ ...raw, mode: "live", graphAuthentication: "certificate" });
    const graphOnly = {
      M365_TENANT_ID: certificate.M365_TENANT_ID, M365_CLIENT_ID: certificate.M365_CLIENT_ID,
      M365_CLIENT_CERTIFICATE_PATH: certificate.M365_CLIENT_CERTIFICATE_PATH,
    };
    expect(() => createHealthReporter(project, service, output, graphOnly)).toThrow("AZURE_CLIENT_ID");
    expect(() => createHealthReporter(project, { ...service, healthReportAuthentication: "certificate" }, output, {
      ...graphOnly, AZURE_CLIENT_ID: certificate.AZURE_CLIENT_ID, AZURE_CLIENT_SECRET: "private-secret",
    })).toThrow("AZURE_TENANT_ID, AZURE_CLIENT_CERTIFICATE_PATH");
    for (const credential of Object.values(credentials)) expect(credential).not.toHaveBeenCalled();
  });
  it.each(["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_CERTIFICATE_PATH"])(
    "rejects missing report %s despite complete M365 certificate settings", field => {
      const env: NodeJS.ProcessEnv = { ...certificate };
      delete env[field];
      const service = parseServiceConfig({ ...raw, mode: "live", healthReportAuthentication: "certificate" });
      expect(() => createHealthReporter(project, service, output, env)).toThrow(field);
      for (const credential of Object.values(credentials)) expect(credential).not.toHaveBeenCalled();
    },
  );
  it.each([
    { mode: "simulation", enabled: true }, { mode: "live", enabled: false },
  ] as const)("requires no credentials for $mode enabled=$enabled", async settings => {
    const service = parseServiceConfig({
      ...raw, ...settings, graphAuthentication: "certificate", healthReportAuthentication: "certificate", serviceHealth: true,
    });
    expect(providerGraphClient(service, {})).toBeUndefined();
    const telemetry = { emit: vi.fn() };
    await createHealthReporter(project, service, telemetry, {})({ cycleId: "inactive", results: [] });
    if (!settings.enabled) expect(telemetry.emit).not.toHaveBeenCalled();
    for (const credential of Object.values(credentials)) expect(credential).not.toHaveBeenCalled();
  });
});

describe("stateless service runtime", () => {
  it("creates a provider-only Graph client with the selected MI despite missing Teams journey/bot settings", () => {
    const service = parseServiceConfig({
      ...raw, type: "teams", mode: "live", serviceHealth: true,
      targets: [{ id: "teams-001", tenantId: certificate.AZURE_TENANT_ID, userPrincipalName: "test@example.invalid" }],
    });
    const graph = providerGraphClient(service, { ENABLE_LIVE_M365: "true", AZURE_CLIENT_ID: certificate.AZURE_CLIENT_ID });
    expect(graph).toBeInstanceOf(GraphClient);
    expect(credentials.managed).toHaveBeenCalledExactlyOnceWith({ clientId: certificate.AZURE_CLIENT_ID });
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(credentials.token).not.toHaveBeenCalled();
  });
  it.each([{ serviceHealth: true }, { serviceActivity: { enabled: true } }])(
    "uses the explicitly selected certificate for enabled providers without fallback: %o", settings => {
      const service = parseServiceConfig({ ...raw, mode: "live", ...settings, graphAuthentication: "certificate" });
      expect(providerGraphClient(service, {
        ...certificate, ENABLE_LIVE_M365: "true", ENABLE_BETA_SERVICE_ACTIVITY: "true",
      })).toBeInstanceOf(GraphClient);
      expect(credentials.certificate).toHaveBeenCalledExactlyOnceWith(
        certificate.M365_TENANT_ID, certificate.M365_CLIENT_ID, certificate.M365_CLIENT_CERTIFICATE_PATH,
      );
      expect(credentials.managed).not.toHaveBeenCalled();
      expect(credentials.default).not.toHaveBeenCalled();
    },
  );
  it("never constructs provider credentials for simulation, disabled sources, or unacknowledged live collection", () => {
    expect(providerGraphClient(parseServiceConfig({ ...raw, serviceHealth: true }), {})).toBeUndefined();
    expect(providerGraphClient(parseServiceConfig({ ...raw, mode: "live" }), certificate)).toBeUndefined();
    expect(() => providerGraphClient(parseServiceConfig({ ...raw, mode: "live", serviceHealth: true }), certificate))
      .toThrow("ENABLE_LIVE_M365");
    for (const credential of Object.values(credentials)) expect(credential).not.toHaveBeenCalled();
  });
  it("does not output a successful result when probe initialization fails", async () => {
    const service = parseServiceConfig({
      ...raw, mode: "live", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }],
    });
    const results = {
      record: vi.fn(), recordDiagnostic: vi.fn(),
    };
    await expect(serviceRuntime(
      service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, {}, results,
    )).rejects.toThrow("AZURE_CLIENT_ID");
    expect(results.record).not.toHaveBeenCalled();
  });

  it("does not construct Azure credentials, Graph, ARM clients or state for console simulation", async () => {
    const service = parseServiceConfig(raw);
    const runtime = await serviceRuntime(service, serviceSettings(service, {}), output, {});
    expect(Object.keys(runtime).sort()).toEqual(["results", "telemetry"]);
    for (const credential of Object.values(credentials)) expect(credential).not.toHaveBeenCalled();
  });
  it("uses app-certificate Graph identity, not ARM/Blob identity, for live probes", async () => {
    const service = parseServiceConfig({ ...raw, mode: "live", graphAuthentication: "certificate", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }] });
    const runtime = await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, certificate);
    expect(runtime.graph).toBeInstanceOf(GraphClient);
    expect(credentials.certificate).toHaveBeenCalledOnce();
    expect(credentials.managed).not.toHaveBeenCalled();
    expect(credentials.default).not.toHaveBeenCalled();
  });
  it("does not use a developer's CLI credentials, client secret, or host identity as a Graph fallback", () => {
    expect(() => createLiveGraphClient({}, "certificate")).toThrow("app-only certificate");
    expect(() => createLiveGraphClient({
      ...certificate, M365_CLIENT_CERTIFICATE_PATH: "", AZURE_CLIENT_SECRET: "private-secret", CONTAINER_APP_NAME: "host",
    }, "certificate")).toThrow("M365_CLIENT_CERTIFICATE_PATH");
    expect(credentials.default).not.toHaveBeenCalled();
    expect(credentials.managed).not.toHaveBeenCalled();
  });
  it("rejects live Graph startup without the explicitly selected identity", async () => {
    const service = parseServiceConfig({ ...raw, mode: "live", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }] });
    await expect(serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, {})).rejects.toThrow("AZURE_CLIENT_ID");
  });
  it("does not echo supplied values in configuration errors", () => {
    expect(() => createLiveGraphClient({ M365_TENANT_ID: "private-value", M365_CLIENT_ID: "private-value", M365_CLIENT_CERTIFICATE_PATH: " " }, "certificate"))
      .toThrow("M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_CERTIFICATE_PATH");
  });
  it("uses separate app-certificate clients for Teams Bot Connector and Graph observation", async () => {
    const service = parseServiceConfig({
      ...raw, type: "teams", mode: "live", teamsAuthentication: "bot", botAuthentication: "certificate", graphAuthentication: "certificate", cohort: "teams-global",
      targets: [{
        id: "teams-001", tenantId: certificate.M365_TENANT_ID,
        teamId: "33333333-3333-4333-8333-333333333333",
        channelId: "approved-channel", serviceUrl: "https://smba.trafficmanager.net/teams/",
      }],
    });
    const runtime = await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, {
      ...certificate,
      BOT_TENANT_ID: certificate.M365_TENANT_ID,
      BOT_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
      BOT_CLIENT_CERTIFICATE_PATH: "bot-certificate.pem",
    });
    expect(runtime.graph).toBeInstanceOf(GraphClient);
    expect(runtime.teamsBot).toBeInstanceOf(TeamsBotClient);
    expect(credentials.certificate).toHaveBeenCalledTimes(2);
    expect(credentials.certificate).toHaveBeenNthCalledWith(
      1, certificate.M365_TENANT_ID, certificate.M365_CLIENT_ID, certificate.M365_CLIENT_CERTIFICATE_PATH,
    );
    expect(credentials.certificate).toHaveBeenNthCalledWith(
      2, certificate.M365_TENANT_ID, "44444444-4444-4444-8444-444444444444", "bot-certificate.pem",
    );
    expect(credentials.default).not.toHaveBeenCalled();
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
    expect(runtime.graph).toBeInstanceOf(GraphClient);
    expect(credentials.managed).toHaveBeenCalledExactlyOnceWith({ clientId: certificate.AZURE_CLIENT_ID });
    expect(credentials.certificate).not.toHaveBeenCalled();
    expect(credentials.default).not.toHaveBeenCalled();
    await runtime.graph?.authenticate(new AbortController().signal);
    expect(credentials.token).toHaveBeenCalledWith("https://graph.microsoft.com/.default", { abortSignal: expect.any(AbortSignal) });
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
      ...raw, type: "teams", mode: "live", teamsAuthentication: "bot", botAuthentication: "certificate",
      targets: [{
        id: "teams-001", tenantId: certificate.AZURE_TENANT_ID,
        teamId: "33333333-3333-4333-8333-333333333333",
        channelId: "approved-channel", serviceUrl: "https://smba.trafficmanager.net/teams/",
      }],
    });
    await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, {
      AZURE_TENANT_ID: certificate.AZURE_TENANT_ID, AZURE_CLIENT_ID: certificate.AZURE_CLIENT_ID,
      BOT_TENANT_ID: certificate.AZURE_TENANT_ID,
      BOT_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
      BOT_CLIENT_CERTIFICATE_PATH: "bot.pem",
    });
    expect(credentials.managed).toHaveBeenCalledExactlyOnceWith({ clientId: certificate.AZURE_CLIENT_ID });
    expect(credentials.certificate).toHaveBeenCalledExactlyOnceWith(
      certificate.AZURE_TENANT_ID, "44444444-4444-4444-8444-444444444444", "bot.pem",
    );
    expect(() => createLiveTeamsBot(serviceSettings(service, { ENABLE_LIVE_M365: "true" }), {
      BOT_TENANT_ID: certificate.AZURE_TENANT_ID,
      BOT_CLIENT_ID: certificate.AZURE_CLIENT_ID, BOT_CLIENT_CERTIFICATE_PATH: "bot.pem",
    })).toThrow("AZURE_TENANT_ID");
  });
  it.each(["certificate", "managed-identity"] as const)(
    "checks every Teams target against the selected M365 observer tenant with %s", authentication => {
      const env = {
        ...certificate, BOT_TENANT_ID: certificate.M365_TENANT_ID,
        BOT_CLIENT_ID: "44444444-4444-4444-8444-444444444444", BOT_CLIENT_CERTIFICATE_PATH: "bot.pem",
      };
      const service = parseServiceConfig({
        ...raw, type: "teams", botAuthentication: "certificate", targets: [
          { id: "teams-001", tenantId: certificate.M365_TENANT_ID },
          { id: "teams-002", tenantId: certificate.M365_TENANT_ID },
        ],
      });
      expect(createLiveTeamsBot(serviceSettings(service, {}), env, authentication)).toBeInstanceOf(TeamsBotClient);
      credentials.certificate.mockClear();
      const mismatch = parseServiceConfig({
        ...service, targets: [service.targets[0], { id: "teams-002", tenantId: certificate.AZURE_TENANT_ID }],
      });
      expect(() => createLiveTeamsBot(serviceSettings(mismatch, {}), env, authentication)).toThrow("same approved tenant");
      expect(() => createLiveTeamsBot(serviceSettings(service, {}), {
        ...env, BOT_TENANT_ID: certificate.AZURE_TENANT_ID,
      }, authentication)).toThrow("same approved tenant");
      expect(credentials.certificate).not.toHaveBeenCalled();
      expect(credentials.token).not.toHaveBeenCalled();
    },
  );
  it.each(["certificate", "managed-identity"] as const)(
    "does not substitute Azure host tenant for an invalid M365 observer tenant in %s mode", authentication => {
      const config = serviceSettings(parseServiceConfig({
        ...raw, type: "teams", targets: [{ id: "teams-001", tenantId: certificate.AZURE_TENANT_ID }],
      }), {});
      const env = {
        ...certificate, BOT_TENANT_ID: certificate.AZURE_TENANT_ID,
        BOT_CLIENT_ID: certificate.AZURE_CLIENT_ID, BOT_CLIENT_CERTIFICATE_PATH: "bot.pem",
        M365_TENANT_ID: "private-invalid-tenant",
      };
      expect(() => createLiveTeamsBot(config, env, authentication)).toThrow("M365_TENANT_ID");
      expect(() => createLiveTeamsBot(config, env, authentication)).not.toThrow("private-invalid-tenant");
      expect(credentials.certificate).not.toHaveBeenCalled();
    },
  );
  it("requires the M365 observer tenant in certificate mode even when Azure tenant is available", () => {
    const config = serviceSettings(parseServiceConfig({ ...raw, type: "teams" }), {});
    expect(() => createLiveTeamsBot(config, {
      AZURE_TENANT_ID: certificate.AZURE_TENANT_ID, BOT_TENANT_ID: certificate.AZURE_TENANT_ID,
      BOT_CLIENT_ID: certificate.AZURE_CLIENT_ID, BOT_CLIENT_CERTIFICATE_PATH: "bot.pem",
    }, "certificate")).toThrow("M365_TENANT_ID");
    expect(credentials.certificate).not.toHaveBeenCalled();
  });
});
