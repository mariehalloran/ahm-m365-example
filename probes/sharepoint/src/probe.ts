import { z } from "zod";
import { categoryOf, IntegrationError } from "../../../shared/src/http.js";
import { baseResult, type ProbeHandler } from "../../../shared/src/probes.js";

const driveItemSchema = z.object({ id: z.string().min(1), name: z.string() });
const siteDrivesSchema = z.object({
  value: z.array(z.object({ id: z.string() })),
});

export const sharepointProbe: ProbeHandler = async (probe, context) => {
  if (!context.graph || !probe.driveId || !probe.folderId || !probe.siteId) {
    throw new IntegrationError("collector-failure");
  }

  const { graph, signal, telemetry, now = Date.now } = context;
  const startedAt = now();
  const result = baseResult(probe, startedAt);
  const fileName = `ahm-synthetic-${result.correlationId}.txt`;
  const siteDrivesPath = `/sites/${encodeURIComponent(probe.siteId)}/drives?$select=id`;
  const drivePath = `/drives/${encodeURIComponent(probe.driveId)}`;
  const filePath = `${drivePath}/items/${encodeURIComponent(probe.folderId)}:/${fileName}`;
  const uploadPath = `${filePath}:/content`;

  let uploadedFileId: string | undefined;
  let uploadAttempted = false;

  try {
    result.diagnosticContext.testStage = "authentication";
    await graph.authenticate(signal);
    result.diagnosticContext.authenticationDurationMs = Math.max(0, now() - startedAt);

    const siteDrives = await graph.json(siteDrivesPath, siteDrivesSchema, signal);
    const driveBelongsToApprovedSite = siteDrives.value.some(drive => drive.id === probe.driveId);
    if (!driveBelongsToApprovedSite) {
      throw new IntegrationError("permission-failure");
    }

    result.diagnosticContext.testStage = "upload";
    uploadAttempted = true;
    const uploadResponse = await graph.request(uploadPath, signal, "PUT", {
      correlationId: result.correlationId,
    });
    const uploadedFile = driveItemSchema.safeParse(await uploadResponse.json());
    if (!uploadedFile.success || uploadedFile.data.name !== fileName) {
      throw new IntegrationError("malformed-response");
    }
    uploadedFileId = uploadedFile.data.id;

    result.diagnosticContext.testStage = "download";
    const downloadPath = `${drivePath}/items/${encodeURIComponent(uploadedFileId)}/content`;
    const downloadedContent = await graph.downloadJson(downloadPath, signal);
    const expectedContent = z.object({
      correlationId: z.literal(result.correlationId),
    }).strict();
    if (!expectedContent.safeParse(downloadedContent).success) {
      throw new IntegrationError("read-failure");
    }

    result.success = true;
    result.diagnosticContext.testStage = "complete";
  } catch (error) {
    result.diagnosticCategory = categoryOf(error);
    if (error instanceof IntegrationError && error.status) {
      result.diagnosticContext.httpStatus = error.status;
    }
    telemetry.emit("probe-stage-failed", {
      testId: probe.id,
      correlationId: result.correlationId,
      stage: result.diagnosticContext.testStage,
      category: result.diagnosticCategory,
    });
  } finally {
    try {
      // The generated path also permits cleanup after an ambiguous upload response.
      if (uploadAttempted) {
        const deletePath = uploadedFileId
          ? `${drivePath}/items/${encodeURIComponent(uploadedFileId)}`
          : filePath;
        await graph.request(deletePath, AbortSignal.timeout(10000), "DELETE");
      }
      result.diagnosticContext.cleanupSucceeded = true;
    } catch (error) {
      result.diagnosticContext.cleanupSucceeded = false;
      telemetry.emit("probe-cleanup-failed", {
        testId: probe.id,
        correlationId: result.correlationId,
        category: categoryOf(error),
      });
      if (result.success) {
        result.success = false;
        result.diagnosticCategory = "cleanup-failure";
      }
    }
  }

  result.observedAt = new Date(now()).toISOString();
  result.durationMs = Math.max(0, now() - startedAt);
  return result;
};
