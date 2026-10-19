import { describe, expect, it } from "vitest";
import { parseServiceConfig, readServiceConfig, serviceSettings } from "../src/service-config.js";
import { parseWorkerArguments } from "../src/worker.js";

const raw = {
  type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation",
  cohort: "exchange-global", targets: [{ id: "exchange-001" }],
};
describe("strict config-first service settings", () => {
  it("defaults to console telemetry and one target with no history or policy", () => {
    const service = parseServiceConfig(raw);
    expect(service).toMatchObject({ scenario: "healthy", telemetry: "console" });
    expect(serviceSettings(service, {}).probes).toHaveLength(1);
  });
  it.each([null, [], "exchange", { ...raw, unexpected: true }, { ...raw, type: "unknown" }, { ...raw, enabled: "true" }])(
    "rejects invalid top-level JSON objects", value => expect(() => parseServiceConfig(value)).toThrow("Invalid service config"),
  );
  it.each([false, true])("explicitly rejects obsolete reportToHealthModel=%s", reportToHealthModel => {
    expect(() => parseServiceConfig({ ...raw, reportToHealthModel })).toThrow("Invalid service config");
  });
  it.each(["otlp", "prometheus", "", true])("rejects unsupported telemetry destination %s", telemetry => {
    expect(() => parseServiceConfig({ ...raw, telemetry })).toThrow("telemetry");
  });
  it.each([0, -1, 1.1, 86401, "60"])("rejects invalid intervals %s", intervalSeconds => {
    expect(() => parseServiceConfig({ ...raw, intervalSeconds })).toThrow("intervalSeconds");
  });
  it.each([0, -1, 1.1, 121, "45"])("rejects invalid timeouts %s", timeoutSeconds => {
    expect(() => parseServiceConfig({ ...raw, timeoutSeconds })).toThrow("timeoutSeconds");
  });
  it("accepts bounded cadence and timeout endpoints", () => {
    expect(parseServiceConfig({ ...raw, intervalSeconds: 1, timeoutSeconds: 1 }).intervalSeconds).toBe(1);
    expect(parseServiceConfig({ ...raw, intervalSeconds: 86400, timeoutSeconds: 120 }).intervalSeconds).toBe(86400);
  });
  it.each([
    { id: "probe-001", type: "exchange-mail-flow" }, { id: "probe-001", cohort: "other-cohort" },
    { id: "probe-001", siteId: "wrong-service" }, { id: "probe-001", extra: true },
    { id: "../escape" }, { id: "probe-001", scenario: "invalid" },
  ])("rejects derived, unknown or wrong-service target fields", target => {
    expect(() => parseServiceConfig({ ...raw, targets: [target] })).toThrow("targets");
  });
  it("rejects Exchange fields on SharePoint and accepts complete SharePoint resources", () => {
    expect(() => parseServiceConfig({ ...raw, type: "sharepoint", targets: [{ id: "sp-001", mailbox: "test@example.invalid" }] })).toThrow("targets");
    const service = parseServiceConfig({ ...raw, type: "sharepoint", mode: "live",
      targets: [{ id: "sp-001", siteId: "site", driveId: "drive", folderId: "folder", region: "eastus", scenario: "slow" }],
    });
    expect(serviceSettings(service, { ENABLE_LIVE_M365: "true" }).probes[0]).toMatchObject({ type: "sharepoint-file", region: "eastus", scenario: "slow" });
  });
  it("requires unique IDs and enabled targets but accepts disabled empty targets", () => {
    expect(() => parseServiceConfig({ ...raw, targets: [{ id: "same" }, { id: "same" }] })).toThrow("unique");
    expect(() => parseServiceConfig({ ...raw, targets: [] })).toThrow("at least one");
    expect(parseServiceConfig({ ...raw, enabled: false, targets: [] }).targets).toEqual([]);
  });
  it("keeps Teams disabled with no result type or runtime", () => {
    expect(parseServiceConfig({ ...raw, type: "teams", enabled: false, targets: [] }).type).toBe("teams");
    expect(() => parseServiceConfig({ ...raw, type: "teams", targets: [] })).toThrow("not implemented");
  });
  it("requires live consent and dedicated resources independently of telemetry", () => {
    const service = parseServiceConfig({ ...raw, mode: "live" });
    expect(() => serviceSettings(service, {})).toThrow("ENABLE_LIVE_M365");
    expect(() => serviceSettings(service, { ENABLE_LIVE_M365: "true" })).toThrow("Missing dedicated resources");
    const sharepoint = parseServiceConfig({ ...raw, type: "sharepoint", mode: "live", targets: [{ id: "sp-001", siteId: "site" }] });
    expect(() => serviceSettings(sharepoint, { ENABLE_LIVE_M365: "true" })).toThrow("Missing dedicated resources");
  });
  it("derives execution settings from JSON and only reads execution knobs from env", () => {
    const config = serviceSettings(parseServiceConfig({ ...raw, type: "sharepoint", scenario: "slow" }), {
      EXECUTION_MODE: "live", SYNTHETIC_SCENARIO: "invalid", PROBES_JSON: "not-json", PROBE_TIMEOUT_MS: "invalid", POLL_INTERVAL_MS: "50",
    });
    expect(config).toMatchObject({ EXECUTION_MODE: "simulation", SYNTHETIC_SCENARIO: "slow", PROBE_TIMEOUT_MS: 45000, POLL_INTERVAL_MS: 50 });
    expect(config.probes.every(probe => probe.type === "sharepoint-file")).toBe(true);
  });
  it("surfaces missing files and checks in a single safe simulation per enabled service", async () => {
    await expect(readServiceConfig("runner/tests/nonexistent-config.json")).rejects.toThrow("Cannot read");
    for (const type of ["exchange", "sharepoint"] as const) {
      expect(await readServiceConfig(`probes/${type}/config.json`)).toMatchObject({ mode: "simulation", telemetry: "console", targets: [expect.anything()] });
      expect((await readServiceConfig(`probes/${type}/config.json`)).targets).toHaveLength(1);
    }
    expect(await readServiceConfig("probes/teams/config.json")).toMatchObject({ enabled: false, telemetry: "console" });
  });
});
describe("explicit worker arguments", () => {
  it("requires an explicit config and supports continuous or once mode", () => {
    expect(parseWorkerArguments(["--config", "probes/exchange/config.json"])).toEqual({ config: "probes/exchange/config.json", once: false });
    expect(parseWorkerArguments(["--once", "--config", "probes/sharepoint/config.json"])).toEqual({ config: "probes/sharepoint/config.json", once: true });
  });
  it.each([[], ["--once"], ["--config"], ["--config", "--once"], ["--config", "a", "--config", "b"], ["--config", "a", "--once", "--once"], ["--config", "a", "--extra"]].map(args => ({ args })))(
    "rejects ambiguous CLI invocation $args", ({ args }) => expect(() => parseWorkerArguments(args)).toThrow(),
  );
});
