import { describe, expect, it } from "vitest";
import { probeSchema } from "../src/contracts.js";
import { parseServiceConfig, parseServiceExecution, serviceSettings } from "../src/service-config.js";
import { executionFixture } from "./fixtures.js";
import { canonicalProjectFile } from "../src/paths.js";
import { parseWorkerArguments } from "../src/worker.js";

const raw = {
  type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation",
  cohort: "exchange-global", targets: [{ id: "exchange-001" }],
};
describe("strict config-first service settings", () => {
  it("defaults to explicit managed identity and one target with no history or exporter settings", () => {
    const service = parseServiceConfig(raw);
    expect(service).toMatchObject({
      scenario: "healthy", graphAuthentication: "managed-identity", healthReportAuthentication: "managed-identity",
      teamsAuthentication: "bot", botAuthentication: "managed-identity",
    });
    expect(service).not.toHaveProperty("telemetry");
    expect(serviceSettings(service, {}).probes).toHaveLength(1);
  });
  it("polls Exchange journeys finely inside their deadlines and leaves other services at the 2-second default", () => {
    const exchange = parseServiceConfig(raw);
    expect(serviceSettings(exchange, {})).toMatchObject({ POLL_INTERVAL_MS: 500 });
    expect(serviceSettings(exchange, { POLL_INTERVAL_MS: "9000" })).toMatchObject({ POLL_INTERVAL_MS: 500 });
    const onedrive = parseServiceConfig({ ...raw, type: "onedrive", cohort: "onedrive-global", targets: [{ id: "onedrive-001" }] });
    expect(serviceSettings(onedrive, {})).toMatchObject({ POLL_INTERVAL_MS: 2000 });
  });
  it.each(["cli", "default", "", null, true])("rejects unsupported bot authentication %s", botAuthentication => {
    expect(() => parseServiceConfig({ ...raw, botAuthentication })).toThrow("botAuthentication");
  });
  it("keeps Bot Connector and Graph selectors independent and service-file-owned", () => {
    const service = parseServiceConfig({ ...raw, type: "teams", graphAuthentication: "certificate" });
    expect(serviceSettings(service, { BOT_AUTHENTICATION: "certificate" })).toMatchObject({
      TEAMS_AUTHENTICATION: "bot", BOT_AUTHENTICATION: "managed-identity",
    });
    expect(() => parseServiceConfig({ ...service, botAuthentication: "certificate" })).toThrow("botAuthentication");
    expect(serviceSettings(service, { TEAMS_AUTHENTICATION: "user-delegated" }).TEAMS_AUTHENTICATION).toBe("bot");
  });
  it("expands only selected journeys while reusing the target without extra target inventories", () => {
    const service = parseServiceConfig(raw);
    expect(serviceSettings(service, {}, { "send-receive-mail": true, "edit-reopen-draft": true }).probes.map(probe => probe.type))
      .toEqual(["exchange-mail-flow", "exchange-draft"]);
    expect(serviceSettings(service, {}, { "send-receive-mail": false, "edit-reopen-draft": true }).probes.map(probe => probe.type))
      .toEqual(["exchange-draft"]);
  });
  it.each([30, 100])("constructs both Teams journeys for %s channel and meeting targets", count => {
    const service = parseServiceConfig({
      ...raw, type: "teams", cohort: "teams-global",
      targets: Array.from({ length: count }, (_, index) => ({ id: `channel-${index}` })),
      callTargets: Array.from({ length: count }, (_, index) => ({
        id: `call-${index}`, tenantId: "11111111-1111-4111-8111-111111111111",
        meetingThreadId: `19:meeting_test${index}@thread.v2`,
        organizerUserId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
        peerBotClientId: "33333333-3333-4333-8333-333333333333",
      })),
    });
    const config = serviceSettings(service, {}, {
      "channel-conversation": true, "scheduled-meeting": true,
    });
    expect(config.probes).toHaveLength(count * 2);
    for (const type of ["teams-channel-message", "teams-call"]) {
      expect(config.probes.filter(probe => probe.type === type)).toHaveLength(count);
    }
  });
  it.each([null, [], "exchange", { ...raw, unexpected: true }, { ...raw, type: "unknown" }, { ...raw, enabled: "true" }])(
    "rejects invalid top-level JSON objects", value => expect(() => parseServiceConfig(value)).toThrow("Invalid service config"),
  );
  it.each([false, true])("explicitly rejects obsolete reportToHealthModel=%s", reportToHealthModel => {
    expect(() => parseServiceConfig({ ...raw, reportToHealthModel })).toThrow("Invalid service config");
  });
  it.each(["none", "console", "", true])("rejects removed exporter settings %s", telemetry => {
    expect(() => parseServiceConfig({ ...raw, telemetry })).toThrow("Invalid service config");
  });
  it.each(["default", "cli", "", null, true])("rejects unsupported Graph authentication %s", graphAuthentication => {
    expect(() => parseServiceConfig({ ...raw, graphAuthentication })).toThrow("graphAuthentication");
  });
  it.each(["default", "cli", "", null, true])("rejects unsupported health-report authentication %s", healthReportAuthentication => {
    expect(() => parseServiceConfig({ ...raw, healthReportAuthentication })).toThrow("healthReportAuthentication");
  });
  it("keeps Graph and report modes independent in runtime and service-file configs", () => {
    expect(parseServiceConfig({ ...raw, graphAuthentication: "certificate" })).toMatchObject({
      graphAuthentication: "certificate", healthReportAuthentication: "managed-identity",
    });
    const { enabled: _enabled, targets: _targets, ...file } = raw;
    expect(parseServiceExecution({ ...file, healthReportAuthentication: "certificate" })).toMatchObject({
      graphAuthentication: "managed-identity", healthReportAuthentication: "certificate",
    });
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
    { id: "../escape" }, { id: "probe-001", scenario: "invalid" }, { id: "probe-001", channelName: "General" },
  ])("rejects derived, unknown or wrong-service target fields", target => {
    expect(() => parseServiceConfig({ ...raw, targets: [target] })).toThrow("targets");
  });
  it("accepts an optional trimmed Teams channelName for setup tooling and never hands it to probes", () => {
    const teams = parseServiceConfig({
      ...raw, type: "teams", cohort: "teams-global",
      targets: [{ id: "channel-001", channelName: "  United Kingdom Users  " }, { id: "channel-002" }],
    });
    expect(teams.targets).toEqual([{ id: "channel-001", channelName: "United Kingdom Users" }, { id: "channel-002" }]);
    const probes = serviceSettings(teams, {}).probes;
    expect(probes.map(probe => probe.id)).toEqual(["channel-001", "channel-002"]);
    for (const probe of probes) expect(probe).not.toHaveProperty("channelName");
    expect(probeSchema.safeParse({ ...probes[0], channelName: "General" }).success).toBe(false);
  });
  it("accepts a 50-character Teams channelName and rejects blank, longer or non-string values and other targets", () => {
    const teams = { ...raw, type: "teams", cohort: "teams-global" };
    expect(parseServiceConfig({ ...teams, targets: [{ id: "channel-001", channelName: "x".repeat(50) }] }).enabled).toBe(true);
    for (const channelName of ["", "   ", "x".repeat(51), 7, null]) {
      expect(() => parseServiceConfig({ ...teams, targets: [{ id: "channel-001", channelName }] })).toThrow("targets");
    }
    expect(() => parseServiceConfig({ ...raw, type: "onedrive", targets: [{ id: "od-001", channelName: "General" }] })).toThrow("targets");
    expect(() => parseServiceConfig({
      ...teams, callTargets: [{
        id: "call-001", tenantId: "11111111-1111-4111-8111-111111111111", meetingThreadId: "19:meeting_test@thread.v2",
        organizerUserId: "22222222-2222-4222-8222-222222222222", peerBotClientId: "33333333-3333-4333-8333-333333333333",
        channelName: "General",
      }],
    })).toThrow("callTargets");
  });
  it("rejects Exchange fields on OneDrive and accepts its selected account metadata", () => {
    expect(() => parseServiceConfig({ ...raw, type: "onedrive", targets: [{ id: "od-001", mailbox: "test@example.invalid" }] })).toThrow("targets");
    const service = parseServiceConfig({ ...raw, type: "onedrive", mode: "live",
      targets: [{
        id: "od-001", userId: "11111111-1111-4111-8111-111111111111",
        userPrincipalName: "test@example.invalid", folderName: "AHM-Synthetic-Tests", region: "eastus", scenario: "slow",
      }],
    });
    expect(serviceSettings(service, { ENABLE_LIVE_M365: "true" }).probes[0]).toMatchObject({ type: "onedrive-roundtrip", region: "eastus", scenario: "slow" });
  });
  it("requires unique IDs and enabled targets but accepts disabled empty targets", () => {
    expect(() => parseServiceConfig({ ...raw, targets: [{ id: "same" }, { id: "same" }] })).toThrow("unique");
    expect(() => parseServiceConfig({ ...raw, targets: [] })).toThrow("at least one");
    expect(parseServiceConfig({ ...raw, enabled: false, targets: [] }).targets).toEqual([]);
  });
  it("supports a safe Teams simulation and requires actual targets when enabled", () => {
    expect(parseServiceConfig({ ...raw, type: "teams", enabled: false, targets: [] }).type).toBe("teams");
    expect(() => parseServiceConfig({ ...raw, type: "teams", targets: [] })).toThrow("at least one");
    expect(serviceSettings(parseServiceConfig({ ...raw, type: "teams" }), {}).probes[0]?.type)
      .toBe("teams-channel-message");
  });
  it("requires complete, trusted Teams resource configuration in live mode", () => {
    const teams = {
      ...raw, type: "teams", mode: "live", teamsAuthentication: "bot",
      targets: [{
        id: "teams-001",
        tenantId: "11111111-1111-4111-8111-111111111111",
        teamId: "22222222-2222-4222-8222-222222222222",
        channelId: "approved-channel",
        serviceUrl: "https://smba.trafficmanager.net/teams/",
      }],
    };
    const consent = { ENABLE_LIVE_M365: "true" };
    expect(serviceSettings(parseServiceConfig(teams), consent).probes[0]).toMatchObject({
      type: "teams-channel-message", channelId: "approved-channel",
    });
    expect(() => serviceSettings(parseServiceConfig({ ...teams, targets: [{ id: "teams-001" }] }), consent))
      .toThrow("Missing dedicated resources");
    expect(() => serviceSettings(parseServiceConfig({
      ...teams, targets: [{ ...teams.targets[0], serviceUrl: "https://untrusted.invalid/teams/" }],
    }), consent)).toThrow("Unapproved Teams");
    expect(() => parseServiceConfig({
      ...teams, targets: [{ ...teams.targets[0], mailbox: "wrong-service@example.invalid" }],
    })).toThrow("targets");
  });
  it("requires live consent and dedicated resources", () => {
    const service = parseServiceConfig({ ...raw, mode: "live" });
    expect(() => serviceSettings(service, {})).toThrow("ENABLE_LIVE_M365");
    expect(() => serviceSettings(service, { ENABLE_LIVE_M365: "true" })).toThrow("Missing dedicated resources");
    const onedrive = parseServiceConfig({ ...raw, type: "onedrive", mode: "live", targets: [{ id: "od-001" }] });
    expect(() => serviceSettings(onedrive, { ENABLE_LIVE_M365: "true" })).toThrow("Missing dedicated resources");
  });
  it("derives execution settings from JSON and only reads execution knobs from env", () => {
    const config = serviceSettings(parseServiceConfig({ ...raw, type: "onedrive", scenario: "slow" }), {
      EXECUTION_MODE: "live", SYNTHETIC_SCENARIO: "invalid", PROBES_JSON: "not-json", PROBE_TIMEOUT_MS: "invalid", POLL_INTERVAL_MS: "50",
    });
    expect(config).toMatchObject({ EXECUTION_MODE: "simulation", SYNTHETIC_SCENARIO: "slow", PROBE_TIMEOUT_MS: 45000, POLL_INTERVAL_MS: 50 });
    expect(config.probes.every(probe => probe.type === "onedrive-roundtrip")).toBe(true);
    expect(config).not.toHaveProperty("PROBES_JSON");
  });
  it("keeps inventory separate from inline execution for every supported service and mode", () => {
    for (const type of ["exchange", "onedrive", "teams"] as const) {
      for (const mode of ["simulation", "live"] as const) {
        const file = executionFixture(type, mode);
        expect(file).toMatchObject({ type, mode });
        for (const key of ["enabled", "telemetry", "targets"]) expect(file).not.toHaveProperty(key);
      }
    }
  });
  it.each(["enabled", "telemetry", "targets"])("rejects redundant %s in service files rather than silently overriding it", key => {
    const file = {
      type: "exchange", intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation", cohort: "exchange-global",
    };
    expect(() => parseServiceExecution({ ...file, [key]: raw[key as keyof typeof raw] ?? "console" }))
      .toThrow("belong in the root project config");
  });
});
describe("explicit worker arguments", () => {
  it("resolves one canonical root file independently of the caller's working directory", () => {
    expect(parseWorkerArguments([])).toEqual({ config: canonicalProjectFile, once: false });
    expect(parseWorkerArguments(["--once", "--tenant", "contoso"]))
      .toEqual({ config: canonicalProjectFile, once: true, tenant: "contoso" });
    expect(parseWorkerArguments(["--config", "generated-root.json", "--tenant", "contoso"]))
      .toEqual({ config: "generated-root.json", once: false, tenant: "contoso" });
  });
  it.each([
    ["--tenant"], ["--tenant", "--once"], ["--tenant", "a", "--tenant", "b"], ["--config"], ["--config", "--once"],
    ["--config", "a", "--config", "b"], ["--config", "a", "--once", "--once"], ["--config", "a", "--extra"],
    ["--extra", "a"], ["a"],
  ].map(args => ({ args })))(
    "rejects unknown or ambiguous CLI invocation $args", ({ args }) => expect(() => parseWorkerArguments(args)).toThrow("Usage"),
  );
});
