import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../utils/src/config.js";
import { aggregateHealthReports } from "../../utils/src/health-reports.js";
import { baseResult, simulate } from "../../utils/src/probes.js";
import { applyProjectConfig, parseProjectConfig, readProjectConfig, readProjectService } from "../../utils/src/project-config.js";
import { serviceRuntime } from "../../utils/src/runtime.js";
import { parseServiceConfig, parseServiceFileConfig, readServiceConfig, serviceProbes, serviceSettings } from "../../utils/src/service-config.js";
import { serviceHealthSources } from "../../utils/src/service-health.js";
import { runCycle } from "../../utils/src/runner.js";
import { runServiceWorker } from "../../utils/src/worker.js";
import { resultSchema, testTypes } from "../../utils/src/contracts.js";

const checkedIn = await readProjectConfig("../monitoring.config.json");
const file = await readServiceConfig("onedrive/config.json");
const configured = applyProjectConfig(checkedIn, file);
const telemetry = { emit: vi.fn() };

describe("OneDrive root selection and independent execution", () => {
  it("selects three supported families for both safe sample accounts, with no SharePoint execution", () => {
    expect(configured).toMatchObject({ enabled: true, type: "onedrive", mode: "simulation" });
    expect(checkedIn.services.sharepoint.enabled).toBe(false);
    expect(serviceProbes(configured, checkedIn.services.onedrive.scenarios)).toHaveLength(6);
    expect(configured.executionLanes).toHaveLength(3);
    expect(configured.executionLanes?.every(lane => lane.intervalSeconds === 300)).toBe(true);
    expect(file).not.toHaveProperty("targets");
    expect(file).not.toHaveProperty("enabled");
  });
  it("leaves OneDrive disabled for original private profiles that omit it", () => {
    const { onedrive, ...services } = checkedIn.services;
    const migrated = parseProjectConfig({ ...checkedIn, services });
    expect(migrated.services.onedrive).toMatchObject({ enabled: false, targets: [] });
    expect(Object.values(migrated.services.onedrive.scenarios).some(Boolean)).toBe(false);
    expect(applyProjectConfig(migrated, file).enabled).toBe(false);
    expect(onedrive.enabled).toBe(true);
  });
  it("supports all selected accounts with missing drive IDs for real appfolder execution; no root discovery requirement", () => {
    const live = parseServiceConfig({ ...configured, mode: "live" });
    const settings = serviceSettings(live, { ENABLE_LIVE_M365: "true" }, checkedIn.services.onedrive.scenarios);
    expect(settings.probes).toHaveLength(6);
    expect(settings.probes.every(probe => !probe.driveId && probe.userId)).toBe(true);
  });
  it.each(["userId", "userPrincipalName", "driveId"] as const)("rejects duplicate root allowlist %s bindings", key => {
    const project = structuredClone(checkedIn);
    project.services.onedrive.targets[0]![key] = key === "userId" ? "11111111-1111-4111-8111-111111111111"
      : key === "driveId" ? "drive" : "one@example.invalid";
    project.services.onedrive.targets[1]![key] = project.services.onedrive.targets[0]![key];
    expect(() => parseProjectConfig(project)).toThrow("OneDrive accounts and drives must be unique");
  });
  it.each(["userId", "userPrincipalName", "driveId", "folderId", "folderName"] as const)("rejects runtime attempts outside configured %s", async key => {
    const settings = serviceSettings(configured, {}, checkedIn.services.onedrive.scenarios);
    settings.probes[0]![key] = "altered";
    await expect(serviceRuntime(configured, settings, telemetry, {})).rejects.toThrow("selected root-configured");
  });
  it.each([
    { serviceHealth: true }, { serviceActivity: { enabled: true } },
    { providerClientId: "11111111-1111-4111-8111-111111111111" },
  ])("does not silently alias an unsupported provider collector %j", extra => {
    expect(() => parseServiceFileConfig({ ...file, ...extra })).toThrow("no supported provider collector");
    expect(serviceHealthSources("onedrive")).toEqual([]);
  });
  it("reports all six settled attempts into stable existing roots and step IDs, not per-target inventories", async () => {
    const output = { emit: vi.fn() };
    await runServiceWorker(configured, { project: checkedIn, once: true, telemetry: output, env: {} });
    const results = output.emit.mock.calls.filter(([name]) => name === "synthetic-result");
    expect(results).toHaveLength(6);
    const previews = output.emit.mock.calls.filter(([name]) => name === "health-report-preview");
    expect(previews).toHaveLength(30);
    const serialized = JSON.stringify(previews);
    expect(serialized).toContain("onedrive-planned-user-drive-roundtrip-step-1");
    expect(serialized).toContain("onedrive-planned-app-folder-lifecycle-step-4");
    expect(serialized).not.toContain("onedrive-probe-001");
    expect(serialized).not.toContain("serviceAnnouncement");
    expect(output.emit.mock.calls.some(([name]) => name === "health-report-published")).toBe(false);
  });
  it("aggregates binary failure and does not treat unexecuted optional restore as a failed request", async () => {
    const selected = serviceProbes(configured, checkedIn.services.onedrive.scenarios).filter(probe => probe.type === "onedrive-versions");
    const results = await Promise.all(selected.map(probe => simulate(probe, {
      signal: new AbortController().signal, telemetry, config: {
        SYNTHETIC_SCENARIO: "healthy", PROBE_TIMEOUT_MS: 120000, POLL_INTERVAL_MS: 2000,
      },
    })));
    results[0]!.success = false;
    results[0]!.diagnosticCategory = "permission-failure";
    const reports = aggregateHealthReports("onedrive", { cycleId: "cycle", results }, checkedIn.healthModel);
    expect(reports.find(report => report.entityName === "onedrive-planned-document-versions" &&
      report.body.signalName === "synthetic-success-percentage")?.body).toMatchObject({ value: 50, healthState: "Unhealthy" });
    expect(reports.find(report => report.entityName.endsWith("step-4"))?.body).toMatchObject({ healthState: "Unknown" });
  });
  it.each(testTypes.filter(type => type.startsWith("onedrive-")))("validates all simulation outcomes for %s", async type => {
    const probe = serviceProbes(configured, checkedIn.services.onedrive.scenarios).find(probe => probe.type === type)!;
    for (const scenario of ["healthy", "failed", "slow", "timeout", "stale"] as const) {
      expect(resultSchema.safeParse(await simulate({ ...probe, scenario }, {
        config: { SYNTHETIC_SCENARIO: "healthy", PROBE_TIMEOUT_MS: 120000, POLL_INTERVAL_MS: 2000 },
        telemetry, signal: new AbortController().signal,
      })).success).toBe(true);
    }
  });
  it("reports an execution timeout as Unhealthy rather than Unknown", async () => {
    const probe = serviceProbes(configured, checkedIn.services.onedrive.scenarios)[0]!;
    const config = loadConfig({
      EXECUTION_MODE: "live", ENABLE_LIVE_M365: "true", PROBE_TIMEOUT_MS: "100",
      PROBES_JSON: JSON.stringify([probe]),
    });
    const record = vi.fn();
    await runCycle(config, {
      telemetry, results: { record, recordDiagnostic: vi.fn() },
      handler: async (selected, context) => {
        await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { ...baseResult(selected, Date.now()), success: true, durationMs: 1 };
      },
    });
    const result = record.mock.calls[0]![0];
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout" });
    expect(aggregateHealthReports("onedrive", { cycleId: "timeout", results: [result] }, checkedIn.healthModel)[0]?.body.healthState).toBe("Unhealthy");
  });
  it("reads the service-specific independent config through the root", async () => {
    expect((await readProjectService("onedrive", "../monitoring.config.json")).service.executionLanes).toEqual(file.executionLanes);
  });
});
