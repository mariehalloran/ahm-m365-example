import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyProjectConfig, parseProjectDocument, readProjectDocument, readProjectService, selectTenant, serviceExecution,
} from "../src/project-config.js";
import { parseServiceConfig, serviceProbes, serviceSettings } from "../src/service-config.js";
import { documentFixture, executionFixture, liveTenantEnv, multiTenantFixture, projectFixture, parseTestProjectConfig as parseProjectConfig } from "./fixtures.js";
import { runServiceWorker } from "../src/worker.js";
import { baseResult } from "../src/probes.js";
import { validateProjectTenantBinding } from "../src/runtime.js";

vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: vi.fn(function () {
    return { getToken: vi.fn(async () => ({ token: "mock-arm-token", expiresOnTimestamp: Date.now() + 60000 })) };
  }),
  ClientCertificateCredential: vi.fn(),
}));
afterEach(() => vi.unstubAllGlobals());

const checkedIn = projectFixture();
const service = parseServiceConfig({
  type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation",
  cohort: "exchange-global", targets: [{ id: "service-file-target" }],
});

describe("single root document", () => {
  it("accepts the checked-in monitoring.config.json as written and applies the schema defaults", async () => {
    const document = await readProjectDocument("../monitoring.config.json");
    const services = document.tenants[0]!.services;
    expect(services.exchange.execution).toMatchObject({
      maxConcurrentProbes: 3, cycleTimeoutSeconds: 170, graphAuthentication: "managed-identity",
      teamsAuthentication: "bot", botAuthentication: "managed-identity", exchangeCleanupEnabled: true,
    });
    expect(services.exchange.access).toEqual({});
    expect(services.teams.worker).toMatchObject({ cpu: 0.25, memory: "0.5Gi" });
    expect(document.deployment).toMatchObject({ stage: "workers", commandTimeoutSeconds: 1800, rolloutTimeoutSeconds: 300 });
    expect(document.otel).toEqual({ enabled: false, destination: "console" });
    expect(document.groups.map(group => [group.id, group.accounts, group.teams])).toEqual([
      ["centralus", ["test-user-1@example.invalid"], ["teams-probe-001", "teams-meeting-001"]],
      ["uksouth", ["test-user-2@example.invalid"], []],
    ]);
  });

  it("selects the only tenant without an alias and demands one when there are several", () => {
    const single = documentFixture();
    expect(selectTenant(single).tenant).toEqual({ id: "contoso", displayName: "Example tenant", tenantId: single.tenants[0]!.tenantId });
    expect(selectTenant(single, "contoso").services).toBe(single.tenants[0]!.services);
    expect(() => selectTenant(single, "missing")).toThrow("Unknown --tenant");
    const several = multiTenantFixture();
    expect(() => selectTenant(several)).toThrow("Select one tenant with --tenant");
    expect(selectTenant(several, "fabrikam").tenant.id).toBe("fabrikam");
    expect(() => selectTenant(several, "missing")).toThrow("Unknown --tenant");
  });

  it("marks a tenant's view multi-tenant exactly when the document has several tenants", () => {
    expect(selectTenant(documentFixture()).multiTenant).toBe(false);
    expect(projectFixture().multiTenant).toBe(false);
    const several = multiTenantFixture();
    expect(selectTenant(several, "contoso").multiTenant).toBe(true);
    expect(selectTenant(several, "fabrikam").multiTenant).toBe(true);
    several.tenants.pop();
    several.groups = [];
    expect(selectTenant(parseProjectDocument(several)).multiTenant).toBe(false);
  });

  it("gives each tenant a single-tenant view with only the groups that have members there", () => {
    const document = multiTenantFixture();
    const contoso = selectTenant(document, "contoso");
    const fabrikam = selectTenant(document, "fabrikam");
    expect(Object.keys(contoso).sort()).toEqual([
      "deployment", "groups", "healthModel", "multiTenant", "otel", "schemaVersion", "serviceHealth", "services", "tenant",
    ]);
    expect(contoso.groups).toEqual([
      { id: "priority", displayName: "Priority accounts", targetIds: { exchange: ["pair-a"], teams: ["contoso-channel"], onedrive: ["drive-a"] } },
      { id: "field", displayName: "Field accounts", targetIds: { exchange: ["pair-b"], teams: [], onedrive: ["drive-b"] } },
    ]);
    expect(fabrikam.groups.map(group => group.id)).toEqual(["priority", "bridge"]);
    expect(fabrikam.services.exchange.targets[0]!.mailbox).toBe("probe-a@fabrikam.example.invalid");
    expect(JSON.stringify(fabrikam.groups)).not.toContain("contoso");
  });

  it("reads one tenant's service from the root file, defaulting to the only tenant", async () => {
    const { project, service: exchange } = await readProjectService("exchange", "../monitoring.config.json");
    expect(project.tenant.id).toBe("contoso");
    expect(project.multiTenant).toBe(false);
    expect(project.groups.map(group => group.id)).toEqual(["centralus", "uksouth"]);
    expect(exchange).toMatchObject({ type: "exchange", enabled: true, mode: "simulation", cohort: "exchange-global" });
    expect(exchange.targets).toHaveLength(2);
    await expect(readProjectService("teams", "../monitoring.config.json", "missing")).rejects.toThrow("Unknown --tenant");
    await expect(readProjectService("exchange", "utils/tests/missing-project.json")).rejects.toThrow("Cannot read the project config");
  });

  it("explains how to migrate a schemaVersion 1.0 profile and rejects superseded shapes", () => {
    expect(() => parseProjectDocument({ ...documentFixture(), schemaVersion: "1.0" })).toThrow("Migrate monitoring.config.json from schemaVersion 1.0 to 2.0");
    const { tenants, ...rest } = documentFixture();
    expect(() => parseProjectDocument({ ...rest, services: tenants[0]!.services })).toThrow("Invalid project config fields");
    expect(() => parseProjectDocument({ ...rest, tenants: [] })).toThrow("tenants");
    const obsolete = documentFixture();
    Object.assign(obsolete.tenants[0]!.services.exchange, { configFile: "no-longer-supported.json" });
    expect(() => parseProjectDocument(obsolete)).toThrow("tenants.0.services.exchange");
  });

  it.each([
    ["duplicate alias", (document: ReturnType<typeof multiTenantFixture>) => { document.tenants[1]!.id = document.tenants[0]!.id; }],
    ["duplicate UUID", (document: ReturnType<typeof multiTenantFixture>) => { document.tenants[1]!.tenantId = document.tenants[0]!.tenantId; }],
    ["wrong Teams tenant", (document: ReturnType<typeof multiTenantFixture>) => { document.tenants[0]!.services.teams.targets[0]!.tenantId = document.tenants[1]!.tenantId; }],
  ])("rejects a tenant inventory with a %s", (_label, mutate) => {
    const document = multiTenantFixture();
    mutate(document);
    expect(() => parseProjectDocument(document)).toThrow();
  });

  it("validates every tenant's execution settings", () => {
    const document = multiTenantFixture();
    document.tenants[1]!.services.exchange.execution.executionLanes = [
      { name: "mail", intervalSeconds: 60, timeoutSeconds: 15, journeys: ["send-receive-mail"] },
    ];
    expect(() => parseProjectDocument(document)).toThrow("Execution lanes");
  });

  it("rejects mismatched live tenant bindings before credentials or dependencies are created", async () => {
    const project = selectTenant(multiTenantFixture(), "contoso");
    project.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
    const live = applyProjectConfig(project, { ...service, mode: "live" });
    const createDependencies = vi.fn();
    const env = {
      ENABLE_LIVE_M365: "true", M365_TENANT_ID: project.tenant.tenantId,
      AZURE_TENANT_ID: "22222222-2222-4222-8222-222222222222",
    };
    await expect(runServiceWorker(live, { project, once: true, env, createDependencies }))
      .rejects.toThrow("actual Azure identity tenant");
    expect(createDependencies).not.toHaveBeenCalled();
    expect(() => validateProjectTenantBinding(project.tenant, { ...live, graphAuthentication: "certificate" }, env)).not.toThrow();
    expect(() => validateProjectTenantBinding(project.tenant, live, { AZURE_TENANT_ID: project.tenant.tenantId })).not.toThrow();
    expect(() => validateProjectTenantBinding(undefined, live, {})).not.toThrow();
    const certificate = {
      ...live, graphAuthentication: "certificate" as const, serviceHealth: true,
      providerClientId: "33333333-3333-4333-8333-333333333333",
    };
    expect(() => validateProjectTenantBinding(project.tenant, certificate, env)).toThrow("providerClientId must use");
    expect(() => validateProjectTenantBinding(project.tenant, { ...certificate, serviceHealth: false }, env)).not.toThrow();
    expect(() => validateProjectTenantBinding(project.tenant, certificate, {
      ...env, AZURE_TENANT_ID: project.tenant.tenantId,
    })).not.toThrow();
  });

  it("runs 700 attempts from 100 targets and reports per journey and group, never per account", async () => {
    const document = documentFixture();
    const exchange = document.tenants[0]!.services.exchange;
    exchange.targets = Array.from({ length: 100 }, (_, index) => ({
      id: `pair-${index}`, mailbox: `probe-${index}@example.invalid`, recipientMailbox: "recipient@example.invalid",
    }));
    document.groups = [{ id: "everyone", displayName: "Everyone", accounts: exchange.targets.map(target => target.mailbox!), teams: [] }];
    const project = selectTenant(parseProjectDocument(document));
    const selected = applyProjectConfig(project, service);
    expect(serviceSettings(selected, {}, project.services.exchange.scenarios).probes).toHaveLength(700);
    const telemetry = { emit: vi.fn() };
    await runServiceWorker(selected, { project, once: true, env: {}, telemetry });
    expect(telemetry.emit.mock.calls.filter(([event]) => event === "synthetic-result")).toHaveLength(700);
    const previews = telemetry.emit.mock.calls.filter(([event]) => event === "health-report-preview");
    expect(previews).toHaveLength(64 + 14);
    expect(previews.filter(([, report]) => report.body.signalName.startsWith("group-everyone--tenant-contoso--"))).toHaveLength(14);
    expect(JSON.stringify(telemetry.emit.mock.calls)).not.toContain("probe-0@example.invalid");
    project.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
    expect(() => applyProjectConfig(project, { ...service, mode: "live" })).toThrow("needs cycleTimeoutSeconds");
    const budget = { ...service, mode: "live" as const, maxConcurrentProbes: 20, cycleTimeoutSeconds: 1000 };
    expect(() => applyProjectConfig(project, budget)).toThrow("TTL");
    project.healthModel.reportTtlMinutes = 30;
    expect(applyProjectConfig(project, budget).targets).toHaveLength(100);
    expect(() => applyProjectConfig(project, { ...budget, maxConcurrentProbes: 21 })).toThrow("maxConcurrentProbes");
  });
});

