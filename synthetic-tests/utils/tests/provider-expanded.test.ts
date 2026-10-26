import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeProviders } from "../../exchange/src/providers.js";
import { teamsProviders } from "../../teams/src/providers.js";
import { GraphClient } from "../src/graph.js";
import { serviceActivityReports } from "../src/health-reports.js";
import { AuthenticatedHttp } from "../src/http.js";
import { activityFunctions, isPercentageActivity } from "../src/provider-catalog.js";
import type { ProviderDiagnostic } from "../src/provider-diagnostics.js";
import { parseServiceConfig } from "../src/service-config.js";

afterEach(() => vi.restoreAllMocks());
const now = Date.parse("2026-10-26T12:30:00Z");
function service(type: "exchange" | "teams", thresholds = {}) {
  return parseServiceConfig({
    type, enabled: true, mode: "live", intervalSeconds: 60, timeoutSeconds: 45, cohort: `${type}-global`,
    serviceActivity: { enabled: true, thresholds },
    targets: [{ id: "one", ...(type === "exchange" ? { mailbox: "owned@example.invalid" } : {}) }],
  });
}

describe("all approved Exchange/Teams beta provider functions", () => {
  it.each(["exchange", "teams"] as const)("collects all five %s functions independently with correct units and no synthetic samples", async type => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const config = service(type);
    const records: ProviderDiagnostic[] = [];
    const paths: string[] = [];
    const graph = new GraphClient(new AuthenticatedHttp({
      getToken: async () => ({ token: "unit-test-token", expiresOnTimestamp: now + 100000 }),
    }, "https://graph.microsoft.com/.default", {
      fetch: async url => {
        paths.push(String(url));
        const name = activityFunctions[type].find(name => String(url).includes(name))!;
        expect(name).toBeDefined();
        return new Response(JSON.stringify({
          value: [{ intervalStartDateTime: "2026-10-26T12:15:00Z", ...(isPercentageActivity(name) ? { percentage: 97 } : { value: 120 }) }],
        }));
      },
    }));
    const summary = await (type === "exchange" ? exchangeProviders : teamsProviders)({
      service: config, graph, signal: new AbortController().signal,
      results: { recordDiagnostic: record => { records.push(record); } }, now: () => now,
    });
    expect(summary).toMatchObject({ configured: 5, succeeded: 5, failed: 0, records: 5 });
    expect(paths).toHaveLength(5);
    expect(paths.every(path => path.startsWith("https://graph.microsoft.com/beta/reports/serviceActivity/"))).toBe(true);
    expect(records.filter(record => record.kind === "activity")).toHaveLength(5);
    expect(serviceActivityReports(config, { cycleId: "provider-only", providerDiagnostics: records }, 15, now)).toEqual([]);
    expect(config.providerIntervalSeconds).toBe(300);
  });

  it("uses only the latest fresh completed percentage bucket and configured thresholds", () => {
    const config = service("exchange", { getConnectivityMetricsForExchange: { degradedBelow: 99, unhealthyBelow: 95 } });
    const row = (intervalStart: string, percentage: number): ProviderDiagnostic => ({
      kind: "activity", service: "exchange", function: "getConnectivityMetricsForExchange",
      collectedAt: new Date(now).toISOString(), intervalStart,
      intervalEnd: new Date(Date.parse(intervalStart) + 15 * 60000).toISOString(),
      aggregationIntervalMinutes: 15, percentage,
    });
    const reports = serviceActivityReports(config, {
      cycleId: "provider-cycle", providerDiagnostics: [row("2026-10-26T12:00:00Z", 100), row("2026-10-26T12:15:00Z", 97)],
    }, 15, now);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      entityName: "exchange-service-health", body: {
        signalName: "microsoft-activity-getConnectivityMetricsForExchange", value: 97, healthState: "Degraded",
      },
    });
    for (const rows of [
      [],
      [row("2026-10-26T10:00:00Z", 100)],
      [row("2026-10-26T12:30:00Z", 100)],
      [row("2026-10-26T12:15:00Z", 100), row("2026-10-26T12:15:00Z", 100)],
      [{ ...row("2026-10-26T12:15:00Z", 100), percentage: undefined } as ProviderDiagnostic],
    ]) {
      const stale = serviceActivityReports(config, { cycleId: "no-valid-data", providerDiagnostics: rows }, 15, now)[0]!;
      expect(stale.body.healthState).toBe("Unknown");
      expect(stale.body).not.toHaveProperty("value");
    }
  });

  it("leaves counts and Teams percentages diagnostic by default, only reporting with explicit customer thresholds", () => {
    const config = service("teams", {
      getUsageMetricsForTeamsByMeetingsJoined: { degradedBelow: 5, unhealthyBelow: 1 },
      getAudioStreamQoEMetricsForTeams: { degradedBelow: 95, unhealthyBelow: 80 },
    });
    const providerDiagnostics: ProviderDiagnostic[] = [
      { kind: "activity", service: "teams", function: "getUsageMetricsForTeamsByMeetingsJoined",
        collectedAt: new Date(now).toISOString(), intervalStart: "2026-10-26T12:15:00Z",
        intervalEnd: new Date(now).toISOString(), aggregationIntervalMinutes: 15, value: 3 },
      { kind: "activity", service: "teams", function: "getAudioStreamQoEMetricsForTeams",
        collectedAt: new Date(now).toISOString(), intervalStart: "2026-10-26T12:15:00Z",
        intervalEnd: new Date(now).toISOString(), aggregationIntervalMinutes: 15, percentage: 70 },
    ];
    const reports = serviceActivityReports(config, { cycleId: "thresholds", providerDiagnostics }, 15, now);
    expect(reports.map(report => report.body.healthState)).toEqual(["Degraded", "Unhealthy"]);
    expect(reports.every(report => report.entityName === "teams-service-health")).toBe(true);
    expect(reports[1]?.body.additionalContext).toContain("telemetry-coverage-not-call-quality");
  });

  it("rejects duplicate/wrong-service functions and inverted/invalid percentage thresholds", () => {
    const config = service("exchange");
    for (const serviceActivity of [
      { functions: ["getConnectivityMetricsForExchange", "getConnectivityMetricsForExchange"] },
      { functions: ["getAudioStreamQoEMetricsForTeams"] },
      { thresholds: { getConnectivityMetricsForExchange: { degradedBelow: 101, unhealthyBelow: 95 } } },
      { thresholds: { getConnectivityMetricsForExchange: { degradedBelow: 90, unhealthyBelow: 95 } } },
    ]) expect(() => parseServiceConfig({ ...config, serviceActivity })).toThrow();
  });
});
