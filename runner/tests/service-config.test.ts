import { describe, expect, it } from "vitest";
import { parseServiceConfig, readServiceConfig, serviceSettings, serviceStateLocation } from "../src/service-config.js";
import { parseWorkerArguments } from "../src/worker.js";

const raw = {
  type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation",
  cohort: "exchange-global", targets: [{ id: "exchange-001" }, { id: "exchange-002" }, { id: "exchange-003" }],
};
const model = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/test/providers/Microsoft.CloudHealth/healthmodels/test-model";

describe("strict config-first service settings", () => {
  it("defaults scenario and reporting without changing the three-sample policy", () => {
    const service = parseServiceConfig(raw);
    expect(service).toMatchObject({ scenario: "healthy", reportToHealthModel: false });
    expect(serviceSettings(service, {}).MIN_FRESH_SAMPLES).toBe(3);
  });
  it.each([null, [], "exchange", { ...raw, unexpected: true }, { ...raw, type: "unknown" }, { ...raw, enabled: "true" }])(
    "rejects invalid top-level JSON objects", value => expect(() => parseServiceConfig(value)).toThrow("Invalid service config"),
  );
  it.each([0, -1, 1.1, 86401, "60"])( "rejects invalid intervals %s", intervalSeconds => {
    expect(() => parseServiceConfig({ ...raw, intervalSeconds })).toThrow("intervalSeconds");
  });
  it.each([0, -1, 1.1, 121, "45"])( "rejects invalid timeouts %s", timeoutSeconds => {
    expect(() => parseServiceConfig({ ...raw, timeoutSeconds })).toThrow("timeoutSeconds");
  });
  it("accepts explicit bounded cadence and timeout endpoints", () => {
    expect(parseServiceConfig({ ...raw, intervalSeconds: 1, timeoutSeconds: 1 }).intervalSeconds).toBe(1);
    expect(parseServiceConfig({ ...raw, intervalSeconds: 86400, timeoutSeconds: 120 }).intervalSeconds).toBe(86400);
  });
  it.each([
    { id: "probe-001", type: "exchange-mail-flow" }, { id: "probe-001", cohort: "other-cohort" },
    { id: "probe-001", siteId: "wrong-service" }, { id: "probe-001", extra: true },
    { id: "../escape" }, { id: "probe-001", scenario: "invalid" },
  ])("rejects unknown, derived, or wrong-service target fields", target => {
    expect(() => parseServiceConfig({ ...raw, targets: [target] })).toThrow("targets");
  });
  it("rejects Exchange fields on SharePoint and accepts its dedicated resource fields", () => {
    expect(() => parseServiceConfig({ ...raw, type: "sharepoint", targets: [{ id: "sp-001", mailbox: "test@example.invalid" }] })).toThrow("targets");
    const service = parseServiceConfig({
      ...raw, type: "sharepoint", mode: "live",
      targets: [{ id: "sp-001", siteId: "site", driveId: "drive", folderId: "folder", region: "eastus", scenario: "slow" }],
    });
    expect(serviceSettings(service, { ENABLE_LIVE_M365: "true" }).probes[0]).toMatchObject({
      type: "sharepoint-file", cohort: "exchange-global", region: "eastus", scenario: "slow",
    });
  });
  it("rejects duplicate IDs and empty enabled targets but permits disabled empty targets", () => {
    expect(() => parseServiceConfig({ ...raw, targets: [{ id: "same" }, { id: "same" }] })).toThrow("unique");
    expect(() => parseServiceConfig({ ...raw, targets: [] })).toThrow("at least one");
    expect(parseServiceConfig({ ...raw, enabled: false, targets: [] }).targets).toEqual([]);
  });
  it("accepts disabled Teams without adding any synthetic result type", () => {
    expect(parseServiceConfig({ ...raw, type: "teams", enabled: false, targets: [] }).type).toBe("teams");
    expect(() => parseServiceConfig({ ...raw, type: "teams", targets: [] })).toThrow("not implemented");
  });
  it("requires live consent and complete resources independently of reporting", () => {
    const service = parseServiceConfig({ ...raw, mode: "live" });
    expect(() => serviceSettings(service, {})).toThrow("ENABLE_LIVE_M365");
    expect(() => serviceSettings(service, { ENABLE_LIVE_M365: "true" })).toThrow("Missing dedicated resources");
    const sharepoint = parseServiceConfig({ ...raw, type: "sharepoint", mode: "live", targets: [{ id: "sp-001", siteId: "site" }] });
    expect(() => serviceSettings(sharepoint, { ENABLE_LIVE_M365: "true" })).toThrow("Missing dedicated resources");
  });
  it("overrides legacy target/mode/scenario/timeout env and ignores unused Azure/provider settings offline", () => {
    const service = parseServiceConfig({ ...raw, type: "sharepoint", scenario: "slow" });
    const config = serviceSettings(service, {
      EXECUTION_MODE: "live", SYNTHETIC_SCENARIO: "invalid", PROBES_JSON: "not-json", PROBE_TIMEOUT_MS: "invalid",
      PROVIDER_SCENARIO: "invalid", AHM_MODEL_ID: "invalid", AHM_API_VERSION: "invalid", STATE_STORAGE_URL: "invalid",
      STATE_FILE: "../global.json", MIN_FRESH_SAMPLES: "2",
    });
    expect(config).toMatchObject({ EXECUTION_MODE: "simulation", SYNTHETIC_SCENARIO: "slow", PROBE_TIMEOUT_MS: 45000, MIN_FRESH_SAMPLES: 2 });
    expect(config.probes.every(probe => probe.type === "sharepoint-file")).toBe(true);
    expect(config.AHM_MODEL_ID).toBeUndefined();
    expect(config.STATE_STORAGE_URL).toBeUndefined();
  });
  it("rejects reserved global entity names", () => {
    expect(() => serviceSettings(parseServiceConfig({ ...raw, cohort: "monitoring-pipeline" }), {})).toThrow("reserved");
  });
  it("requires explicit reporting target, validates API syntax, and preserves explicit version overrides", () => {
    const service = parseServiceConfig({ ...raw, reportToHealthModel: true });
    expect(() => serviceSettings(service, {})).toThrow("AHM_MODEL_ID");
    expect(() => serviceSettings(service, { AHM_MODEL_ID: model, AHM_API_VERSION: "bad" })).toThrow("AHM_API_VERSION");
    expect(serviceSettings(service, { AHM_MODEL_ID: model, AHM_API_VERSION: "2026-01-01-preview" }).AHM_API_VERSION).toBe("2026-01-01-preview");
  });
  it("rejects reporting cadence that outlives evidence, including the execution/ARM TTL margin", () => {
    const service = parseServiceConfig({ ...raw, intervalSeconds: 600, reportToHealthModel: true });
    expect(() => serviceSettings(service, { AHM_MODEL_ID: model, REPORT_TTL_SECONDS: "734" })).toThrow("intervalSeconds + timeoutSeconds + 90 (735)");
    expect(serviceSettings(service, { AHM_MODEL_ID: model, REPORT_TTL_SECONDS: "735" }).REPORT_TTL_SECONDS).toBe(735);
    expect(() => serviceSettings(parseServiceConfig({ ...raw, intervalSeconds: 86400, reportToHealthModel: true }), { AHM_MODEL_ID: model })).toThrow("REPORT_TTL_SECONDS");
    expect(serviceSettings(parseServiceConfig({ ...raw, intervalSeconds: 86400 }), {}).REPORT_TTL_SECONDS).toBe(900);
  });
  it("does not hide missing config files", async () => {
    await expect(readServiceConfig("runner/tests/nonexistent-config.json")).rejects.toThrow("Cannot read");
  });
});

