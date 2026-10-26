import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("safe runtime configuration", () => {
  it("defaults to bot MI and rejects unrecognized authentication environment modes", () => {
    expect(loadConfig({})).toMatchObject({ TEAMS_AUTHENTICATION: "bot", BOT_AUTHENTICATION: "managed-identity" });
    expect(() => loadConfig({ TEAMS_AUTHENTICATION: "user-delegated" })).toThrow("TEAMS_AUTHENTICATION");
    for (const value of ["", "cli", "default", "user-delegated", "certificate"]) {
      expect(() => loadConfig({ BOT_AUTHENTICATION: value })).toThrow("BOT_AUTHENTICATION");
    }
    expect(() => loadConfig({ TEAMS_AUTHENTICATION: "automatic" })).toThrow("TEAMS_AUTHENTICATION");
  });
  it("has no model, policy, TTL, or persistence settings", () => {
    expect(Object.keys(loadConfig({})).sort()).toEqual([
      "BOT_AUTHENTICATION", "ENABLE_LIVE_M365", "EXCHANGE_CLEANUP_ENABLED", "EXECUTION_MODE", "POLL_INTERVAL_MS", "PROBE_TIMEOUT_MS", "SYNTHETIC_SCENARIO", "TEAMS_AUTHENTICATION", "TEAMS_CALLING_PORT", "TEAMS_CALLING_PLAYBACK_ENABLED", "TEAMS_CALLING_ANSWER_TIMEOUT_SECONDS", "TEAMS_CALLING_PLAYBACK_TIMEOUT_SECONDS", "TEAMS_CLEANUP_ENABLED", "probes",
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
      PROBES_JSON: JSON.stringify([probe, { ...probe, id: "probe-002", type: "onedrive-roundtrip" }]),
    })).toThrow("mix");
  });
  it("allows the same opaque target ID and cohort across two journeys of one service", () => {
    const target = { id: "shared-target", cohort: "exchange-global", mailbox: "synthetic@example.invalid" };
    const config = loadConfig({ PROBES_JSON: JSON.stringify([
      { ...target, type: "exchange-mail-flow" }, { ...target, type: "exchange-draft" },
    ]) });
    expect(config.probes).toHaveLength(2);
  });
  it("keeps the expanded probe inventory bounded", () => {
    const probes = Array.from({ length: 151 }, (_, index) => ({
      id: `probe-${index}`, type: "teams-channel-message", cohort: "teams-global",
    }));
    expect(() => loadConfig({ PROBES_JSON: JSON.stringify(probes) })).toThrow("Invalid PROBES_JSON");
  });
  it.each(["NaN", "-1", "0", "120001"])("rejects invalid execution deadlines %s", PROBE_TIMEOUT_MS => {
    expect(() => loadConfig({ PROBE_TIMEOUT_MS })).toThrow("PROBE_TIMEOUT_MS");
  });
});