describe("project-root monitoring configuration", () => {
  it.each([undefined, {}, { enabled: false }])("defaults Service Health off for %j", setting => {
    const configured = parseProjectConfig({ ...checkedIn, serviceHealth: setting });
    expect(configured.serviceHealth.enabled).toBe(false);
  });
  it.each(["exchange", "teams", "onedrive"] as const)(
    "gates both stable and beta %s providers without changing journey selection", async type => {
      const file = executionFixture(type);
      const configured = {
        ...file, serviceHealth: true,
        serviceActivity: { ...file.serviceActivity, enabled: type !== "onedrive" },
      };
      const disabled = applyProjectConfig(checkedIn, configured);
      expect(disabled.serviceHealth).toBe(false);
      expect(disabled.serviceActivity.enabled).toBe(false);
      const enabled = applyProjectConfig({ ...checkedIn, serviceHealth: { enabled: true } }, configured);
      expect(enabled.serviceHealth).toBe(true);
      expect(enabled.serviceActivity.enabled).toBe(type !== "onedrive");
      expect(serviceProbes(disabled, checkedIn.services[type].scenarios))
        .toEqual(serviceProbes(enabled, checkedIn.services[type].scenarios));
    },
  );
  it("does not schedule collection, obtain credentials or preview provider reports when omitted", async () => {
    const configured = parseProjectConfig({ ...checkedIn, serviceHealth: undefined });
    const providers = vi.fn();
    const fetcher = vi.fn();
    const output = { emit: vi.fn() };
    vi.stubGlobal("fetch", fetcher);
    await runServiceWorker({
      ...service, serviceHealth: true, serviceActivity: { ...service.serviceActivity, enabled: true },
    }, { project: configured, providers, once: true, env: {}, telemetry: output });
    expect(providers).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(output.emit.mock.calls.filter(([event]) => event === "synthetic-result")).toHaveLength(7);
    expect(output.emit.mock.calls.some(([, data]) => data.entityName === "exchange-service-health")).toBe(false);
    expect(output.emit.mock.calls.some(([event]) => event === "service-provider-summary")).toBe(false);
  });
  it.each(["true", 1, null])("rejects a non-boolean Service Health opt-in %j", enabled => {
    expect(() => parseProjectConfig({ ...checkedIn, serviceHealth: { enabled } })).toThrow("serviceHealth.enabled");
  });
  it("preserves legacy single-mailbox selection while expanding all explicit pairs independently", () => {
    const project = structuredClone(checkedIn);
    const old = {
      ...project, services: { ...project.services, exchange: {
        ...project.services.exchange,
        scenarios: { "send-receive-mail": true, "edit-reopen-draft": true },
        targets: [{ id: "legacy", mailbox: "legacy@example.invalid" }],
      } },
    };
    const migrated = parseProjectConfig(old);
    expect(migrated.services.exchange.scenarios["attachment-mail"]).toBe(true);
    expect(migrated.services.exchange.scenarios["meeting-invitation"]).toBe(true);
    project.services.exchange.targets.push({
      id: "second-pair", mailbox: "second@example.invalid", recipientMailbox: "third@example.invalid",
    });
    const selected = applyProjectConfig(project, service);
    expect(selected.targets).toHaveLength(2);
    expect(selected.targets[0]).toHaveProperty("distributionList");
    expect(selected.targets[1]).toHaveProperty("recipientMailbox", "third@example.invalid");
  });
  it("supports all seven journeys for thirty root-owned target sets", () => {
    const project = structuredClone(checkedIn);
    project.services.exchange.targets = Array.from({ length: 30 }, (_, index) => ({
      ...project.services.exchange.targets[0]!, id: `exchange-pair-${index}`,
    }));
    const configured = applyProjectConfig(project, service);
    expect(serviceProbes(configured, project.services.exchange.scenarios)).toHaveLength(210);
    expect(serviceSettings(configured, {}, project.services.exchange.scenarios).probes).toHaveLength(210);
  });
  it("keeps retained reply fixtures root-owned and rejects the obsolete combined scenario explicitly", () => {
    const project = structuredClone(checkedIn);
    project.services.exchange.targets[0]!.replySeed = {
      messageId: "received-immutable-id", correlationId: "11111111-1111-4111-8111-111111111111",
    };
    const configured = applyProjectConfig(project, service);
    expect(serviceProbes(configured, project.services.exchange.scenarios)
      .find(probe => probe.type === "exchange-reply")?.replySeed).toEqual(project.services.exchange.targets[0]!.replySeed);
    expect(() => parseProjectConfig({
      ...project, services: { ...project.services, exchange: {
        ...project.services.exchange, scenarios: { ...project.services.exchange.scenarios, "attachment-reply-mail": true },
      } },
    })).toThrow("select attachment-mail and reply-mail separately");
  });
  it("selects exactly Exchange, Teams and OneDrive without enabling live I/O", async () => {
    expect(checkedIn.otel).toEqual({ enabled: false, destination: "console" });
    for (const type of ["exchange", "teams", "onedrive"] as const) {
      expect(checkedIn.services[type].enabled).toBe(true);
      expect(Object.values(checkedIn.services[type].scenarios)).toEqual(Array(type === "exchange" ? 7 : type === "teams" ? 2 : 3).fill(true));
      expect(serviceExecution(checkedIn, type)).toMatchObject({ enabled: true, type, mode: "simulation" });
    }
    expect(Object.keys(checkedIn.services).sort()).toEqual(["exchange", "onedrive", "teams"]);
  });
  it("defaults omitted OTEL settings off and rejects unsupported destinations and service-owned settings", () => {
    const { otel, ...previousConfig } = checkedIn;
    expect(parseProjectConfig(previousConfig).otel).toEqual({ enabled: false, destination: "console" });
    expect(parseProjectConfig({ ...previousConfig, otel: { enabled: true } }).otel.destination).toBe("console");
    expect(() => parseProjectConfig({ ...checkedIn, otel: { enabled: true, destination: "private-value" } }))
      .toThrow("otel.destination");
    expect(() => parseProjectConfig({ ...checkedIn, otel: { ...otel, connectionString: "secret" } }))
      .toThrow("Invalid project config fields: otel");
  });
  it("supplies targets and enablement exclusively from the root", () => {
    const project = structuredClone(checkedIn);
    expect(applyProjectConfig(project, service)).toMatchObject({
      targets: project.services.exchange.targets,
    });
    expect(applyProjectConfig(project, service)).not.toHaveProperty("telemetry");
    const previousRuntime = { ...service, enabled: false };
    expect(applyProjectConfig(project, previousRuntime).enabled).toBe(true);
  });
  it.each(["service", "scenario"] as const)("disables execution through the root %s gate before creating dependencies", async gate => {
    const project = structuredClone(checkedIn);
    if (gate === "service") project.services.exchange.enabled = false;
    if (gate === "scenario") {
      for (const key of Object.keys(project.services.exchange.scenarios) as (keyof typeof project.services.exchange.scenarios)[]) {
        project.services.exchange.scenarios[key] = false;
      }
    }
    const createDependencies = vi.fn();
    await runServiceWorker(service, {
      project, once: true, env: {}, telemetry: { emit: vi.fn() }, createDependencies,
    });
    expect(createDependencies).not.toHaveBeenCalled();
  });
  it("previews aggregated reports without any Azure settings", async () => {
    const project = structuredClone(checkedIn);
    const output = { emit: vi.fn() };
    await runServiceWorker(service, { project, once: true, env: {}, telemetry: output });
    const events = output.emit.mock.calls.map(([event]) => event);
    expect(events.filter(event => event === "health-report-preview")).toHaveLength(64);
    expect(events.filter(event => event === "synthetic-result")).toHaveLength(7);
    expect(events).not.toContain("probe-metrics");
    expect(events).not.toContain("health-report-published");
    expect(JSON.stringify(output.emit.mock.calls)).not.toContain("dedicated-synthetic@example.invalid");
  });
  it("wires a live worker from root selection through aggregation to direct reports", async () => {
    const project = structuredClone(checkedIn);
    for (const key of Object.keys(project.services.exchange.scenarios) as (keyof typeof project.services.exchange.scenarios)[]) {
      project.services.exchange.scenarios[key] = key === "send-receive-mail";
    }
    project.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const output = { emit: vi.fn() };
    await runServiceWorker({ ...service, mode: "live" }, {
      project, once: true, telemetry: output,
      env: {
        ENABLE_LIVE_M365: "true", AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222", ...liveTenantEnv,
      },
      handler: async probe => ({
        ...baseResult(probe, Date.now()), success: true, durationMs: 1,
        steps: [{ name: "send", status: "succeeded", observedAt: new Date().toISOString(), durationMs: 1 }],
      }),
    });
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("https://management.azure.com/"))).toBe(true);
    const events = output.emit.mock.calls.map(([event]) => event);
    expect(events.filter(event => event === "health-report-published")).toHaveLength(8);
    expect(events).not.toContain("health-report-preview");
    expect(events).not.toContain("probe-metrics");
  });
  it("rejects invalid fields, wrong-service targets and unsupported journeys without echoing values", () => {
    const invalid = [
      { ...checkedIn, unexpected: true },
      { ...checkedIn, services: { ...checkedIn.services, exchange: {
        ...checkedIn.services.exchange, scenarios: { "unsupported-private-value": true },
      } } },
      { ...checkedIn, services: { ...checkedIn.services, exchange: {
        ...checkedIn.services.exchange, targets: [{ id: "target", driveId: "private-value" }],
      } } },
    ];
    for (const raw of invalid) expect(() => parseProjectConfig(raw)).toThrow("Invalid project config");
    expect(() => parseProjectConfig({ ...checkedIn, healthModel: { ...checkedIn.healthModel, name: "private-value/escape" } }))
      .toThrow("healthModel.name");
  });
  it("rejects reversed thresholds, duplicates and enabled empty target lists", () => {
    expect(() => parseProjectConfig({
      ...checkedIn, healthModel: { ...checkedIn.healthModel, successUnhealthyPercent: 100 },
    })).toThrow("order Degraded before Unhealthy");
    const project = structuredClone(checkedIn);
    project.services.exchange.targets.push(project.services.exchange.targets[0]!);
    expect(() => parseProjectConfig(project)).toThrow("unique");
    project.services.exchange.targets = [];
    expect(() => parseProjectConfig(project)).toThrow("at least one target");
    for (const key of Object.keys(project.services.exchange.scenarios) as (keyof typeof project.services.exchange.scenarios)[]) {
      project.services.exchange.scenarios[key] = false;
    }
    expect(applyProjectConfig(parseProjectConfig(project), service)).toMatchObject({ enabled: false, targets: [] });
  });
  it("requires a real subscription and enough report TTL before live credentials or operations", () => {
    const project = structuredClone(checkedIn);
    const live = { ...service, mode: "live" as const };
    expect(() => applyProjectConfig(project, live)).toThrow("approved healthModel.subscriptionId");
    project.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
    project.healthModel.reportTtlMinutes = 4;
    expect(() => applyProjectConfig(project, live)).toThrow("TTL");
    project.healthModel.reportTtlMinutes = 9;
    expect(applyProjectConfig(project, live).enabled).toBe(true);
    expect(applyProjectConfig(project, { ...live, intervalSeconds: 80 }).enabled).toBe(true);
    project.otel.enabled = true;
    expect(() => applyProjectConfig(project, { ...live, intervalSeconds: 320 })).toThrow("224 seconds");
  });
});