describe("isolated worker history identity", () => {
  const location = (value: unknown, env: NodeJS.ProcessEnv = {}) => {
    const service = parseServiceConfig(value);
    return serviceStateLocation(service, serviceSettings(service, env));
  };
  it("is deterministic and uses dedicated local and blob paths", () => {
    const state = location(raw);
    expect(state).toEqual(location({ ...raw, targets: [...raw.targets].reverse() }));
    expect(state.file).toMatch(/^\.azure\/probes\/exchange\/simulation-[a-f0-9]{24}\/aggregation.json$/);
    expect(state.blob).toBe(state.file.replace(".azure/", ""));
  });
  it("separates type, mode, targets, reporting target, config and policy changes", () => {
    const baseline = location(raw).file;
    const alternatives = [
      location({ ...raw, type: "sharepoint" }).file,
      location({ ...raw, mode: "live", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }] }, { ENABLE_LIVE_M365: "true" }).file,
      location({ ...raw, targets: [{ id: "different-001" }] }).file,
      location({ ...raw, scenario: "failed" }).file,
      location({ ...raw, intervalSeconds: 61 }).file,
      location(raw, { CONSECUTIVE_FAILURES: "3" }).file,
      location({ ...raw, reportToHealthModel: true }, { AHM_MODEL_ID: model }).file,
      location({ ...raw, reportToHealthModel: true }, { AHM_MODEL_ID: `${model}-other` }).file,
    ];
    expect(new Set([baseline, ...alternatives]).size).toBe(alternatives.length + 1);
    expect(location(raw, { AHM_MODEL_ID: model })).toEqual(location(raw));
  });
});

describe("explicit worker CLI arguments", () => {
  it("accepts one explicit config and optional once in either order", () => {
    expect(parseWorkerArguments(["--config", "probes/exchange/config.json", "--once"])).toEqual({ config: "probes/exchange/config.json", once: true });
    expect(parseWorkerArguments(["--once", "--config", "config.json"]).once).toBe(true);
  });
  it.each([[], ["--once"], ["--config"], ["--config", "--once"], ["--config", "one.json", "--config", "two.json"], ["--config", "one.json", "--once", "--once"], ["--all"]].map(args => ({ args })))(
    "rejects implicit, missing, duplicate, or unknown options", ({ args }) => expect(() => parseWorkerArguments(args)).toThrow("Usage:"),
  );
});
