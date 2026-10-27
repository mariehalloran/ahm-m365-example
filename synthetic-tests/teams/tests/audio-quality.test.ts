import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../../utils/src/graph.js";
import { readProjectConfig, parseProjectConfig } from "../../utils/src/project-config.js";
import { parseServiceConfig } from "../../utils/src/service-config.js";
import { reportedResult } from "../../utils/src/contracts.js";
import type { HealthReporter } from "../../utils/src/health-reports.js";
import { parseAudioQualityArguments } from "../src/audio-quality-command.js";
import { runAudioFeasibility } from "../src/audio-quality.js";
import { approvedAudioUrl, validateHostedAudio } from "../src/audio-prompt.js";

const root = await readProjectConfig("../monitoring.config.json");
const primaryId = "66666666-6666-4666-8666-666666666666";
const peerId = "55555555-5555-4555-8555-555555555555";
const chainId = "77777777-7777-4777-8777-777777777777";
const operationId = "88888888-8888-4888-8888-888888888888";
const target = {
  id: "approved-pilot", tenantId: "11111111-1111-4111-8111-111111111111",
  meetingThreadId: "19:meeting_pilot@thread.v2", organizerUserId: "22222222-2222-4222-8222-222222222222",
  peerBotClientId: peerId,
};
const project = parseProjectConfig({
  ...root, healthModel: {
    ...root.healthModel, callQualityThresholds: { packetLossPercent: { degradedAbove: 1, unhealthyAbove: 5 } },
  },
  services: { ...root.services, teams: {
    ...root.services.teams, enabled: true, targets: [], callTargets: [target],
    scenarios: { "channel-conversation": false, "scheduled-meeting": true },
  } },
});
const service = parseServiceConfig({
  type: "teams", enabled: true, mode: "live", intervalSeconds: 120, timeoutSeconds: 45,
  cohort: "teams-global", targets: [], callTargets: [target],
  teamsCallingCallbackUrl: "https://approved.example.com/api/calls",
});
const env = {
  ENABLE_LIVE_M365: "true", BOT_CLIENT_ID: primaryId, TEAMS_CALLING_PEER_CLIENT_ID: peerId,
  BOT_TENANT_ID: target.tenantId, AZURE_TENANT_ID: target.tenantId,
};
const options = {
  audioUrl: "https://cdn.example.com/synthetic.wav?signature=never-log-this",
  acknowledgeTenantWideCallRecords: true, maxWaitSeconds: 3, pollIntervalSeconds: 1,
  playbackTimeoutMs: 2000,
};

