import { IntegrationError } from "../../utils/src/http.js";
import { baseResult, type ProbeHandler } from "../../utils/src/probes.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../../utils/src/steps.js";
import { authenticate, cleanup, readFile, uploadFile, verifyDrive, type FileAttempt } from "./steps.js";

export const sharepointProbe: ProbeHandler = async (probe, context) => {
  const { signal, telemetry, now = Date.now } = context;
  const startedAt = now();
  const result = baseResult(probe, startedAt);
  const attempt: FileAttempt = {
    siteId: probe.siteId ?? "", driveId: probe.driveId ?? "", folderId: probe.folderId ?? "",
    correlationId: result.correlationId, mutationAttempted: false,
  };
  try {
    result.diagnosticContext.testStage = "authentication";
    const graph = await measureStep(result, "authenticate", async () => {
      if (!probe.siteId || !probe.driveId || !probe.folderId) throw new IntegrationError("collector-failure");
      return authenticate(context.graph, signal);
    }, now);
    result.diagnosticContext.authenticationDurationMs = Math.max(0, now() - startedAt);
    await measureStep(result, "verify-drive", () => verifyDrive(graph, attempt, signal), now);
    result.diagnosticContext.testStage = "upload";
    const uploadStarted = now();
    let fileId: string;
    try {
      fileId = await measureStep(result, "upload-file", () => uploadFile(graph, attempt, signal), now);
    } finally { result.uploadDurationMs = Math.max(0, now() - uploadStarted); }
    result.diagnosticContext.testStage = "download";
    const readStarted = now();
    try {
      await measureStep(result, "read-file", () => readFile(graph, attempt, fileId, signal), now);
    } finally { result.readDurationMs = Math.max(0, now() - readStarted); }
    result.success = true;
    result.diagnosticContext.testStage = "complete";
  } catch (error) {
    journeyFailure(result, error, telemetry);
  } finally {
    await cleanupStep(result, attempt.mutationAttempted,
      cleanupSignal => cleanup(context.graph!, attempt, cleanupSignal), telemetry, now);
  }
  return finishJourney(result, startedAt, now);
};
