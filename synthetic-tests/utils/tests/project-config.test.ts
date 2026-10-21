import { afterEach, describe, expect, it, vi } from "vitest";
import { applyProjectConfig, parseProjectConfig, readProjectConfig, readProjectService } from "../src/project-config.js";
import { parseServiceConfig } from "../src/service-config.js";
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
  it("enables every implemented service/scenario and OTEL without enabling live I/O", async () => {
    expect(checkedIn.otel).toEqual({ enabled: true, destination: "console" });
    for (const type of ["exchange", "teams", "sharepoint"] as const) {
      expect(checkedIn.services[type].enabled).toBe(true);
      expect(Object.values(checkedIn.services[type].scenarios)).toEqual([true]);
      const selected = await readProjectService(type, "../monitoring.config.json");
      expect(selected.service).toMatchObject({ enabled: true, type, mode: "simulation", telemetry: "console" });
    }
  });
  it("supplies targets, enablement and OTEL exclusively from the root", () => {
    const project = structuredClone(checkedIn);
    project.otel.enabled = false;
    expect(applyProjectConfig(project, service)).toMatchObject({
      telemetry: "none", targets: project.services.exchange.targets,
    });
    project.otel.enabled = true;
    project.otel.destination = "azure-monitor";
    expect(applyProjectConfig(project, service).telemetry).toBe("azure-monitor");
    const previousRuntime = { ...service, enabled: false };
    expect(applyProjectConfig(project, previousRuntime).enabled).toBe(true);
  });
  it.each(["service", "scenario"] as const)("disables execution through the root %s gate before creating dependencies", async gate => {
    const project = structuredClone(checkedIn);
    if (gate === "service") project.services.exchange.enabled = false;
    if (gate === "scenario") project.services.exchange.scenarios["send-receive-mail"] = false;
    const createDependencies = vi.fn();
    await runServiceWorker(service, {
      project, once: true, env: {}, telemetry: { emit: vi.fn() }, createDependencies,
    });
    expect(createDependencies).not.toHaveBeenCalled();
  });
  it("runs with OTEL disabled and previews aggregated reports without any Azure settings", async () => {
    const project = structuredClone(checkedIn);
    project.otel.enabled = false;
    const output = { emit: vi.fn() };
    await runServiceWorker(service, { project, once: true, env: {}, telemetry: output });
    const events = output.emit.mock.calls.map(([event]) => event);
    expect(events.filter(event => event === "health-report-preview")).toHaveLength(8);
    expect(events.filter(event => event === "synthetic-result")).toHaveLength(1);
    expect(events).not.toContain("probe-metrics");
    expect(events).not.toContain("health-report-published");
    expect(JSON.stringify(output.emit.mock.calls)).not.toContain("dedicated-synthetic@example.invalid");
  });
  it("wires a live worker from root selection through aggregation to direct reports with OTEL disabled", async () => {
    const project = structuredClone(checkedIn);
    project.otel.enabled = false;
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
      { ...checkedIn, otel: { enabled: "yes" } },
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
    project.services.exchange.scenarios["send-receive-mail"] = false;
    expect(applyProjectConfig(parseProjectConfig(project), service)).toMatchObject({ enabled: false, targets: [] });
  });
  it("requires a real subscription and enough report TTL before live credentials or operations", () => {
    const project = structuredClone(checkedIn);
    const live = { ...service, mode: "live" as const };
    expect(() => applyProjectConfig(project, live)).toThrow("approved healthModel.subscriptionId");
    project.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
    project.healthModel.reportTtlMinutes = 4;
    expect(() => applyProjectConfig(project, live)).toThrow("TTL");
    project.healthModel.reportTtlMinutes = 5;
    expect(applyProjectConfig(project, live).enabled).toBe(true);
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