function fixture(settings: {
  prompt?: "failed" | "accepted-only" | "ambiguous"; records?: "empty" | "forbidden";
  cancel?: "playback" | "collection"; occupiedPort?: boolean;
} = {}) {
  let clock = 0;
  let recordReads = 0;
  let closed = false;
  const deleted = new Set<string>();
  const controller = new AbortController();
  const telemetry = { emit: vi.fn() };
  let onNotification: ((body: unknown, identity: { botClientId: string }) => void) | undefined;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const peer = new Headers(init?.headers).get("authorization") === "Bearer fake-peer";
    const id = peer ? "peer-call" : "primary-call";
    if (path.includes("/callRecords/")) {
      expect(path).toBe(`/v1.0/communications/callRecords/${chainId}`);
      expect(deleted).toEqual(new Set(["primary-call", "peer-call"]));
      expect(closed).toBe(true);
      if (settings.cancel === "collection") { controller.abort(); controller.signal.throwIfAborted(); }
      if (settings.records === "forbidden") return new Response(null, { status: 403 });
      recordReads++;
      if (recordReads === 1 && settings.records !== "empty") return new Response(null, { status: 404 });
      return Response.json({
        id: chainId, version: recordReads, startDateTime: "2026-10-27T13:00:00.000Z",
        endDateTime: "2026-10-27T13:00:10.000Z",
        sessions: recordReads < 3 || settings.records === "empty" ? [] : [{
          segments: [{ media: [{ label: "main-audio", streams: [{
            audioCodec: "opus", streamDirection: "callerToCallee", averagePacketLossRate: 0, averageJitter: "PT0.01S",
          }] }] }],
        }],
      });
    }
    if (path.endsWith("/playPrompt")) {
      expect(peer).toBe(false);
      expect(deleted.size).toBe(0);
      if (settings.prompt === "ambiguous") throw new Error("ambiguous playback submission");
      const body = JSON.parse(String(init?.body)) as { clientContext: string };
      if (settings.cancel === "playback") controller.abort();
      if (settings.prompt !== "accepted-only") {
        const resource = `/communications/calls/primary-call/operations/${operationId}`;
        onNotification?.({ value: [{
          changeType: "deleted", resourceUrl: resource,
          resourceData: {
            "@odata.type": "#microsoft.graph.playPromptOperation", "@odata.id": resource,
            clientContext: body.clientContext, status: settings.prompt === "failed" ? "Failed" : "Completed", resultInfo: null,
          },
        }] }, { botClientId: primaryId });
      }
      return Response.json({
        "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#communications/calls/operations/$entity",
        id: operationId, clientContext: body.clientContext,
        status: settings.prompt === "accepted-only" ? "Completed" : "Running", resultInfo: null,
      });
    }
    if (path.endsWith("/participants")) return Response.json({ value: [primaryId, peerId].map((id, index) => ({
      id: `participant-${index}`, isInLobby: false, info: { identity: { application: { id } } },
    })) });
    if (init?.method === "POST") return Response.json({ id, callChainId: chainId }, { status: 201 });
    if (init?.method === "DELETE") {
      expect(init.signal?.aborted).toBe(false);
      deleted.add(id);
      return new Response(null, { status: 204 });
    }
    expect(path).toMatch(/^\/v1\.0\/communications\/calls\/(?:primary-call|peer-call)$/);
    return Response.json({
      id, callChainId: chainId, state: deleted.has(id) ? "terminated" : "established",
      chatInfo: { threadId: target.meetingThreadId }, tenantId: target.tenantId,
      meetingInfo: {
        "@odata.type": "#microsoft.graph.organizerMeetingInfo",
        organizer: { user: { id: target.organizerUserId, tenantId: target.tenantId } },
      },
    });
  });
  const graph = (peer: boolean) => new GraphClient({
    getToken: async () => ({ token: peer ? "fake-peer" : "fake-primary", expiresOnTimestamp: Date.now() + 60000 }),
  }, { fetch: fetcher, attempts: 3 });
  const primary = graph(false);
  const peer = graph(true);
  const shutdown = vi.fn(async () => { closed = true; });
  const createRuntime = vi.fn<typeof import("../../utils/src/runtime.js").serviceRuntime>(
    async (_service, _config, _telemetry, _env, _results, hooks) => {
      if (settings.occupiedPort) throw Object.assign(new Error("listen failed"), { code: "EADDRINUSE" });
      onNotification = hooks?.onTeamsCallingNotification;
      return { teamsCalling: primary, teamsCallingPeer: peer, shutdown, telemetry, results: { record: vi.fn(), recordDiagnostic: vi.fn() } };
    },
  );
  const reporter = vi.fn<HealthReporter>(async () => undefined);
  const createReporter = vi.fn(() => reporter);
  const validateAudio = vi.fn(async () => ({ url: options.audioUrl, durationMs: 100, sha256: "synthetic-asset-hash" }));
  return {
    controller, deleted, fetcher, shutdown, createReporter, reporter, telemetry, createRuntime, validateAudio,
    dependencies: {
      env, signal: controller.signal, telemetry, createRuntime, validateAudio, createReporter,
      now: () => clock, sleep: async (ms: number, signal: AbortSignal) => { signal.throwIfAborted(); clock += ms; },
    },
  };
}

