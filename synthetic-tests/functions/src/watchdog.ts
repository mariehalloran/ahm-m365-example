import type { InvocationContext } from "@azure/functions";
import { ManagedIdentityCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { z } from "zod";
import { dispatchInventory, laneFreshnessSeconds, laneInstanceId } from "./dispatch.js";
import { readLaneJournal, type LaneRecord } from "./lane-ownership.js";
import { runtimeDocument } from "./runtime.js";

interface LaneFreshness { missingExecution: boolean; missingPublication: boolean; failed: boolean }

/** Evaluates execution and completed publication independently, retaining the previous slot's timestamps. */
function laneFreshness(record: LaneRecord | undefined, maximumAgeMs: number, now = Date.now()): LaneFreshness {
  const stale = (value: string | undefined) => !value || Date.parse(value) > now || now - Date.parse(value) > maximumAgeMs;
  return {
    missingExecution: stale(record?.lastExecutionStartedAt),
    missingPublication: stale(record?.lastPublicationAt),
    failed: record?.phase === "failed" || record?.phase === "ambiguous",
  };
}

/**
 * Runs on a separate Function host and identity. It reads only execution journals and emits
 * operational Azure Monitor metrics, so neither the dispatcher nor the reporting destination can mask a stopped lane.
 */
export async function monitoringWatchdog(_timer: unknown, context: InvocationContext): Promise<void> {
  const document = await runtimeDocument();
  const settings = document.deployment!;
  const identity = z.string().uuid().parse(process.env.AZURE_CLIENT_ID);
  const metricsAppName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,58}[a-zA-Z0-9]$/).parse(process.env.EXECUTION_METRICS_APP_NAME);
  const credential = new ManagedIdentityCredential({ clientId: identity });
  const signal = AbortSignal.timeout((settings.functions.watchdogIntervalSeconds - 1) * 1000);
  const container = new BlobServiceClient(`https://${settings.functions.storageAccount}.blob.core.windows.net`, credential)
    .getContainerClient("execution-state");
  const lanes = dispatchInventory(document, process.env.MONITORING_CONFIG_SHA256!);
  const totals = { MissingExecutionLanes: 0, MissingPublications: 0, FailedLanes: 0 };
  let next = 0;
  /** Bounds state reads without sharing process state with any executing lane. */
  async function inspectNext(): Promise<void> {
    while (next < lanes.length) {
      const lane = lanes[next++]!;
      const record = (await readLaneJournal(container.getBlockBlobClient(`lanes/${laneInstanceId({
        tenant: lane.tenant, service: lane.service, lane: lane.lane,
      })}.json`), signal))?.record;
      const freshness = laneFreshness(record, laneFreshnessSeconds(document, lane) * 1000);
      if (freshness.missingExecution) totals.MissingExecutionLanes++;
      if (freshness.missingPublication) totals.MissingPublications++;
      if (freshness.failed) totals.FailedLanes++;
      if (Object.values(freshness).some(Boolean)) context.warn("monitoring-lane-stale", {
        tenant: lane.tenant, service: lane.service, lane: lane.lane, ...freshness,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, lanes.length) }, inspectNext));
  const token = await credential.getToken("https://monitoring.azure.com/.default", { abortSignal: signal });
  if (!token) throw new Error("Watchdog managed identity did not receive an Azure Monitor token");
  const resource = `/subscriptions/${document.healthModel.subscriptionId}/resourceGroups/${document.healthModel.resourceGroup}/providers/Microsoft.Web/sites/${metricsAppName}`;
  for (const [metric, value] of Object.entries(totals)) {
    const response = await fetch(`https://${settings.location}.monitoring.azure.com${resource}/metrics`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.token}` },
      body: JSON.stringify({
        time: new Date().toISOString(),
        data: {
          baseData: {
            metric,
            namespace: "M365Monitoring",
            dimNames: [],
            series: [{ dimValues: [], min: value, max: value, sum: value, count: 1 }],
          },
        },
      }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Operational Azure Monitor metric publication failed (HTTP ${response.status})`);
  }
  context.log("monitoring-watchdog-completed", { laneCount: lanes.length, ...totals });
}
