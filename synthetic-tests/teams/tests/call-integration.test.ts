import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../utils/src/config.js";
import { aggregateHealthReports } from "../../utils/src/health-reports.js";
import { parseProjectConfig, readProjectConfig, readProjectService } from "../../utils/src/project-config.js";
import { baseResult, simulate } from "../../utils/src/probes.js";
import { runCycle } from "../../utils/src/runner.js";
import { parseServiceFileConfig, serviceProbes, serviceSettings } from "../../utils/src/service-config.js";
import { runServiceWorker } from "../../utils/src/worker.js";

const project = await readProjectConfig("../monitoring.config.json");
const { service } = await readProjectService("teams", "../monitoring.config.json");

describe("root-selected individual calls alongside existing messaging", () => {
  it("uses an explicit wait setting and rejects the obsolete ringing execution setting", () => {
    const file = {
      type: "teams", intervalSeconds: 120, timeoutSeconds: 45, mode: "simulation", cohort: "teams-global",
    };
    expect(parseServiceFileConfig(file).teamsCallingWaitSeconds).toBe(10);
    expect(parseServiceFileConfig({ ...file, teamsCallingWaitSeconds: 5 }).teamsCallingWaitSeconds).toBe(5);
    expect(() => parseServiceFileConfig({ ...file, teamsCallingRingSeconds: 10 })).toThrow("Invalid service config");
    expect(() => parseServiceFileConfig({ ...file, teamsCallingWaitSeconds: 0 })).toThrow("teamsCallingWaitSeconds");
  });

  it("publishes executed hang-up success separately from a failed wait, without repairing journey health", () => {
    const probe = serviceProbes(service, project.services.teams.scenarios).find(probe => probe.type === "teams-call")!;
    const result = baseResult(probe, Date.now());
    result.diagnosticCategory = "read-failure";
    const observedAt = new Date().toISOString();
    result.steps = [
      { name: "place-call", status: "succeeded", durationMs: 100, observedAt },
      { name: "wait-before-hangup", status: "failed", durationMs: 2000, diagnosticCategory: "read-failure", observedAt },
      { name: "end-call", status: "succeeded", durationMs: 100, observedAt },
    ];
    const reports = aggregateHealthReports("teams", { cycleId: "failed-wait-ended-call", results: [result] }, project.healthModel);
    const success = (entity: string) => reports.find(report =>
      report.entityName === entity && report.body.signalName === "synthetic-success-percentage")?.body;
    expect(success("teams-call")).toMatchObject({ healthState: "Unhealthy", value: 0 });
    expect(success("teams-call-wait-before-hangup")).toMatchObject({ healthState: "Unhealthy", value: 0 });
    expect(success("teams-call-end-call")).toMatchObject({ healthState: "Healthy", value: 100 });
  });
  it("keeps one channel and three independent users without channel metadata on calls", () => {
    const probes = serviceProbes(service, project.services.teams.scenarios);
    expect(probes.filter(probe => probe.type === "teams-channel-message")).toHaveLength(1);
    expect(probes.filter(probe => probe.type === "teams-channel-reply")).toHaveLength(1);
    const calls = probes.filter(probe => probe.type === "teams-call");
    expect(calls).toHaveLength(3);
    expect(calls.map(probe => probe.callUserId)).toEqual(project.services.teams.callTargets.map(target => target.callUserId));
    expect(calls.every(probe => !probe.teamId && !probe.channelId && !probe.serviceUrl && !probe.userPrincipalName)).toBe(true);
  });

  it("recurs immediately on the ordinary schedule without an approval gate and keeps messaging", async () => {
    const controller = new AbortController();
    const execute = vi.fn(runCycle);
    let sleeps = 0;
    await runServiceWorker(service, {
      project, signal: controller.signal, env: {}, telemetry: { emit: vi.fn() }, execute,
      sleep: async () => { if (++sleeps === 2) controller.abort(); },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    for (const [config] of execute.mock.calls) {
      expect(config.probes.map(probe => probe.type)).toEqual([
        "teams-channel-message", "teams-channel-reply", "teams-call", "teams-call", "teams-call",
      ]);
    }
  });

  it("runs each selected account once in a single cycle without real requests in simulation", async () => {
    const network = vi.fn();
    const results = { record: vi.fn(), recordDiagnostic: vi.fn() };
    const cycle = await runCycle(serviceSettings(service, {}, project.services.teams.scenarios), {
      results, telemetry: { emit: vi.fn() }, handler: network,
    });
    expect(network).not.toHaveBeenCalled();
    expect(cycle.results.filter(result => result.testType === "teams-call")).toHaveLength(3);
    expect(new Set(cycle.results.filter(result => result.testType === "teams-call").map(result => result.testId)).size).toBe(3);
    expect(results.record).toHaveBeenCalledTimes(5);
  });

  it("aggregates binary user attempts and only executed actions into four shared call entities", async () => {
    const config = serviceSettings(service, {}, project.services.teams.scenarios);
    const probes = config.probes.filter(probe => probe.type === "teams-call");
    const telemetry = { emit: vi.fn() };
    const successes = await Promise.all(probes.slice(0, 2).map(probe => simulate(probe, {
      config, telemetry, signal: new AbortController().signal,
    })));
    const failed = baseResult(probes[2]!, Date.now());
    failed.diagnosticCategory = "authentication-failure";
    const reports = aggregateHealthReports("teams", { cycleId: "test-cycle", results: [...successes, failed] }, project.healthModel);
    expect(reports).toHaveLength(8);
    expect(new Set(reports.map(report => report.entityName))).toEqual(new Set([
      "teams-call", "teams-call-place-call", "teams-call-wait-before-hangup", "teams-call-end-call",
    ]));
    expect(reports.find(report => report.entityName === "teams-call" && report.body.signalName === "synthetic-success-percentage")?.body.value)
      .toBeCloseTo(200 / 3);
    expect(reports.filter(report => report.entityName !== "teams-call" && report.body.signalName === "synthetic-success-percentage")
      .every(report => report.body.value === 100)).toBe(true);
    for (const target of project.services.teams.callTargets) {
      expect(JSON.stringify(reports)).not.toContain(target.id);
      expect(JSON.stringify(reports)).not.toContain(target.callUserId);
    }
  });

  it("disables calls independently without disabling or multiplying messaging", () => {
    const probes = serviceProbes(service, { ...project.services.teams.scenarios, "call-test-user": false });
    expect(probes.map(probe => probe.type)).toEqual(["teams-channel-message", "teams-channel-reply"]);
  });

  it("rejects duplicate users, missing call targets, arbitrary channel targets and obsolete meeting fields", () => {
    const root = structuredClone(project);
    root.services.teams.callTargets[1]!.callUserId = root.services.teams.callTargets[0]!.callUserId;
    expect(() => parseProjectConfig(root)).toThrow("unique");
    root.services.teams.callTargets = [];
    expect(() => parseProjectConfig(root)).toThrow("root-configured callTargets");
    expect(() => parseProjectConfig({
      ...project, services: { ...project.services, teams: {
        ...project.services.teams, callTargets: [{ id: "invalid", teamId: "private-value" }],
      } },
    })).toThrow("Invalid project config");
    const call = serviceProbes(service, project.services.teams.scenarios).find(probe => probe.type === "teams-call")!;
    const env = { EXECUTION_MODE: "live", ENABLE_LIVE_M365: "true", PROBES_JSON: JSON.stringify([call]) };
    expect(() => loadConfig(env)).toThrow("Missing dedicated resources");
    expect(() => loadConfig({
      ...env, TEAMS_CALLING_CALLBACK_URL: "http://unapproved.invalid/api/calls",
    })).toThrow("TEAMS_CALLING_CALLBACK_URL");
    expect(() => loadConfig({
      PROBES_JSON: JSON.stringify([{ ...call, meetingThreadId: "obsolete" }]),
    })).toThrow("Invalid PROBES_JSON");
  });
});
