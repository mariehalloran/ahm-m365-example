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

describe("root-selected two-bot meetings alongside existing messaging", () => {
  it("gates intentional answered playback and rejects obsolete wait/ringing settings", () => {
    const file = {
      type: "teams", intervalSeconds: 120, timeoutSeconds: 45, mode: "simulation", cohort: "teams-global",
    };
    expect(parseServiceFileConfig(file)).toMatchObject({
      teamsCallingPlaybackEnabled: false, teamsCallingAnswerTimeoutSeconds: 20, teamsCallingPlaybackTimeoutSeconds: 10,
    });
    expect(() => parseServiceFileConfig({ ...file, teamsCallingWaitSeconds: 5 })).toThrow("Invalid service config");
    expect(() => parseServiceFileConfig({ ...file, teamsCallingRingSeconds: 10 })).toThrow("Invalid service config");
    expect(() => parseServiceFileConfig({ ...file, teamsCallingAnswerTimeoutSeconds: 0 })).toThrow("teamsCallingAnswerTimeoutSeconds");
  });

  it("publishes hang-up success separately from failed answer and unexecuted playback", () => {
    const probe = serviceProbes(service, project.services.teams.scenarios).find(probe => probe.type === "teams-call")!;
    const result = baseResult(probe, Date.now());
    result.diagnosticCategory = "read-failure";
    const observedAt = new Date().toISOString();
    result.steps = [
      { name: "place-call", status: "succeeded", durationMs: 100, observedAt },
      { name: "wait-for-answer", status: "failed", durationMs: 2000, diagnosticCategory: "delivery-timeout", observedAt },
      { name: "play-audio", status: "skipped", reason: "prerequisite-failed", observedAt },
      { name: "end-call", status: "succeeded", durationMs: 100, observedAt },
    ];
    const reports = aggregateHealthReports("teams", { cycleId: "failed-wait-ended-call", results: [result] }, project.healthModel);
    const success = (entity: string) => reports.find(report =>
      report.entityName === entity && report.body.signalName === "synthetic-success-percentage")?.body;
    expect(success("teams-call")).toMatchObject({ healthState: "Unhealthy", value: 0 });
    expect(success("teams-call-wait-for-answer")).toMatchObject({ healthState: "Unhealthy", value: 0 });
    expect(success("teams-call-play-audio")).toMatchObject({ healthState: "Unknown" });
    expect(success("teams-call-end-call")).toMatchObject({ healthState: "Healthy", value: 100 });
  });
  it("keeps one channel-based journey and one dedicated meeting without channel metadata on calls", () => {
    const probes = serviceProbes(service, project.services.teams.scenarios);
    expect(probes.filter(probe => probe.type === "teams-channel-message")).toHaveLength(1);
    const calls = probes.filter(probe => probe.type === "teams-call");
    expect(calls).toHaveLength(1);
    expect(calls.map(probe => probe.meetingThreadId)).toEqual(project.services.teams.callTargets.map(target => target.meetingThreadId));
    expect(calls.every(probe => !probe.teamId && !probe.channelId && !probe.serviceUrl && !probe.userPrincipalName)).toBe(true);
  });

  it("starts the shared Teams lane immediately with both selected journeys", async () => {
    const controller = new AbortController();
    const execute = vi.fn(runCycle);
    await runServiceWorker(service, {
      project, signal: controller.signal, env: {}, telemetry: { emit: vi.fn() }, execute,
      sleep: async () => { controller.abort(); },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls.map(([config]) => config.probes.map(probe => probe.type))).toEqual([
      ["teams-channel-message", "teams-call"],
    ]);
  });

  it("runs each selected account once in a single cycle without real requests in simulation", async () => {
    const network = vi.fn();
    const results = { record: vi.fn(), recordDiagnostic: vi.fn() };
    const cycle = await runCycle(serviceSettings(service, {}, project.services.teams.scenarios), {
      results, telemetry: { emit: vi.fn() }, handler: network,
    });
    expect(network).not.toHaveBeenCalled();
    expect(cycle.results.filter(result => result.testType === "teams-call")).toHaveLength(1);
    expect(new Set(cycle.results.filter(result => result.testType === "teams-call").map(result => result.testId)).size).toBe(1);
    expect(results.record).toHaveBeenCalledTimes(2);
  });

  it("aggregates binary user attempts and executed actions into seven shared call entities", async () => {
    const config = serviceSettings(service, {}, project.services.teams.scenarios);
    const seed = config.probes.find(probe => probe.type === "teams-call")!;
    const probes = Array.from({ length: 3 }, (_, index) => ({ ...seed, id: `meeting-${index}`,
      meetingThreadId: `19:meeting_selected${index}@thread.v2` }));
    const telemetry = { emit: vi.fn() };
    const successes = await Promise.all(probes.slice(0, 2).map(probe => simulate(probe, {
      config, telemetry, signal: new AbortController().signal,
    })));
    const failed = baseResult(probes[2]!, Date.now());
    failed.diagnosticCategory = "authentication-failure";
    const reports = aggregateHealthReports("teams", { cycleId: "test-cycle", results: [...successes, failed] }, project.healthModel);
    expect(reports).toHaveLength(20);
    expect(new Set(reports.map(report => report.entityName))).toEqual(new Set([
      "teams-call", "teams-call-place-call", "teams-call-wait-for-answer", "teams-call-verify-meeting-metadata",
      "teams-call-verify-participants", "teams-call-play-audio", "teams-call-end-call",
    ]));
    expect(reports.find(report => report.entityName === "teams-call" && report.body.signalName === "synthetic-success-percentage")?.body.value)
      .toBeCloseTo(200 / 3);
    expect(reports.filter(report => report.entityName !== "teams-call" && report.body.signalName === "synthetic-success-percentage")
      .every(report => report.body.value === 100)).toBe(true);
    for (const target of project.services.teams.callTargets) {
      expect(JSON.stringify(reports)).not.toContain(target.id);
      expect(JSON.stringify(reports)).not.toContain(target.organizerUserId);
    }
  });
  it("requires explicit live playback approval and feasible bounded answer/playback budgets", () => {
    const call = serviceProbes(service, project.services.teams.scenarios).find(probe => probe.type === "teams-call")!;
    const env = {
      EXECUTION_MODE: "live", ENABLE_LIVE_M365: "true", PROBES_JSON: JSON.stringify([call]),
      TEAMS_CALLING_CALLBACK_URL: "https://approved.example.invalid/api/calls", PROBE_TIMEOUT_MS: "45000",
      BOT_CLIENT_ID: "66666666-6666-4666-8666-666666666666", TEAMS_CALLING_PEER_CLIENT_ID: call.peerBotClientId,
    };
    expect(() => loadConfig(env)).toThrow("PLAYBACK_ENABLED");
    expect(loadConfig({ ...env, TEAMS_CALLING_PLAYBACK_ENABLED: "true" }).PROBE_TIMEOUT_MS).toBe(45000);
    expect(() => loadConfig({ ...env, TEAMS_CALLING_PLAYBACK_ENABLED: "true", PROBE_TIMEOUT_MS: "30000" })).toThrow("budgets");
    expect(() => loadConfig({ ...env, TEAMS_CALLING_WAIT_SECONDS: "10" })).toThrow("Obsolete");
  });

  it("disables calls independently without disabling or multiplying messaging", () => {
    const probes = serviceProbes(service, { ...project.services.teams.scenarios, "scheduled-meeting": false });
    expect(probes.map(probe => probe.type)).toEqual(["teams-channel-message"]);
  });
  it("executes every selected dedicated meeting once, retaining only aggregate sample counts", async () => {
    const selected = parseProjectConfig({ ...project, services: { ...project.services, teams: {
      ...project.services.teams, callTargets: Array.from({ length: 4 }, (_, index) => ({
        ...project.services.teams.callTargets[0], id: `meeting-${index}`, meetingThreadId: `19:meeting_${index}@thread.v2`,
      })),
    } } });
    const configured = { ...service, callTargets: selected.services.teams.callTargets };
    const cycle = await runCycle(serviceSettings(configured, {}, { "scheduled-meeting": true }), {
      results: { record: vi.fn(), recordDiagnostic: vi.fn() }, telemetry: { emit: vi.fn() },
    });
    expect(cycle.results.map(result => result.testId)).toEqual(["meeting-0", "meeting-1", "meeting-2", "meeting-3"]);
    const reports = aggregateHealthReports("teams", cycle, project.healthModel);
    expect(reports.find(report => report.entityName === "teams-call" &&
      report.body.signalName === "synthetic-success-percentage")?.body.value).toBe(100);
    // Target-ID leakage check; distinct from the legitimate "verify-meeting-*" step/entity vocabulary.
    expect(JSON.stringify(reports)).not.toMatch(/meeting-\d/);
  });
  it.each([
    { BOT_CLIENT_ID: undefined },
    { TEAMS_CALLING_PEER_CLIENT_ID: undefined },
    { TEAMS_CALLING_PEER_CLIENT_ID: "66666666-6666-4666-8666-666666666666" },
    { TEAMS_CALLING_PEER_CLIENT_ID: "77777777-7777-4777-8777-777777777777" },
    { BOT_AUTHENTICATION: "certificate" },
  ])("rejects missing or mismatched explicit meeting identities before I/O: %j", overrides => {
    const call = serviceProbes(service, project.services.teams.scenarios).find(probe => probe.type === "teams-call")!;
    expect(() => loadConfig({
      EXECUTION_MODE: "live", ENABLE_LIVE_M365: "true", PROBES_JSON: JSON.stringify([call]),
      TEAMS_CALLING_PLAYBACK_ENABLED: "true", TEAMS_CALLING_CALLBACK_URL: "https://approved.example.invalid/api/calls",
      BOT_CLIENT_ID: "66666666-6666-4666-8666-666666666666", TEAMS_CALLING_PEER_CLIENT_ID: call.peerBotClientId,
      ...overrides,
    })).toThrow("BOT_AUTHENTICATION" in overrides ? "BOT_AUTHENTICATION" : "two distinct explicit managed identities");
  });
  it("rejects obsolete human call targets with migration guidance", () => {
    expect(() => loadConfig({ PROBES_JSON: JSON.stringify([{
      id: "legacy", type: "teams-call", cohort: "teams-global", callUserId: "11111111-1111-4111-8111-111111111111",
    }]) })).toThrow("Obsolete callUserId");
    expect(() => parseProjectConfig({ ...project, services: { ...project.services, teams: {
      ...project.services.teams, callTargets: [{
        ...project.services.teams.callTargets[0], callUserId: "11111111-1111-4111-8111-111111111111",
      }],
    } } })).toThrow("Obsolete callUserId");
  });

  it("rejects duplicate users, missing call targets, arbitrary channel targets and obsolete meeting fields", () => {
    const root = structuredClone(project);
    root.services.teams.callTargets.push({ ...root.services.teams.callTargets[0]!, id: "duplicate-meeting" });
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
