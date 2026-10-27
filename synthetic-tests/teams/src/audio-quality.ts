import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../utils/src/config.js";
import { consoleTelemetry, type SyntheticResult, type Telemetry } from "../../utils/src/contracts.js";
import { callQualityMeasurements, createHealthReporter, type CallQualityCycle } from "../../utils/src/health-reports.js";
import { categoryOf, IntegrationError } from "../../utils/src/http.js";
import type { ProjectConfig } from "../../utils/src/project-config.js";
import { serviceRuntime } from "../../utils/src/runtime.js";
import { serviceSettings, type ServiceConfig } from "../../utils/src/service-config.js";
import {
  audioQualityCollectionSettings, collectAudioFeasibilityQuality,
} from "../../utils/src/teams-call-quality-collection.js";
import { TeamsCallOperations } from "../../utils/src/teams-call-operations.js";
import { playHostedAudio, validateHostedAudio } from "./audio-prompt.js";
import { createTeamsCallProbe } from "./call.js";

export interface AudioFeasibilityOptions {
  audioUrl: string;
  targetId?: string;
  acknowledgeTenantWideCallRecords: boolean;
  publish?: boolean;
  maxWaitSeconds?: number;
  pollIntervalSeconds?: number;
  playbackTimeoutMs?: number;
}
export interface AudioFeasibilityResult {
  outcome: "measured" | "partial" | "inconclusive" | "failed" | "cancelled";
  exitCode: 0 | 1 | 2 | 130;
  publishedMetrics: string[];
  result?: SyntheticResult;
  quality?: CallQualityCycle;
}