describe("finite opt-in hosted audio feasibility", () => {
  it("plays exactly once from the primary, closes both calls/listener, then retries exact-ID 404/empty records without normal health reports", async () => {
    const f = fixture();
    const result = await runAudioFeasibility(project, service, {
      ...options, maxWaitSeconds: 240, pollIntervalSeconds: 60,
    }, f.dependencies);
    expect(result.outcome).toBe("measured");
    expect(result.exitCode).toBe(0);
    expect(result.result?.success).toBe(true);
    expect(reportedResult(result.result!).steps.map(step => step.name)).toEqual([
      "place-call", "wait-for-answer", "verify-meeting-metadata", "verify-participants", "end-call",
    ]);
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes("/playPrompt"))).toHaveLength(1);
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes("/callRecords/"))).toHaveLength(3);
    expect(Date.parse(result.quality!.collectedAt)).toBe(120000);
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes("/operations/"))).toBe(false);
    expect(f.shutdown).toHaveBeenCalledOnce();
    expect(f.createReporter).not.toHaveBeenCalled();
    expect(JSON.stringify(f.telemetry.emit.mock.calls)).not.toContain("never-log-this");
  });
  it("publishes only quality evidence on deliberate opt-in, retaining selected real zero and unselected actual values as diagnostics", async () => {
    const f = fixture();
    const result = await runAudioFeasibility(project, service, { ...options, publish: true }, f.dependencies);
    expect(result.publishedMetrics).toEqual(["packetLossPercent"]);
    expect(f.reporter).toHaveBeenCalledExactlyOnceWith(result.quality);
    expect(f.reporter.mock.calls[0]?.[0]).not.toHaveProperty("results");
    expect(f.telemetry.emit).toHaveBeenCalledWith("teams-audio-feasibility-finished", expect.objectContaining({
      measurements: expect.arrayContaining([
        expect.objectContaining({ metric: "packetLossPercent", value: 0 }),
        expect.objectContaining({ metric: "jitterMs", value: 10 }),
      ]),
    }));
  });
  it.each(["failed", "accepted-only", "ambiguous"] as const)("fails a %s prompt without retrying an ambiguous mutation or blocking either departure", async prompt => {
    const f = fixture({ prompt });
    const result = await runAudioFeasibility(project, service, { ...options, publish: true }, f.dependencies);
    expect(result.outcome).toBe("failed");
    expect(f.deleted).toEqual(new Set(["primary-call", "peer-call"]));
    expect(result.result?.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes("/playPrompt"))).toHaveLength(1);
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes("/callRecords/"))).toBe(false);
    expect(f.createReporter).not.toHaveBeenCalled();
  });
  it.each(["playback", "collection"] as const)("honors cancellation during %s without leaving either call connected", async cancel => {
    const f = fixture({ cancel });
    const result = await runAudioFeasibility(project, service, { ...options, publish: true }, f.dependencies);
    expect(result.outcome).toBe("cancelled");
    expect(result.exitCode).toBe(130);
    expect(f.deleted).toEqual(new Set(["primary-call", "peer-call"]));
    expect(f.shutdown).toHaveBeenCalledOnce();
    expect(f.createReporter).not.toHaveBeenCalled();
  });
  it.each(["empty", "forbidden"] as const)("makes %s quality readback explicit and publishes no placeholder metrics", async records => {
    const f = fixture({ records });
    const result = await runAudioFeasibility(project, service, { ...options, publish: true }, f.dependencies);
    expect(result.outcome).toBe(records === "empty" ? "inconclusive" : "failed");
    expect(result.exitCode).toBe(records === "empty" ? 2 : 1);
    expect(f.createReporter).not.toHaveBeenCalled();
    if (records === "forbidden") expect(f.telemetry.emit).toHaveBeenCalledWith(
      "teams-call-quality-failed", expect.objectContaining({ category: "permission-failure", httpStatus: 403 }),
    );
  });
  it("requires both live execution and explicit tenant-wide read acknowledgement before preflight, credentials or Graph", async () => {
    const f = fixture();
    await expect(runAudioFeasibility(project, service, { ...options, acknowledgeTenantWideCallRecords: false },
      f.dependencies)).rejects.toThrow("tenant-wide");
    await expect(runAudioFeasibility(project, service, options, { ...f.dependencies, env: {} })).rejects.toThrow("ENABLE_LIVE_M365");
    await expect(runAudioFeasibility(project, { ...service, mode: "simulation" }, options, f.dependencies)).rejects.toThrow("live-only");
    expect(f.validateAudio).not.toHaveBeenCalled();
    expect(f.createRuntime).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("never borrows a normal worker's callback listener when the pilot port cannot be bound", async () => {
    const f = fixture({ occupiedPort: true });
    const result = await runAudioFeasibility(project, service, options, f.dependencies);
    expect(result.outcome).toBe("failed");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.telemetry.emit).toHaveBeenCalledWith("teams-audio-feasibility-failed", expect.objectContaining({ callbackError: "EADDRINUSE" }));
  });
});

