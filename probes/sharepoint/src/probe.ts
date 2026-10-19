import { z } from "zod";
import { categoryOf, IntegrationError } from "../../../shared/src/http.js";
import { baseResult, type ProbeHandler } from "../../../shared/src/probes.js";

const driveItem = z.object({ id: z.string().min(1), name: z.string() });
export const sharepointProbe: ProbeHandler = async (probe, context) => {
  if (!context.graph || !probe.driveId || !probe.folderId || !probe.siteId) throw new IntegrationError("collector-failure");
  const { graph, signal, config, telemetry, now = Date.now } = context;
  const start = now();
  const result = baseResult(probe, start, config.REPORT_TTL_SECONDS);
  const name = `ahm-synthetic-${result.correlationId}.txt`;
  const drive = `/drives/${encodeURIComponent(probe.driveId)}`;
  const path = `${drive}/items/${encodeURIComponent(probe.folderId)}:/${name}:/content`;
  let itemId: string | undefined;
  let uploadAttempted = false;
  try {
    result.diagnosticContext.testStage = "authentication";
    await graph.authenticate(signal);
    result.diagnosticContext.authenticationDurationMs = now() - start;
    const siteDrives = await graph.json(`/sites/${encodeURIComponent(probe.siteId)}/drives?$select=id`,
      z.object({ value: z.array(z.object({ id: z.string() })) }), signal);
    if (!siteDrives.value.some(item => item.id === probe.driveId)) throw new IntegrationError("permission-failure");
    result.diagnosticContext.testStage = "upload";
    uploadAttempted = true;
    const response = await graph.request(path, signal, "PUT", { correlationId: result.correlationId });
    const parsed = driveItem.safeParse(await response.json());
    if (!parsed.success || parsed.data.name !== name) throw new IntegrationError("malformed-response");
    itemId = parsed.data.id;
    result.diagnosticContext.testStage = "download";
    const body = await graph.downloadJson(`${drive}/items/${encodeURIComponent(itemId)}/content`, signal);
    if (!z.object({ correlationId: z.literal(result.correlationId) }).strict().safeParse(body).success) {
      throw new IntegrationError("read-failure");
    }
    result.success = true;
    result.diagnosticContext.testStage = "complete";
  } catch (error) {
    result.diagnosticCategory = categoryOf(error);
    if (error instanceof IntegrationError && error.status) result.diagnosticContext.httpStatus = error.status;
    telemetry.emit("probe-stage-failed", { testId: probe.id, correlationId: result.correlationId, stage: result.diagnosticContext.testStage, category: result.diagnosticCategory });
  } finally {
    result.durationMs = now() - start;
    try {
      // The generated path also permits cleanup after an ambiguous upload response.
      if (uploadAttempted) {
        await graph.request(itemId ? `${drive}/items/${encodeURIComponent(itemId)}` : path.replace(/:\/content$/, ""), AbortSignal.timeout(10000), "DELETE");
      }
      result.diagnosticContext.cleanupSucceeded = true;
    } catch (error) {
      result.diagnosticContext.cleanupSucceeded = false;
      telemetry.emit("probe-cleanup-failed", { testId: probe.id, correlationId: result.correlationId, category: categoryOf(error) });
      if (result.success) { result.success = false; result.diagnosticCategory = "cleanup-failure"; }
    }
  }
  result.observedAt = new Date(now()).toISOString();
  result.expiresAt = new Date(now() + config.REPORT_TTL_SECONDS * 1000).toISOString();
  return result;
};
