import { describe, expect, it, vi } from "vitest";
import { parseServiceConfig, parseServiceFileConfig, readServiceConfig, serviceSettings } from "../../utils/src/service-config.js";
import { reportedResult, resultSchema } from "../../utils/src/contracts.js";
import { simulate } from "../../utils/src/probes.js";

const file = {
  type: "exchange", mode: "simulation", cohort: "exchange-global", intervalSeconds: 60, timeoutSeconds: 45,
};
const targets = [{ id: "exchange-001", mailbox: "synthetic@example.invalid" }];
const selection = { "send-receive-mail": true, "edit-reopen-draft": true };

describe("Exchange service-config cleanup selection", () => {
  it("defaults to cleanup in both checked-in profiles", async () => {
    expect(parseServiceFileConfig(file).exchangeCleanupEnabled).toBe(true);
    for (const path of ["exchange/config.json", "exchange/config.live.example.json"]) {
      expect((await readServiceConfig(path)).exchangeCleanupEnabled).toBe(true);
    }
  });
  it("uses the service-file setting rather than an environment override", () => {
    const enabled = parseServiceConfig({ ...file, enabled: true, targets });
    const disabled = parseServiceConfig({ ...file, enabled: true, targets, exchangeCleanupEnabled: false });
    expect(serviceSettings(enabled, { EXCHANGE_CLEANUP_ENABLED: "false" }).EXCHANGE_CLEANUP_ENABLED).toBe("true");
    expect(serviceSettings(disabled, { EXCHANGE_CLEANUP_ENABLED: "true" }).EXCHANGE_CLEANUP_ENABLED).toBe("false");
  });
  it.each(["false", "true", 0, 1, null])("rejects a non-boolean setting: %s", exchangeCleanupEnabled => {
    expect(() => parseServiceFileConfig({ ...file, exchangeCleanupEnabled })).toThrow("exchangeCleanupEnabled");
    expect(() => parseServiceConfig({ ...file, enabled: true, targets, exchangeCleanupEnabled })).toThrow("exchangeCleanupEnabled");
  });
  it.each(["healthy", "failed"] as const)("models retention honestly for both Exchange journeys (%s)", async scenario => {
    const service = parseServiceConfig({ ...file, enabled: true, targets, scenario, exchangeCleanupEnabled: false });
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
      expect(resultSchema.safeParse({
        ...result, steps: result.steps.map(step => step.name === "create-draft"
          ? { name: step.name, status: "skipped", observedAt: step.observedAt, reason: "cleanup-disabled" } : step),
      }).success).toBe(false);
      expect(telemetry.emit).toHaveBeenCalledWith("exchange-cleanup-disabled", expect.objectContaining({
        mode: "simulation", simulation: true, mutationAttempted: false,
      }));
    }
  });
  it("does not disable Teams or SharePoint cleanup", async () => {
    const config = serviceSettings(parseServiceConfig({ ...file, enabled: true, targets, exchangeCleanupEnabled: false }));
    for (const type of ["teams-channel-message", "sharepoint-file"] as const) {
      const telemetry = { emit: vi.fn() };
      const result = resultSchema.parse(await simulate({ id: "other-001", type, cohort: "other-global" }, {
        config, signal: new AbortController().signal, telemetry,
      }));
      expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
      expect(result.steps.at(-1)).toMatchObject({ name: "cleanup", status: "succeeded" });
      expect(telemetry.emit).not.toHaveBeenCalled();
    }
  });
});
