import { z } from "zod";
import type { Telemetry } from "./contracts.js";
import {
  createHealthModelHttp, healthModelBaseUrl, type HealthReportClientOptions, type HealthReportCycle,
} from "./health-report-client.js";
import { IntegrationError, readResponseBody, withAbort } from "./http.js";
import { ProviderCollectionError, PROVIDER_PAGE_BYTE_LIMIT, PROVIDER_PAGE_LIMIT } from "./provider-collection.js";
import type { ProviderCategory, ProviderDiagnostic } from "./provider-diagnostics.js";
import type { ProjectConfig } from "./project-config.js";
import type { ServiceConfig } from "./service-config.js";
import {
  communicationVersion, communicationWindow, COMMUNICATION_WINDOW_MILLISECONDS,
  MAX_ANNOTATION_DESCRIPTION_BYTES, MAX_COMMUNICATION_SUMMARIES, serviceHealthNames, type CommunicationSummary,
} from "./service-communications.js";

export type CommunicationRecord = Extract<ProviderDiagnostic, { kind: "issue-summary" | "message-summary" }>;
export type CommunicationFeed<T extends CommunicationRecord = CommunicationRecord> =
  | { state: "complete"; summary: T }
  | { state: "unavailable"; diagnosticCategories: string[]; httpStatuses: number[] }
  | { state: "disabled" };
export interface CommunicationsSnapshot {
  collectedAt: string;
  issues: CommunicationFeed<Extract<CommunicationRecord, { kind: "issue-summary" }>>;
  messages: CommunicationFeed<Extract<CommunicationRecord, { kind: "message-summary" }>>;
}
export type AnnotationPublication =
  | { state: "published" | "already-published"; annotationId: string; snapshotMinute: string }
  | { state: "failed"; category: ProviderCategory; httpStatus?: number }
  | { state: "disabled" };
type AnnotationPublisher = (snapshot: CommunicationsSnapshot, cycle: HealthReportCycle) => Promise<AnnotationPublication>;
type FeedName = "issues" | "messages";
const feedNames: readonly FeedName[] = ["issues", "messages"];
const annotationSource = "m365-service-communications";
const ANNOTATION_TIMEOUT_MS = 12000;
const date = z.string().max(64).datetime({ offset: true });
const detailsSchema = z.record(z.string().max(256)).refine(details => Object.keys(details).length <= 10);
const annotationSchema = z.object({
  annotationId: z.string().min(1).max(256),
  createdAt: date,
  annotationDetails: detailsSchema,
  description: z.string().max(4096).optional(),
});
const annotationPageSchema = z.object({
  entityName: z.string().min(1),
  annotations: z.array(annotationSchema).max(100),
  nextMarker: z.string().min(1).max(4096).nullish(),
});
const versionsSchema = z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_COMMUNICATION_SUMMARIES);
type DataAnnotation = z.infer<typeof annotationSchema>;
export interface CommunicationsAnnotation { annotationDetails: Record<string, string>; description: string }

function snapshotMinute(collectedAt: string): string {
  return new Date(Math.floor(Date.parse(collectedAt) / 60000) * 60000).toISOString();
}

function renderCommunication(item: CommunicationSummary): string {
  const classification = item.source === "serviceAnnouncement.issues"
    ? `Status: ${item.status}${item.classification ? `; classification: ${item.classification}` : ""}`
    : `Category: ${item.category}; severity: ${item.severity}; major change: ${item.isMajorChange}\n`
      + `Action required by: ${item.actionRequiredBy ?? "Not specified"}; ends: ${item.endDateTime ?? "Not specified"}`;
  return [
    `${item.id}: ${item.title || "(untitled)"}`,
    `Service: ${item.sourceService}; ${classification}`,
    `Last source update: ${item.lastUpdatedAt}`,
    `Latest update: ${item.excerpt || "(no update text)"}${item.textTruncated ? " [text truncated]" : ""}`,
    `Source: ${item.sourceUrl}`,
  ].join("\n");
}

function renderFeed(
  name: FeedName, feed: CommunicationFeed, candidates: CommunicationSummary[], selected: CommunicationSummary[],
): string {
  const label = name === "issues" ? "Service incidents/advisories" : "Message Center";
  if (feed.state === "disabled") return `${label}: not enabled.`;
  if (feed.state === "unavailable") return `${label}: DATA UNAVAILABLE (${feed.diagnosticCategories.join(", ")}).`;
  const alreadyRecorded = feed.summary.recentCount - candidates.length;
  return [
    `${label}: ${feed.summary.count} active; ${feed.summary.recentCount} changed in the window; `
      + `${alreadyRecorded} already recorded; ${selected.length} displayed; ${candidates.length - selected.length} omitted.`,
    ...selected.map(renderCommunication),
  ].join("\n\n");
}

