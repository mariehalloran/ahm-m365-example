import { z } from "zod";
import type { Telemetry } from "../contracts.js";
import {
  createHealthModelHttp, healthModelBaseUrl, type HealthReportClientOptions, type HealthReportCycle,
} from "../reporting/health-report-client.js";
import { categoryOf, IntegrationError, readResponseBody, withAbort } from "../integrations/http.js";
import { ProviderCollectionError, PROVIDER_PAGE_BYTE_LIMIT, PROVIDER_PAGE_LIMIT } from "./provider-collection.js";
import type { ProviderCategory, ProviderDiagnostic } from "./provider-diagnostics.js";
import type { ProjectConfig } from "../configuration/project-config.js";
import type { ServiceConfig } from "../configuration/service-config.js";
import {
  communicationVersion, COMMUNICATION_WINDOW_MILLISECONDS, issueCommunicationSchema, messageCommunicationSchema,
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
  | { state: "published"; annotations: PublishedCommunication[]; omitted: number }
  | { state: "no-new-changes" | "source-unavailable" }
  | { state: "failed"; category: ProviderCategory; httpStatus?: number; annotations?: PublishedCommunication[] }
  | { state: "disabled" };
interface PublishedCommunication {
  source: CommunicationSummary["source"];
  annotationId: string;
}
export class AnnotationPublicationError extends Error {
  readonly publication: Extract<AnnotationPublication, { state: "failed" }>;
  constructor(cause: unknown, annotations: PublishedCommunication[]) {
    super("Service communication publication failed after some notices were published", { cause });
    this.name = "AnnotationPublicationError";
    this.publication = {
      state: "failed",
      category: cause instanceof ProviderCollectionError ? cause.category : categoryOf(cause),
      ...(cause instanceof IntegrationError && cause.status !== undefined ? { httpStatus: cause.status } : {}),
      annotations,
    };
  }
}
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
const descriptionScope = { tenant: z.string().min(1), service: z.string().min(1).max(128) };
const descriptionSchema = z.discriminatedUnion("source", [
  issueCommunicationSchema.omit({ title: true }).extend(descriptionScope),
  messageCommunicationSchema.omit({ title: true }).extend(descriptionScope),
]);
const descriptionScopeSchema = z.object({
  ...descriptionScope, source: z.enum(["serviceAnnouncement.issues", "serviceAnnouncement.messages"]),
});
type DataAnnotation = z.infer<typeof annotationSchema>;
export interface CommunicationsAnnotation { annotationDetails: Record<string, string>; description: string }

export function prepareCommunicationsAnnotation(
  tenant: string, service: ServiceConfig["type"], item: CommunicationSummary,
): CommunicationsAnnotation {
  const { title, ...notice } = item;
  const characters = Array.from(notice.excerpt);
  const render = (length: number): string => JSON.stringify({
    tenant, service: serviceHealthNames[service], ...notice,
    excerpt: length === characters.length ? notice.excerpt : length ? `${characters.slice(0, length).join("")}...` : "",
    textTruncated: notice.textTruncated || length < characters.length,
  }, null, 2);
  let description = render(characters.length);
  if (Buffer.byteLength(description, "utf8") > MAX_ANNOTATION_DESCRIPTION_BYTES) {
    let lower = 0;
    let upper = Math.max(0, characters.length - 3);
    while (lower < upper) {
      const length = Math.ceil((lower + upper) / 2);
      if (Buffer.byteLength(render(length), "utf8") <= MAX_ANNOTATION_DESCRIPTION_BYTES) lower = length;
      else upper = length - 1;
    }
    description = render(lower);
  }
  const annotationDetails = { title: title || "(untitled)" };
  if (Buffer.byteLength(description, "utf8") > MAX_ANNOTATION_DESCRIPTION_BYTES ||
      !detailsSchema.safeParse(annotationDetails).success) {
    throw new IntegrationError("malformed-response", undefined, "annotation-size-budget");
  }
  return { annotationDetails, description };
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

function recordedVersions(annotations: DataAnnotation[], tenant: string, service: ServiceConfig["type"]): Set<string> {
  const versions = new Set<string>();
  for (const annotation of annotations) {
    if (annotation.annotationDetails.source !== annotationSource) {
      if (!annotation.description) continue;
      let raw: unknown;
      try { raw = JSON.parse(annotation.description); }
      catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      const scope = descriptionScopeSchema.safeParse(raw);
      if (!scope.success || scope.data.tenant !== tenant || scope.data.service !== serviceHealthNames[service]) continue;
      const parsed = descriptionSchema.safeParse(raw);
      if (!parsed.success) throw new IntegrationError("malformed-response", undefined, "annotation-description-schema");
      versions.add(communicationVersion(parsed.data));
      continue;
    }
    if (annotation.annotationDetails.tenant !== tenant ||
        annotation.annotationDetails.service !== serviceHealthNames[service]) continue;
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
  return async (snapshot, cycle) => {
    const deadline = AbortSignal.timeout(ANNOTATION_TIMEOUT_MS);
    const signal = cycle.signal ? AbortSignal.any([cycle.signal, deadline]) : deadline;
    const metadata = { cycleId: cycle.cycleId, entityName, tenant: project.tenant.id };
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
      annotations.push(...result.annotations);
      if (result.nextMarker === undefined || result.nextMarker === null) break;
      if (visited.has(result.nextMarker) || page === PROVIDER_PAGE_LIMIT - 1) throw new ProviderCollectionError("pagination-budget");
      visited.add(result.nextMarker);
      nextMarker = result.nextMarker;
    }
    const previousVersions = recordedVersions(annotations, project.tenant.id, service.type);
    const candidates: Record<FeedName, CommunicationSummary[]> = { issues: [], messages: [] };
    for (const name of feedNames) {
      const feed = snapshot[name];
      if (feed.state === "complete") {
        candidates[name] = feed.summary.summaries.filter(item => !previousVersions.has(communicationVersion(item)));
      }
    }
    const selected: CommunicationSummary[] = [];
    for (let index = 0; index < MAX_COMMUNICATION_SUMMARIES; index++) {
      for (const name of feedNames) {
        const item = candidates[name][index];
        if (item) selected.push(item);
      }
    }
    if (!selected.length) {
      return { state: feedNames.some(name => snapshot[name].state === "unavailable") ? "source-unavailable" : "no-new-changes" };
    }
    const published: PublishedCommunication[] = [];
    try {
      for (const item of selected) {
        const body = prepareCommunicationsAnnotation(project.tenant.id, service.type, item);
        const response = await http.request(actionUrl("addDataAnnotation"), {
          method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        }, signal, false);
        const annotation = await annotationJson(response, annotationSchema, signal);
        if (annotation.description !== body.description ||
            Object.keys(annotation.annotationDetails).length !== 1 || annotation.annotationDetails.title !== body.annotationDetails.title) {
          throw new IntegrationError("malformed-response", undefined, "annotation-response-mismatch");
        }
        const reference = { source: item.source, annotationId: annotation.annotationId };
        published.push(reference);
        telemetry.emit("service-communications-notice-published", { ...metadata, ...reference, id: item.id });
      }
    } catch (error) {
      if (published.length) throw new AnnotationPublicationError(error, published);
      throw error;
    }
    const omitted = candidates.issues.length + candidates.messages.length - selected.length;
    if (omitted) telemetry.emit("service-communications-notices-omitted", { ...metadata, omitted });
    return { state: "published", annotations: published, omitted };
  };
}
