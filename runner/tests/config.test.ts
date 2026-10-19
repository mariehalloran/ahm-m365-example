import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("safe runtime configuration", () => {
  it("defaults to the deployed API without overriding explicit versions", () => {
    expect(loadConfig({}).AHM_API_VERSION).toBe("2026-05-01-preview");
    expect(loadConfig({ AHM_API_VERSION: "2026-01-01-preview" }).AHM_API_VERSION).toBe("2026-01-01-preview");
  });
  it("requires explicit live consent and dedicated resources", () => {
    expect(() => loadConfig({ EXECUTION_MODE: "live" })).toThrow("ENABLE_LIVE_M365");
    expect(() => loadConfig({ EXECUTION_MODE: "live", ENABLE_LIVE_M365: "true" })).toThrow("Missing dedicated resources");
  });
  it("rejects duplicate IDs, mixed cohorts and invalid thresholds", () => {
    const probe = { id: "probe-001", type: "exchange-mail-flow", cohort: "cohort-global" };
    expect(() => loadConfig({ PROBES_JSON: JSON.stringify([probe, probe]) })).toThrow("unique");
    expect(() => loadConfig({
      PROBES_JSON: JSON.stringify([probe, { ...probe, id: "probe-002", type: "sharepoint-file" }]),
    })).toThrow("mix");
    expect(() => loadConfig({ HEALTHY_SUCCESS_RATE: "0.90" })).toThrow("threshold");
  });
});
