import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Probe, SyntheticResult, Telemetry } from "./contracts.js";
import { GraphClient } from "./graph.js";
import { categoryOf, IntegrationError } from "./http.js";

export interface ProbeContext {
  config: Config;
  signal: AbortSignal;
  graph?: GraphClient;
  telemetry: Telemetry;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export type ProbeHandler = (probe: Probe, context: ProbeContext) => Promise<SyntheticResult>;

export function baseResult(probe: Probe, now: number, ttl: number): SyntheticResult {
  return {
    schemaVersion: "1.0", testType: probe.type, testId: probe.id, cohort: probe.cohort,
    targetService: probe.type === "exchange-mail-flow" ? "Exchange Online" : "SharePoint Online",
    success: false, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl * 1000).toISOString(),
    correlationId: randomUUID(), diagnosticCategory: null,
    diagnosticContext: { ...(probe.region ? { region: probe.region } : {}) },
  };
}

export const simulate: ProbeHandler = async (probe, { config, now = Date.now }) => {
  const result = baseResult(probe, now(), config.REPORT_TTL_SECONDS);
  const scenario = probe.scenario ?? config.SYNTHETIC_SCENARIO;
  result.success = scenario === "healthy" || scenario === "slow" || scenario === "stale";
  result.durationMs = scenario === "slow" ? 30000 : scenario === "timeout" ? 65000 : 3200;
  result.diagnosticCategory = scenario === "failed" ? "send-failure" : scenario === "timeout" ? "delivery-timeout" : null;
  result.diagnosticContext.testStage = "simulated";
  if (scenario === "stale") {
    result.observedAt = new Date(now() - 2 * config.REPORT_TTL_SECONDS * 1000).toISOString();
    result.expiresAt = new Date(now() - config.REPORT_TTL_SECONDS * 1000).toISOString();
  }
  return result;
};

const message = z.object({ id: z.string().min(1) });
const messages = z.object({ value: z.array(message), "@odata.nextLink": z.string().optional() });

export const exchangeProbe: ProbeHandler = async (probe, context) => {
  if (!context.graph || !probe.mailbox) throw new IntegrationError("collector-failure");
  const { graph, config, signal, telemetry, now = Date.now } = context;
  const sleep = context.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort }));
  const start = now();
  const result = baseResult(probe, start, config.REPORT_TTL_SECONDS);
  const user = `/users/${encodeURIComponent(probe.mailbox)}`;
  const subject = `AHM synthetic ${result.correlationId}`;
  const filter = new URLSearchParams({ "$filter": `subject eq '${subject}'`, "$select": "id", "$top": "100" });
  const ownedIds = new Set<string>();
  let submitted = false;
  let mutationAttempted = false;
  let stage: NonNullable<SyntheticResult["diagnosticContext"]["testStage"]> = "authentication";
  try {
    await graph.authenticate(signal);
    result.diagnosticContext.authenticationDurationMs = now() - start;
    stage = "send";
    mutationAttempted = true;
    const draft = await graph.json(`${user}/messages`, message, signal, "POST", {
      subject,
      body: { contentType: "Text", content: "Dedicated synthetic probe. Safe to delete." },
      toRecipients: [{ emailAddress: { address: probe.mailbox } }],
      internetMessageHeaders: [{ name: "x-ahm-correlation-id", value: result.correlationId }],
    }, false);
    ownedIds.add(draft.id);
    await graph.request(`${user}/messages/${encodeURIComponent(draft.id)}/send`, signal, "POST", undefined, false);
    submitted = true;
    stage = "poll";
    while (!signal.aborted && now() - start < config.UNHEALTHY_LATENCY_MS) {
      const inbox = await graph.json(`${user}/mailFolders/inbox/messages?${filter}`, messages, signal);
      for (const item of inbox.value) ownedIds.add(item.id);
      if (inbox.value.length > 0) {
        result.success = true;
        stage = "delivery-confirmed";
        break;
      }
      await sleep(config.POLL_INTERVAL_MS, signal);
    }
    if (!result.success) result.diagnosticCategory = "delivery-timeout";
  } catch (error) {
    const category = categoryOf(error);
    result.diagnosticCategory = category === "cancelled" && submitted ? "delivery-timeout"
      : category === "graph-unavailable" ? (stage === "send" ? "send-failure" : "read-failure") : category;
    if (error instanceof IntegrationError && error.status) result.diagnosticContext.httpStatus = error.status;
    telemetry.emit("probe-stage-failed", { testId: probe.id, correlationId: result.correlationId, stage, category: result.diagnosticCategory });
  } finally {
    result.durationMs = now() - start;
    const cleanupSignal = AbortSignal.timeout(10000);
    try {
      if (!mutationAttempted) {
        result.diagnosticContext.cleanupSucceeded = true;
      } else {
        // Query only this run's unguessable subject, including a sent copy whose ID may have changed.
        const copies = await graph.json(`${user}/messages?${filter}`, messages, cleanupSignal);
        if (copies["@odata.nextLink"]) throw new IntegrationError("cleanup-failure");
        for (const item of copies.value) ownedIds.add(item.id);
        for (const id of ownedIds) await graph.request(`${user}/messages/${encodeURIComponent(id)}`, cleanupSignal, "DELETE");
        result.diagnosticContext.cleanupSucceeded = true;
      }
    } catch (error) {
      telemetry.emit("probe-cleanup-failed", { testId: probe.id, correlationId: result.correlationId, category: categoryOf(error) });
      result.diagnosticContext.cleanupSucceeded = false;
      if (result.success) { result.success = false; result.diagnosticCategory = "cleanup-failure"; }
    }
  }
  result.observedAt = new Date(now()).toISOString();
  result.expiresAt = new Date(now() + config.REPORT_TTL_SECONDS * 1000).toISOString();
  result.diagnosticContext.testStage = stage;
  return result;
};

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

export const handlers: Readonly<Record<Probe["type"], ProbeHandler>> = {
  "exchange-mail-flow": exchangeProbe,
  "sharepoint-file": sharepointProbe,
};
