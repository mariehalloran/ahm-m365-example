import { setTimeout as delay } from "node:timers/promises";
import { IntegrationError } from "../../utils/src/http.js";
import { baseResult, type ProbeHandler } from "../../utils/src/probes.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../../utils/src/steps.js";
import {
  createOwnedFolder, deleteOwnedFolder, deleteScratch, downloadFile, findPriorVersion, listVersions,
  openAppFolder, payload, reopenOwnedFile, verifyBytes, verifyPersistedState, writeFile, type FileAttempt,
} from "./steps.js";

export const oneDriveProbe: ProbeHandler = async (probe, context) => {
  const { signal, telemetry, now = Date.now } = context;
  const startedAt = now();
  const result = baseResult(probe, startedAt);
  const persistent = probe.type === "onedrive-appfolder";
  const attempt: FileAttempt = {
    probe, correlationId: result.correlationId, driveId: probe.driveId ?? "", parentId: probe.folderId ?? "",
    folderName: persistent ? `${probe.folderName}-${probe.id}` : `ahm-synthetic-${result.correlationId}`,
    mutationAttempted: false,
  };
  try {
    result.diagnosticContext.testStage = "authentication";
    const graph = await measureStep(result, "authenticate", async () => {
      if (!context.graph) throw new IntegrationError("collector-failure");
      if (!probe.userId || !probe.userPrincipalName || !probe.folderName ||
          !["onedrive-roundtrip", "onedrive-appfolder", "onedrive-versions"].includes(probe.type)) {
        throw new IntegrationError("configuration-failure");
      }
      await context.graph.authenticate(signal);
      return context.graph;
    }, now);
    result.diagnosticContext.testStage = "execution";
    if (!persistent && (!probe.driveId || !probe.folderId)) throw new IntegrationError("configuration-failure");
    const initial = payload(attempt, 1);
    const updated = payload(attempt, 2);
    if (probe.type === "onedrive-roundtrip") {
      await measureStep(result, "create-folder-file", async () => {
        await createOwnedFolder(graph, attempt, signal);
        attempt.fileId = await writeFile(graph, attempt, initial, signal);
      }, now);
      const bytes = await measureStep(result, "reopen-file", () => reopenOwnedFile(graph, attempt, signal), now);
      await measureStep(result, "verify-file-hash", async () => verifyBytes(bytes, initial), now);
      await measureStep(result, "delete-owned-artifacts", () => deleteOwnedFolder(graph, attempt, signal), now);
    } else if (persistent) {
      await measureStep(result, "write-app-data", async () => {
        await openAppFolder(graph, attempt, signal);
        await verifyPersistedState(graph, attempt, signal);
        attempt.fileId = await writeFile(graph, attempt, initial, signal, "state.json");
        attempt.scratchId = await writeFile(graph, attempt, initial, signal, `scratch-${result.correlationId}.json`);
      }, now);
      await measureStep(result, "read-app-data", async () => {
        verifyBytes(await downloadFile(graph, attempt, attempt.fileId!, signal), initial);
        verifyBytes(await downloadFile(graph, attempt, attempt.scratchId!, signal), initial);
      }, now);
      await measureStep(result, "update-app-data", async () => {
        const fileId = await writeFile(graph, attempt, updated, signal, "state.json");
        if (fileId !== attempt.fileId) throw new IntegrationError("read-failure");
        verifyBytes(await downloadFile(graph, attempt, fileId, signal), updated);
      }, now);
      await measureStep(result, "delete-app-scratch", () => deleteScratch(graph, attempt, signal), now);
    } else {
      await measureStep(result, "update-document", async () => {
        await createOwnedFolder(graph, attempt, signal);
        attempt.fileId = await writeFile(graph, attempt, initial, signal);
        verifyBytes(await downloadFile(graph, attempt, attempt.fileId, signal), initial);
        const fileId = await writeFile(graph, attempt, updated, signal);
        if (fileId !== attempt.fileId) throw new IntegrationError("read-failure");
        verifyBytes(await downloadFile(graph, attempt, fileId, signal), updated);
      }, now);
      const versions = await measureStep(result, "list-versions", () => listVersions(graph, attempt, signal), now);
      const earlier = await measureStep(result, "read-prior-version", async () => {
        let observed = versions;
        for (;;) {
          signal.throwIfAborted();
          const found = await findPriorVersion(graph, attempt, observed, initial, signal);
          if (found) return found;
          if (now() - startedAt >= context.config.PROBE_TIMEOUT_MS - context.config.POLL_INTERVAL_MS) {
            throw new IntegrationError("delivery-timeout");
          }
          await (context.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(context.config.POLL_INTERVAL_MS, signal);
          observed = await listVersions(graph, attempt, signal);
        }
      }, now);
      if (probe.restoreVersion) {
        await measureStep(result, "restore-version", async () => {
          const fileId = await writeFile(graph, attempt, earlier, signal);
          if (fileId !== attempt.fileId) throw new IntegrationError("read-failure");
          verifyBytes(await downloadFile(graph, attempt, fileId, signal), earlier);
        }, now);
      } else result.steps.push({
        name: "restore-version", status: "skipped", observedAt: new Date(now()).toISOString(), reason: "variant-disabled",
      });
    }
    result.success = true;
    result.diagnosticContext.testStage = "complete";
  } catch (error) {
    journeyFailure(result, error, telemetry);
  } finally {
    await cleanupStep(result, attempt.mutationAttempted && (!persistent || Boolean(attempt.folderId)),
      cleanupSignal => persistent
        ? deleteScratch(context.graph!, attempt, cleanupSignal)
        : deleteOwnedFolder(context.graph!, attempt, cleanupSignal), telemetry, now);
  }
  return finishJourney(result, startedAt, now);
};