export async function runAudioFeasibility(
  project: ProjectConfig, service: ServiceConfig, options: AudioFeasibilityOptions,
  dependencies: {
    env?: NodeJS.ProcessEnv;
    telemetry?: Telemetry;
    signal?: AbortSignal;
    now?: () => number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    createRuntime?: typeof serviceRuntime;
    validateAudio?: typeof validateHostedAudio;
    collectQuality?: typeof collectAudioFeasibilityQuality;
    createReporter?: typeof createHealthReporter;
  } = {},
): Promise<AudioFeasibilityResult> {
  const {
    env = process.env, telemetry = consoleTelemetry, signal = new AbortController().signal, now = Date.now, sleep,
  } = dependencies;
  if (env.ENABLE_LIVE_M365 !== "true" || service.mode !== "live") {
    throw new ConfigurationError("Audio feasibility is live-only and requires ENABLE_LIVE_M365=true");
  }
  if (options.acknowledgeTenantWideCallRecords !== true) {
    throw new ConfigurationError("Audio feasibility requires --acknowledge-tenant-wide-call-records for tenant-wide CallRecords.Read.All");
  }
  if (service.type !== "teams" || !service.enabled || !project.services.teams.enabled ||
      !project.services.teams.scenarios["scheduled-meeting"]) {
    throw new ConfigurationError("Audio feasibility requires an enabled root-selected Teams scheduled-meeting");
  }
  const target = options.targetId ? service.callTargets.find(target => target.id === options.targetId)
    : service.callTargets.length === 1 ? service.callTargets[0] : undefined;
  if (!target || !project.services.teams.callTargets.some(approved => approved.id === target.id &&
      approved.tenantId.toLowerCase() === target.tenantId.toLowerCase() && approved.meetingThreadId === target.meetingThreadId &&
      approved.organizerUserId.toLowerCase() === target.organizerUserId.toLowerCase() &&
      approved.peerBotClientId.toLowerCase() === target.peerBotClientId.toLowerCase())) {
    throw new ConfigurationError("Select exactly one root-approved dedicated meeting with --target-id");
  }
  const collectionSettings = audioQualityCollectionSettings(options);
  const playbackTimeoutMs = options.playbackTimeoutMs ?? 15000;
  if (!Number.isInteger(playbackTimeoutMs) || playbackTimeoutMs < 1000 || playbackTimeoutMs > 30000) {
    throw new ConfigurationError("Audio playback timeout must be between 1000 and 30000 milliseconds");
  }
  const config = serviceSettings({ ...service, targets: [], callTargets: [target] }, env, { "scheduled-meeting": true });
  const audio = await (dependencies.validateAudio ?? validateHostedAudio)(options.audioUrl, signal);
  if (audio.durationMs >= playbackTimeoutMs) throw new ConfigurationError("Approved WAV must be shorter than the playback timeout");
  telemetry.emit("teams-audio-feasibility-started", {
    targetId: target.id, maxWaitSeconds: collectionSettings.maxWaitSeconds,
    pollIntervalSeconds: collectionSettings.pollIntervalSeconds, publish: options.publish === true,
    audioSha256: audio.sha256, tenantWideCallRecordsAcknowledged: true,
  });
  const operations = new TeamsCallOperations(now);
  let runtime: Awaited<ReturnType<typeof serviceRuntime>> | undefined;
  let result: SyntheticResult | undefined;
  let playbackCompleted = false;
  try {
    try {
      signal.throwIfAborted();
      runtime = await (dependencies.createRuntime ?? serviceRuntime)(service, config, telemetry, env, undefined, {
        onTeamsCallingNotification: (notification, identity) => operations.accept(notification, identity),
      });
      const handler = createTeamsCallProbe(async call => {
        try {
          const operationId = await playHostedAudio(call, audio, operations, config.BOT_CLIENT_ID!, playbackTimeoutMs, now, sleep);
          playbackCompleted = true;
          telemetry.emit("teams-audio-prompt-completed", { operationId, evidence: "authenticated-operation-not-received-audio" });
        } catch (error) {
          telemetry.emit("teams-audio-prompt-failed", { category: signal.aborted ? "cancelled" : categoryOf(error) });
          throw error;
        }
      });
      result = await handler(config.probes[0]!, {
        config, signal, telemetry, now, ...(sleep ? { sleep } : {}),
        ...(runtime.teamsCalling ? { teamsCalling: runtime.teamsCalling } : {}),
        ...(runtime.teamsCallingPeer ? { teamsCallingPeer: runtime.teamsCallingPeer } : {}),
      });
    } finally {
      operations.shutdown();
      // No callback listener or connected call is needed during delayed exact-ID readback.
      await runtime?.shutdown?.();
    }
    if (!playbackCompleted || !result.success || !result.call?.endedAt ||
        result.diagnosticContext.cleanupSucceeded !== true) {
      const outcome = signal.aborted ? "cancelled" : "failed";
      telemetry.emit("teams-audio-feasibility-finished", {
        outcome, category: result.diagnosticCategory, cleanupSucceeded: result.diagnosticContext.cleanupSucceeded,
        qualityReadback: "skipped", publishedMetrics: [],
      });
      return { outcome, exitCode: signal.aborted ? 130 : 1, result, publishedMetrics: [] };
    }
    signal.throwIfAborted();
    const quality = await (dependencies.collectQuality ?? collectAudioFeasibilityQuality)(
      { cycleId: randomUUID(), results: [result] }, runtime.teamsCalling,
      { ...collectionSettings, acknowledgeTenantWideCallRecords: true }, telemetry, signal, now, sleep,
    );
    signal.throwIfAborted();
    const measurements = callQualityMeasurements(quality).filter(measurement => measurement.value !== undefined);
    const failed = quality.callQuality.some(sample => sample.status === "failed");
    const outcome = failed ? "failed" : !measurements.length ? "inconclusive"
      : measurements.every(measurement => measurement.complete) ? "measured" : "partial";
    const selected = measurements.filter(measurement => Object.hasOwn(project.healthModel.callQualityThresholds, measurement.metric));
    const publishedMetrics: string[] = [];
    if (options.publish && selected.length && outcome !== "failed") {
      await (dependencies.createReporter ?? createHealthReporter)(project, service, telemetry, env)(quality);
      publishedMetrics.push(...selected.map(measurement => measurement.metric));
    }
    telemetry.emit("teams-audio-feasibility-finished", {
      outcome, measurements, selectedMetrics: selected.map(measurement => measurement.metric), publishedMetrics,
      ...(!measurements.length ? { reason: "no-populated-audio-quality-metrics" } : {}),
      ...(options.publish && !publishedMetrics.length ? { publication: "skipped-no-selected-measurements-or-failed-pilot" } : {}),
    });
    return {
      outcome, exitCode: outcome === "measured" ? 0 : outcome === "failed" ? 1 : 2,
      result, quality, publishedMetrics,
    };
  } catch (error) {
    const callbackError = error instanceof Error && "code" in error && ["EADDRINUSE", "EACCES"].includes(String(error.code))
      ? String(error.code) : undefined;
    telemetry.emit("teams-audio-feasibility-failed", {
      category: signal.aborted ? "cancelled" : categoryOf(error),
      ...(error instanceof IntegrationError && error.status !== undefined ? { httpStatus: error.status } : {}),
      ...(callbackError ? {
        callbackError, reason: "Pilot must exclusively own its callback port and approved public routing; stop the normal worker",
      } : {}),
      publishedMetrics: [],
    });
    return {
      outcome: signal.aborted ? "cancelled" : "failed", exitCode: signal.aborted ? 130 : 1,
      ...(result ? { result } : {}), publishedMetrics: [],
    };
  }
}
