import { setTimeout as delay } from "node:timers/promises";
import { IntegrationError } from "../../utils/src/integrations/http.js";
import { baseResult, type ProbeContext, type ProbeHandler } from "../../utils/src/execution/probes.js";
import type { GraphFileOperations } from "../../utils/src/integrations/graph.js";
import type { SyntheticResult } from "../../utils/src/contracts.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../../utils/src/execution/steps.js";
import {
  createOwnedFolder, deleteOwnedFolder, downloadFile, findPriorVersion, listVersions,
  openAppFolder, payload, reopenOwnedFile, verifyBytes, writeFile, type FileAttempt, type Payload,
} from "./steps.js";

interface FileWorkflow {
  result: SyntheticResult;
  graph: GraphFileOperations;
  attempt: FileAttempt;
  signal: AbortSignal;
  now: () => number;
  initial: Payload;
  updated: Payload;
}

async function runRoundtrip({ result, graph, attempt, signal, now, initial }: FileWorkflow): Promise<void> {
  const written = await measureStep(result, "create-folder-file", async () => {
    const folder = await createOwnedFolder(graph, attempt, signal);
    return Object.assign(folder, { fileId: await writeFile(graph, folder, initial, signal) });
  }, now);
  const bytes = await measureStep(result, "reopen-file", () => reopenOwnedFile(graph, written, signal), now);
  await measureStep(result, "verify-file-hash", async () => verifyBytes(bytes, initial), now);
  await measureStep(result, "delete-owned-artifacts", () => deleteOwnedFolder(graph, attempt, signal), now);
}

async function runAppFolder({ result, graph, attempt, signal, now, initial, updated }: FileWorkflow): Promise<void> {
  const written = await measureStep(result, "write-app-data", async () => {
    const folder = await openAppFolder(graph, attempt, signal);
    return Object.assign(folder, { fileId: await writeFile(graph, folder, initial, signal, "state.json") });
  }, now);
  await measureStep(result, "read-app-data", async () => {
    verifyBytes(await downloadFile(graph, written, written.fileId, signal), initial);
  }, now);
  await measureStep(result, "update-app-data", async () => {
    const fileId = await writeFile(graph, written, updated, signal, "state.json");
    if (fileId !== written.fileId) throw new IntegrationError("read-failure");
    verifyBytes(await downloadFile(graph, written, fileId, signal), updated);
  }, now);
  await measureStep(result, "delete-app-scratch", () => deleteOwnedFolder(graph, attempt, signal), now);
}

async function runVersionHistory(
  { result, graph, attempt, signal, now, initial, updated }: FileWorkflow,
  context: Pick<ProbeContext, "config" | "sleep">, startedAt: number,
): Promise<void> {
  const written = await measureStep(result, "update-document", async () => {
    const folder = await createOwnedFolder(graph, attempt, signal);
    const written = Object.assign(folder, { fileId: await writeFile(graph, folder, initial, signal) });
    verifyBytes(await downloadFile(graph, written, written.fileId, signal), initial);
    const fileId = await writeFile(graph, written, updated, signal);
    if (fileId !== written.fileId) throw new IntegrationError("read-failure");
    verifyBytes(await downloadFile(graph, written, fileId, signal), updated);
    return written;
  }, now);
  const versions = await measureStep(result, "list-versions", () => listVersions(graph, written, signal), now);
  const earlier = await measureStep(result, "read-prior-version", async () => {
    let observed = versions;
    for (;;) {
      signal.throwIfAborted();
      const found = await findPriorVersion(graph, written, observed, initial, signal);
      if (found) return found;
      if (now() - startedAt >= context.config.PROBE_TIMEOUT_MS - context.config.POLL_INTERVAL_MS) {
        throw new IntegrationError("delivery-timeout");
      }
      await (context.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(context.config.POLL_INTERVAL_MS, signal);
      observed = await listVersions(graph, written, signal);
    }
  }, now);
  if (attempt.probe.restoreVersion) {
    await measureStep(result, "restore-version", async () => {
      const fileId = await writeFile(graph, written, earlier, signal);
      if (fileId !== written.fileId) throw new IntegrationError("read-failure");
      verifyBytes(await downloadFile(graph, written, fileId, signal), earlier);
    }, now);
  } else result.steps.push({
    name: "restore-version", status: "skipped", observedAt: new Date(now()).toISOString(), reason: "variant-disabled",
  });
}

export const oneDriveProbe: ProbeHandler<"onedrive-roundtrip" | "onedrive-appfolder" | "onedrive-versions"> = async (probe, context) => {
  const { signal, telemetry, now = Date.now } = context;
  const startedAt = now();
  const result = baseResult(probe, startedAt);
  const appFolder = probe.type === "onedrive-appfolder";
  const attempt: FileAttempt = {
    probe, correlationId: result.correlationId, driveId: probe.driveId ?? "", parentId: probe.folderId ?? "",
    folderName: `ahm-synthetic-${result.correlationId}`,
    mutationAttempted: false,
  };
  try {
    result.diagnosticContext.testStage = "authentication";
    const graph = await measureStep(result, "authenticate", async () => {
      if (!context.graph) throw new IntegrationError("collector-failure");
      await context.graph.authenticate(signal);
      return context.graph;
    }, now);
    result.diagnosticContext.testStage = "execution";
    if (!appFolder && (!probe.driveId || !probe.folderId)) {
      telemetry.emit("onedrive-journey-blocked", {
        testId: result.testId, correlationId: result.correlationId,
        category: "configuration-failure", blocker: "selected-folder-binding-missing",
        approvalRequired: "Administrator-provided drive/folder IDs and the already-approved write grant on the dedicated test folder.",
      });
      throw new IntegrationError("configuration-failure");
    }
    const workflow: FileWorkflow = {
      result, graph, attempt, signal, now, initial: payload(attempt, 1), updated: payload(attempt, 2),
    };
    switch (probe.type) {
      case "onedrive-roundtrip": await runRoundtrip(workflow); break;
      case "onedrive-appfolder": await runAppFolder(workflow); break;
      case "onedrive-versions": await runVersionHistory(workflow, context, startedAt); break;
    }
    result.success = true;
    result.diagnosticContext.testStage = "complete";
  } catch (error) {
    journeyFailure(result, error, telemetry);
  } finally {
    await cleanupStep(result, attempt.mutationAttempted,
      cleanupSignal => {
        if (!context.graph) throw new IntegrationError("collector-failure");
        return deleteOwnedFolder(context.graph, attempt, cleanupSignal);
      }, telemetry, now, true);
  }
  return finishJourney(result, startedAt, now);
};
