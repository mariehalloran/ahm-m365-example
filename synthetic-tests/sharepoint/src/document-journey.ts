import { setTimeout as delay } from "node:timers/promises";
import type { SharePointDocumentProbe } from "../../utils/src/configuration/resolved-probes.js";
import { baseResult, type ProbeContext, type ProbeHandler } from "../../utils/src/execution/probes.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../../utils/src/execution/steps.js";
import {
  createOwnedFolder, deleteOwnedFolder, downloadFile, findPriorVersion, listVersions,
  reopenOwnedFile, verifyBytes, writeFile, type FileAttempt,
} from "../../utils/src/integrations/drive-files.js";
import type { GraphFileOperations } from "../../utils/src/integrations/graph.js";
import { IntegrationError } from "../../utils/src/integrations/http.js";
import type { SyntheticResult } from "../../utils/src/contracts.js";
import { verifySharePointLibrary, verifySharePointSite } from "./targets.js";

type DocumentPayload = ReturnType<typeof documentPayload>;
interface DocumentWorkflow {
  graph: GraphFileOperations;
  attempt: FileAttempt;
  result: SyntheticResult;
  signal: AbortSignal;
  now: () => number;
  initial: DocumentPayload;
  updated: DocumentPayload;
}

/** Correlates both revision contents to the selected site/library target and this attempt. */
function documentPayload(probe: SharePointDocumentProbe, correlationId: string, revision: 1 | 2) {
  return {
    schemaVersion: "1.0", owner: "ahm-sharepoint", targetId: probe.id, correlationId, revision,
    text: `SharePoint synthetic ${correlationId} revision ${revision}`,
  };
}

/** Completes persisted upload, enumeration, byte verification and verified removal. */
async function documentRoundtrip({ graph, attempt, result, signal, now, initial }: DocumentWorkflow): Promise<void> {
  const written = await measureStep(result, "upload-document", async () => {
    const folder = await createOwnedFolder(graph, attempt, signal);
    return Object.assign(folder, { fileId: await writeFile(graph, folder, initial, signal) });
  }, now);
  const bytes = await measureStep(result, "reopen-document", () => reopenOwnedFile(graph, written, signal), now);
  await measureStep(result, "verify-document-content", async () => verifyBytes(bytes, initial), now);
  await measureStep(result, "delete-document", () => deleteOwnedFolder(graph, attempt, signal), now);
}

/** Requires real version history and exact prior bytes after verifying two distinct persisted revisions. */
async function documentVersions(
  { graph, attempt, result, signal, now, initial, updated }: DocumentWorkflow,
  context: Pick<ProbeContext, "config" | "sleep">,
): Promise<void> {
  const written = await measureStep(result, "write-document-revisions", async () => {
    const folder = await createOwnedFolder(graph, attempt, signal);
    const written = Object.assign(folder, { fileId: await writeFile(graph, folder, initial, signal) });
    verifyBytes(await downloadFile(graph, written, written.fileId, signal), initial);
    const fileId = await writeFile(graph, written, updated, signal);
    if (fileId !== written.fileId) throw new IntegrationError("read-failure");
    verifyBytes(await downloadFile(graph, written, fileId, signal), updated);
    return written;
  }, now);
  const versions = await measureStep(result, "list-document-versions", () => listVersions(graph, written, signal), now);
  await measureStep(result, "read-prior-document-version", async () => {
    let observed = versions;
    for (;;) {
      signal.throwIfAborted();
      if (await findPriorVersion(graph, written, observed, initial, signal)) return;
      await (context.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(context.config.POLL_INTERVAL_MS, signal);
      observed = await listVersions(graph, written, signal);
    }
  }, now);
  await measureStep(result, "delete-version-document", () => deleteOwnedFolder(graph, attempt, signal), now);
}

/** Executes a complete document journey using shared file operations and an independent cleanup window. */
export const sharePointDocumentProbe: ProbeHandler<"sharepoint-roundtrip" | "sharepoint-versions"> = async (probe, context) => {
  const { signal, telemetry, now = Date.now } = context;
  const startedAt = now();
  const result = context.result ?? baseResult(probe, startedAt);
  const attempt: FileAttempt = {
    probe, correlationId: result.correlationId, driveId: probe.driveId, parentId: probe.folderId,
    folderName: `ahm-synthetic-${result.correlationId}`, mutationAttempted: false,
  };
  try {
    result.diagnosticContext.testStage = "authentication";
    const graph = await measureStep(result, "authenticate", async () => {
      if (!context.graph) throw new IntegrationError("collector-failure");
      await context.graph.authenticate(signal);
      return context.graph;
    }, now);
    result.diagnosticContext.testStage = "execution";
    await verifySharePointSite(graph, probe, signal);
    await verifySharePointLibrary(graph, probe, signal);
    const workflow: DocumentWorkflow = {
      graph, attempt, result, signal, now,
      initial: documentPayload(probe, result.correlationId, 1),
      updated: documentPayload(probe, result.correlationId, 2),
    };
    if (probe.type === "sharepoint-roundtrip") await documentRoundtrip(workflow);
    else await documentVersions(workflow, context);
    result.success = true;
    result.diagnosticContext.testStage = "complete";
  } catch (error) {
    journeyFailure(result, error, telemetry);
  } finally {
    context.executionComplete?.();
    await cleanupStep(result, attempt.mutationAttempted, cleanupSignal => {
      if (!context.graph) throw new IntegrationError("collector-failure");
      return deleteOwnedFolder(context.graph, attempt, cleanupSignal);
    }, telemetry, context.config.CLEANUP_TIMEOUT_MS, now);
  }
  return finishJourney(result, startedAt, now);
};
