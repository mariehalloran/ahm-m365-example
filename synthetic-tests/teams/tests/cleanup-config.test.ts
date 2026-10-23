import { describe, expect, it, vi } from "vitest";
import { parseServiceConfig, parseServiceFileConfig, readServiceConfig, serviceSettings } from "../../utils/src/service-config.js";
import { reportedResult, resultSchema } from "../../utils/src/contracts.js";
import { simulate } from "../../utils/src/probes.js";

const file = {
  type: "teams", mode: "simulation", cohort: "teams-global", intervalSeconds: 120, timeoutSeconds: 45,
};
const targets = [{ id: "teams-001" }];
const selection = { "publish-channel-message": true, "reply-channel-message": true };

describe("Teams service-config cleanup selection", () => {
  it("defaults to cleanup and explicitly keeps both checked-in profiles safe", async () => {
    expect(parseServiceFileConfig(file).teamsCleanupEnabled).toBe(true);
    for (const path of ["teams/config.json", "teams/config.live.example.json"]) {
      expect((await readServiceConfig(path)).teamsCleanupEnabled).toBe(true);
    }
  });
  it("carries the service-file setting through execution config without environment overrides", () => {
    const enabled = parseServiceConfig({ ...file, enabled: true, targets });
    const disabled = parseServiceConfig({ ...file, enabled: true, targets, teamsCleanupEnabled: false });
    expect(serviceSettings(enabled, { TEAMS_CLEANUP_ENABLED: "false" }).TEAMS_CLEANUP_ENABLED).toBe("true");
    expect(serviceSettings(disabled, { TEAMS_CLEANUP_ENABLED: "true" }).TEAMS_CLEANUP_ENABLED).toBe("false");
  });
  it.each(["false", "true", 0, 1, null])("rejects a non-boolean toggle: %s", teamsCleanupEnabled => {
    expect(() => parseServiceFileConfig({ ...file, teamsCleanupEnabled })).toThrow("teamsCleanupEnabled");
    expect(() => parseServiceConfig({ ...file, enabled: true, targets, teamsCleanupEnabled })).toThrow("teamsCleanupEnabled");
  });
  it.each(["healthy", "failed"] as const)(
    "simulates retention without successful cleanup or real mutation claims in both scenarios (%s)", async scenario => {
      const service = parseServiceConfig({ ...file, enabled: true, targets, scenario, teamsCleanupEnabled: false });
      const config = serviceSettings(service, {}, selection);
      expect(config.probes).toHaveLength(2);
      for (const probe of config.probes) {
        const telemetry = { emit: vi.fn() };
        const result = resultSchema.parse(await simulate(probe, {
          config, signal: new AbortController().signal, telemetry,
        }));
        expect(result.success).toBe(scenario === "healthy");
        expect(result.steps.at(-1)).toMatchObject({ name: "cleanup", status: "skipped", reason: "cleanup-disabled" });
        expect(result.steps.at(-1)).not.toHaveProperty("durationMs");
        expect(result.diagnosticContext).not.toHaveProperty("cleanupSucceeded");
        expect(reportedResult(result).steps.some(step => step.name === "cleanup")).toBe(false);
        expect(telemetry.emit).toHaveBeenCalledWith("teams-cleanup-disabled", expect.objectContaining({
          mode: "simulation", mutationAttempted: false, simulation: true,
        }));
      }
    },
  );
  it("preserves modeled cleanup success when enabled in both scenarios", async () => {
    const config = serviceSettings(parseServiceConfig({ ...file, enabled: true, targets, teamsCleanupEnabled: true }), {}, selection);
    for (const probe of config.probes) {
      const telemetry = { emit: vi.fn() };
      const result = await simulate(probe, { config, signal: new AbortController().signal, telemetry });
      expect(resultSchema.parse(result).diagnosticContext.cleanupSucceeded).toBe(true);
      expect(result.steps.at(-1)).toMatchObject({ name: "cleanup", status: "succeeded" });
      expect(telemetry.emit).not.toHaveBeenCalled();
    }
  });
  it("does not change Exchange/SharePoint cleanup simulation or allow retention reasons on business steps", async () => {
    const config = serviceSettings(parseServiceConfig({ ...file, enabled: true, targets, teamsCleanupEnabled: false }));
    for (const type of ["exchange-mail-flow", "sharepoint-file"] as const) {
      const telemetry = { emit: vi.fn() };
      const result = await simulate({ id: "other-001", type, cohort: "other-global" }, {
        config, signal: new AbortController().signal, telemetry,
      });
      expect(resultSchema.parse(result).diagnosticContext.cleanupSucceeded).toBe(true);
      expect(result.steps.at(-1)?.status).toBe("succeeded");
      expect(telemetry.emit).not.toHaveBeenCalled();
    }
    const result = await simulate(config.probes[0]!, {
      config, signal: new AbortController().signal, telemetry: { emit: vi.fn() },
    });
    expect(resultSchema.safeParse({
      ...result, steps: result.steps.map(step => step.name === "post-message"
        ? { name: step.name, status: "skipped", observedAt: step.observedAt, reason: "cleanup-disabled" } : step),
    }).success).toBe(false);
  });
});