function wav(): Buffer {
  const audio = Buffer.alloc(44 + 3200);
  audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(3200, 40);
  for (let index = 0; index < 1600; index++) audio.writeInt16LE(Math.round(1000 * Math.sin(index * Math.PI / 8)), 44 + index * 2);
  return audio;
}

describe("approved WAV and command preflight", () => {
  it("validates the public, unauthenticated, nonredirecting PCM asset without persisting or logging its URL", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(wav())));
    const audio = await validateHostedAudio(options.audioUrl, new AbortController().signal, {
      fetch: fetcher, resolveHost: async () => [{ address: "8.8.8.8" }],
    });
    expect(audio.durationMs).toBe(100);
    expect(audio.sha256).toMatch(/^[a-f\d]{64}$/);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });
  it.each([
    "http://cdn.example.com/tone.wav", "https://user:secret@cdn.example.com/tone.wav",
    "https://cdn.example.com/tone.mp3", "https://cdn.example.com/tone.wav#fragment",
  ])("rejects unsafe/non-WAV URL syntax without echoing its contents: %s", url => {
    expect(() => approvedAudioUrl(url)).toThrow("approved public HTTPS WAV");
  });
  it("rejects private DNS and malformed WAV content before creating a calling runtime", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("not a WAV"));
    await expect(validateHostedAudio(options.audioUrl, new AbortController().signal, {
      fetch: fetcher, resolveHost: async () => [{ address: "169.254.169.254" }],
    })).rejects.toThrow("public internet addresses");
    expect(fetcher).not.toHaveBeenCalled();
    const f = fixture();
    await expect(runAudioFeasibility(project, service, options, {
      ...f.dependencies, validateAudio: (url, signal) => validateHostedAudio(url, signal, {
        fetch: fetcher, resolveHost: async () => [{ address: "8.8.8.8" }],
      }),
    })).rejects.toThrow("PCM WAV");
    expect(f.createRuntime).not.toHaveBeenCalled();
  });
  it("defaults to a finite 150-minute pilot, requires acknowledgement and never enables publishing implicitly", () => {
    expect(parseAudioQualityArguments(["--audio-url", options.audioUrl, "--acknowledge-tenant-wide-call-records"])).toMatchObject({
      help: false, options: { maxWaitSeconds: 9000, pollIntervalSeconds: 60, publish: false },
    });
    expect(() => parseAudioQualityArguments(["--audio-url", options.audioUrl])).toThrow("Usage");
    expect(() => parseAudioQualityArguments([
      "--audio-url", options.audioUrl, "--acknowledge-tenant-wide-call-records", "--max-wait-minutes", "181",
    ])).toThrow("Usage");
  });
});