export function prepareCommunicationsAnnotation(
  tenant: string, service: ServiceConfig["type"], snapshot: CommunicationsSnapshot,
  previousVersions: ReadonlySet<string> = new Set(),
): CommunicationsAnnotation {
  const window = communicationWindow(snapshot.collectedAt);
  const candidates: Record<FeedName, CommunicationSummary[]> = {
    issues: snapshot.issues.state === "complete"
      ? snapshot.issues.summary.summaries.filter(item => !previousVersions.has(communicationVersion(item))) : [],
    messages: snapshot.messages.state === "complete"
      ? snapshot.messages.summary.summaries.filter(item => !previousVersions.has(communicationVersion(item))) : [],
  };
  const selected: Record<FeedName, CommunicationSummary[]> = { issues: [], messages: [] };
  const unavailable = feedNames.some(name => snapshot[name].state === "unavailable");
  const newChanges = candidates.issues.length + candidates.messages.length;
  const build = (): CommunicationsAnnotation => ({
    annotationDetails: {
      source: annotationSource, tenant, service: serviceHealthNames[service],
      snapshotMinute: snapshotMinute(snapshot.collectedAt),
      title: `${serviceHealthNames[service]} communications snapshot`,
      window: `${window.startAt} / ${window.endAt}`,
      collectionStatus: feedNames.map(name => `${name}=${snapshot[name].state}`).join(";"),
      counts: JSON.stringify({
        activeIssues: snapshot.issues.state === "complete" ? snapshot.issues.summary.count : null,
        activeMessages: snapshot.messages.state === "complete" ? snapshot.messages.summary.count : null,
        recentIssues: snapshot.issues.state === "complete" ? snapshot.issues.summary.recentCount : null,
        recentMessages: snapshot.messages.state === "complete" ? snapshot.messages.summary.recentCount : null,
        shown: selected.issues.length + selected.messages.length,
        omitted: newChanges - selected.issues.length - selected.messages.length,
      }),
      issueVersions: JSON.stringify(selected.issues.map(communicationVersion)),
      messageVersions: JSON.stringify(selected.messages.map(communicationVersion)),
    },
    description: [
      `${serviceHealthNames[service]} service communications - tenant ${tenant}`,
      `Snapshot: ${snapshot.collectedAt}\nSource-update window: ${window.startAt} to ${window.endAt}`,
      unavailable ? "PARTIAL/UNAVAILABLE SNAPSHOT: a failed source is not an empty feed."
        : newChanges ? "New or updated source notices; counts below retain all active items."
          : "No newly observed changes. Previously recorded versions are not repeated. Active items may still exist.",
      ...feedNames.map(name => renderFeed(name, snapshot[name], candidates[name], selected[name])),
    ].join("\n\n"),
  });
  for (let index = 0; index < MAX_COMMUNICATION_SUMMARIES; index++) {
    for (const name of feedNames) {
      const item = candidates[name][index];
      if (!item) continue;
      selected[name].push(item);
      if (Buffer.byteLength(build().description, "utf8") > MAX_ANNOTATION_DESCRIPTION_BYTES) selected[name].pop();
    }
  }
  const body = build();
  if (Buffer.byteLength(body.description, "utf8") > MAX_ANNOTATION_DESCRIPTION_BYTES ||
      (newChanges > 0 && selected.issues.length + selected.messages.length === 0) ||
      !detailsSchema.safeParse(body.annotationDetails).success) {
    throw new IntegrationError("malformed-response", undefined, "annotation-size-budget");
  }
  return body;
}

