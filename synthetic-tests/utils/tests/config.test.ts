import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("safe runtime configuration", () => {
  it("has no model, policy, TTL, or persistence settings", () => {
    expect(Object.keys(loadConfig({})).sort()).toEqual([
      "ENABLE_LIVE_M365", "EXECUTION_MODE", "POLL_INTERVAL_MS", "PROBE_TIMEOUT_MS", "SYNTHETIC_SCENARIO", "probes",
    ].sort());
    expect(loadConfig({}).probes).toHaveLength(1);
  });
  it("requires explicit live consent and dedicated resources", () => {
    expect(() => loadConfig({ EXECUTION_MODE: "live" })).toThrow("ENABLE_LIVE_M365");
    expect(() => loadConfig({ EXECUTION_MODE: "live", ENABLE_LIVE_M365: "true" })).toThrow("Missing dedicated resources");
  });
  it("rejects duplicate IDs and mixed cohorts", () => {
    const probe = { id: "probe-001", type: "exchange-mail-flow", cohort: "cohort-global" };
    expect(() => loadConfig({ PROBES_JSON: JSON.stringify([probe, probe]) })).toThrow("unique");
    expect(() => loadConfig({
      PROBES_JSON: JSON.stringify([probe, { ...probe, id: "probe-002", type: "sharepoint-file" }]),
    })).toThrow("mix");
  });
  it.each(["NaN", "-1", "0", "120001"])("rejects invalid execution deadlines %s", PROBE_TIMEOUT_MS => {
    expect(() => loadConfig({ PROBE_TIMEOUT_MS })).toThrow("PROBE_TIMEOUT_MS");
  });
});
