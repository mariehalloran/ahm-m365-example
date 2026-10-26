import { afterEach, describe, expect, it, vi } from "vitest";
import { applyProjectConfig, parseProjectConfig, readProjectConfig, readProjectService } from "../src/project-config.js";
import { parseServiceConfig, serviceProbes, serviceSettings } from "../src/service-config.js";
import { parseWorkerArguments, runServiceWorker } from "../src/worker.js";
import { baseResult } from "../src/probes.js";

vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: vi.fn(function () {
    return { getToken: vi.fn(async () => ({ token: "mock-arm-token", expiresOnTimestamp: Date.now() + 60000 })) };
  }),
  ClientCertificateCredential: vi.fn(),
}));
afterEach(() => vi.unstubAllGlobals());

const checkedIn = await readProjectConfig("../monitoring.config.json");
const service = parseServiceConfig({
  type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation",
  cohort: "exchange-global", targets: [{ id: "service-file-target" }],
});

describe("project-root monitoring configuration", () => {
  it("keeps call quality diagnostic unless explicit, ordered root thresholds are supplied", () => {
    expect(checkedIn.healthModel.callQualityThresholds).toEqual({});
    for (const thresholds of [
      { jitterMs: { degradedAbove: 30, unhealthyAbove: 20 } },
      { packetLossPercent: { degradedAbove: 1, unhealthyAbove: 101 } },
      { notAMetric: { degradedAbove: 1, unhealthyAbove: 2 } },
    ]) {
      expect(() => parseProjectConfig({
        ...checkedIn, healthModel: { ...checkedIn.healthModel, callQualityThresholds: thresholds },
      })).toThrow();
    }
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
    expect(migrated.services.exchange.scenarios["attachment-reply-mail"]).toBe(false);
    expect(migrated.services.exchange.scenarios["meeting-invitation"]).toBe(false);
    project.services.exchange.targets.push({
      id: "second-pair", mailbox: "second@example.invalid", recipientMailbox: "third@example.invalid",
    });
    const selected = applyProjectConfig(project, service);
    expect(selected.targets).toHaveLength(2);
    expect(selected.targets[0]).toHaveProperty("distributionList");
    expect(selected.targets[1]).toHaveProperty("recipientMailbox", "third@example.invalid");
  });
  it("supports all six journeys for thirty root-owned target sets", () => {
    const project = structuredClone(checkedIn);
    project.services.exchange.targets = Array.from({ length: 30 }, (_, index) => ({
      ...project.services.exchange.targets[0]!, id: `exchange-pair-${index}`,
    }));
    const configured = applyProjectConfig(project, service);
    expect(serviceProbes(configured, project.services.exchange.scenarios)).toHaveLength(180);
    expect(serviceSettings(configured, {}, project.services.exchange.scenarios).probes).toHaveLength(180);
  });
  it("selects Exchange, Teams and OneDrive; explicitly disables SharePoint without enabling live I/O", async () => {
    expect(Object.keys(checkedIn).sort()).toEqual(["healthModel", "otel", "schemaVersion", "services"]);
    expect(checkedIn.otel).toEqual({ enabled: false, destination: "console" });
    for (const type of ["exchange", "teams", "onedrive"] as const) {
      expect(checkedIn.services[type].enabled).toBe(true);
      expect(Object.values(checkedIn.services[type].scenarios)).toEqual(Array(type === "exchange" ? 6 : 3).fill(true));
      const selected = await readProjectService(type, "../monitoring.config.json");
      expect(selected.service).toMatchObject({ enabled: true, type, mode: "simulation" });
    }
    expect(checkedIn.services.sharepoint.enabled).toBe(false);
    expect((await readProjectService("sharepoint", "../monitoring.config.json")).service.enabled).toBe(false);
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
    expect(events.filter(event => event === "health-report-preview")).toHaveLength(62);
    expect(events.filter(event => event === "synthetic-result")).toHaveLength(6);
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
      env: { ENABLE_LIVE_M365: "true", AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222" },
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
  it("surfaces missing root configuration and supports a separate root-config CLI argument", async () => {
    await expect(readProjectConfig("utils/tests/missing-project.json")).rejects.toThrow("Cannot read the project config");
    expect(parseWorkerArguments(["--project-config", "/etc/monitoring.json", "--once"], "")).toEqual({
      config: "", projectConfig: "/etc/monitoring.json", once: true,
    });
    expect(() => parseWorkerArguments(["--project-config"], "")).toThrow("Usage");
    expect(() => parseWorkerArguments(["--project-config", "a", "--project-config", "b"], "")).toThrow("Usage");
  });
});