async function annotationJson<T>(response: Response, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
  if (response.status !== 200) {
    await withAbort(signal, async () => response.body?.cancel());
    throw new IntegrationError("collector-failure", response.status, "annotation-http-status");
  }
  const text = (await readResponseBody(response, PROVIDER_PAGE_BYTE_LIMIT, signal, "malformed-response")).toString("utf8");
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (error) {
    if (error instanceof SyntaxError) throw new IntegrationError("malformed-response", undefined, "annotation-invalid-json");
    throw error;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new IntegrationError("malformed-response", undefined, "annotation-schema");
  return parsed.data;
}

function recordedVersions(annotations: DataAnnotation[]): Set<string> {
  const versions = new Set<string>();
  for (const annotation of annotations) {
    for (const field of ["issueVersions", "messageVersions"]) {
      const text = annotation.annotationDetails[field];
      if (text === undefined) throw new IntegrationError("malformed-response", undefined, "annotation-version-schema");
      let raw: unknown;
      try { raw = JSON.parse(text); }
      catch (error) {
        if (error instanceof SyntaxError) throw new IntegrationError("malformed-response", undefined, "annotation-version-json");
        throw error;
      }
      const parsed = versionsSchema.safeParse(raw);
      if (!parsed.success) throw new IntegrationError("malformed-response", undefined, "annotation-version-schema");
      for (const version of parsed.data) versions.add(version);
    }
  }
  return versions;
}

export function createServiceAnnotationPublisher(
  project: ProjectConfig, service: ServiceConfig, telemetry: Telemetry, env: NodeJS.ProcessEnv,
  options: HealthReportClientOptions = {},
): AnnotationPublisher {
  if (!project.serviceHealth.enabled || !service.enabled || service.mode !== "live" ||
      (!service.serviceHealth && !service.serviceMessages)) return async () => ({ state: "disabled" });
  const http = createHealthModelHttp(service, env, { ...options, retryThrottledWrites: false });
  if (!http) throw new IntegrationError("configuration-failure");
  const entityName = `${service.type}-service-health`;
  const entityUrl = `${healthModelBaseUrl(project, service.type)}/entities/${encodeURIComponent(entityName)}`;
  const actionUrl = (action: "getDataAnnotations" | "addDataAnnotation") => `${entityUrl}/${action}?api-version=2026-05-01-preview`;
  const ownAnnotation = (annotation: DataAnnotation) => annotation.annotationDetails.source === annotationSource &&
    annotation.annotationDetails.tenant === project.tenant.id && annotation.annotationDetails.service === serviceHealthNames[service.type];
  return async (snapshot, cycle) => {
    const deadline = AbortSignal.timeout(ANNOTATION_TIMEOUT_MS);
    const signal = cycle.signal ? AbortSignal.any([cycle.signal, deadline]) : deadline;
    const metadata = { cycleId: cycle.cycleId, entityName, tenant: project.tenant.id, snapshotMinute: snapshotMinute(snapshot.collectedAt) };
    const annotations: DataAnnotation[] = [];
    const visited = new Set<string>();
    let nextMarker: string | undefined;
    for (let page = 0; page < PROVIDER_PAGE_LIMIT; page++) {
      const response = await http.request(actionUrl("getDataAnnotations"), {
        method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextMarker ? { nextMarker, top: 100 } : {
          startAt: new Date(Date.parse(snapshot.collectedAt) - COMMUNICATION_WINDOW_MILLISECONDS - 60000).toISOString(), top: 100,
        }),
      }, signal);
      const result = await annotationJson(response, annotationPageSchema, signal);
      if (result.entityName !== entityName) throw new IntegrationError("malformed-response", undefined, "annotation-entity-mismatch");
      annotations.push(...result.annotations.filter(ownAnnotation));
      if (result.nextMarker === undefined || result.nextMarker === null) break;
      if (visited.has(result.nextMarker) || page === PROVIDER_PAGE_LIMIT - 1) throw new ProviderCollectionError("pagination-budget");
      visited.add(result.nextMarker);
      nextMarker = result.nextMarker;
    }
    const existing = annotations.find(annotation => annotation.annotationDetails.snapshotMinute === metadata.snapshotMinute);
    if (existing) {
      telemetry.emit("service-communications-snapshot-already-published", { ...metadata, annotationId: existing.annotationId });
      return { state: "already-published", annotationId: existing.annotationId, snapshotMinute: metadata.snapshotMinute };
    }
    const body = prepareCommunicationsAnnotation(project.tenant.id, service.type, snapshot, recordedVersions(annotations));
    const response = await http.request(actionUrl("addDataAnnotation"), {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, signal, false);
    const published = await annotationJson(response, annotationSchema, signal);
    if (published.description !== body.description ||
        Object.entries(body.annotationDetails).some(([name, value]) => published.annotationDetails[name] !== value)) {
      throw new IntegrationError("malformed-response", undefined, "annotation-response-mismatch");
    }
    telemetry.emit("service-communications-snapshot-published", { ...metadata, annotationId: published.annotationId });
    return { state: "published", annotationId: published.annotationId, snapshotMinute: metadata.snapshotMinute };
  };
}
