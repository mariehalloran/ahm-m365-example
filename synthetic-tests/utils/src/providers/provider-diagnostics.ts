import { z } from "zod";
import { categories } from "../contracts.js";
import { activityFunctionNames, activityFunctions, isPercentageActivity } from "./provider-catalog.js";
import {
  communicationWindowSchema, issueCommunicationSchema, messageCommunicationSchema,
  MAX_COMMUNICATION_CANDIDATES, MAX_COMMUNICATION_SUMMARIES, recentlyUpdated, serviceHealthNames, serviceMessageNames,
} from "./service-communications.js";

export const providerServices = ["exchange", "teams", "onedrive"] as const;
export const providerSources = [
  "serviceAnnouncement.healthOverviews", "serviceAnnouncement.issues", "serviceAnnouncement.messages",
  ...activityFunctionNames,
] as const;
const service = z.enum(providerServices);
const source = z.enum(providerSources);
const collectedAt = z.string().datetime();
export const providerCategories = [...categories, "no-data", "pagination-budget", "collection-budget"] as const;
const base = { service, collectedAt };
export const providerDiagnosticSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base, kind: z.literal("issue-summary"),
    count: z.number().int().nonnegative().max(MAX_COMMUNICATION_CANDIDATES),
    recentCount: z.number().int().nonnegative().max(MAX_COMMUNICATION_CANDIDATES),
    window: communicationWindowSchema,
    summaries: z.array(issueCommunicationSchema).max(MAX_COMMUNICATION_CANDIDATES),
  }).strict(),
  z.object({
    ...base, kind: z.literal("message-summary"),
    count: z.number().int().nonnegative().max(MAX_COMMUNICATION_CANDIDATES),
    recentCount: z.number().int().nonnegative().max(MAX_COMMUNICATION_CANDIDATES),
    window: communicationWindowSchema,
    summaries: z.array(messageCommunicationSchema).max(MAX_COMMUNICATION_CANDIDATES),
  }).strict(),
  z.object({
    ...base, kind: z.literal("overview"), serviceId: z.string().min(1).max(256),
    serviceName: z.string().min(1).max(128), status: z.string().min(1).max(128),
  }).strict(),
  z.object({
    ...base, kind: z.literal("issue"), issueId: z.string().min(1).max(256),
    serviceName: z.string().min(1).max(128), status: z.string().min(1).max(128),
    metadata: z.string().max(6000), truncated: z.boolean(),
  }).strict(),
  z.object({
    ...base, kind: z.literal("activity"),
    function: z.enum(activityFunctionNames),
    intervalStart: collectedAt, intervalEnd: collectedAt,
    aggregationIntervalMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30)]),
    percentage: z.number().finite().min(0).max(100).optional(),
    value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict(),
  z.object({
    ...base, kind: z.literal("failure"), source, apiVersion: z.enum(["v1.0", "beta"]),
    category: z.enum(providerCategories), httpStatus: z.number().int().min(100).max(599).optional(),
  }).strict(),
  z.object({
    ...base, kind: z.literal("skipped"), source, apiVersion: z.enum(["v1.0", "beta"]),
    reason: z.literal("simulation"),
  }).strict(),
]).superRefine((record, context) => {
  if (record.kind !== "issue-summary" && record.kind !== "message-summary") return;
  const ids = record.summaries.map(summary => summary.id);
  const allowedServices: readonly string[] = record.kind === "issue-summary"
    ? [serviceHealthNames[record.service]] : serviceMessageNames[record.service];
  if (record.recentCount !== ids.length || new Set(ids).size !== ids.length || record.window.endAt !== record.collectedAt ||
      record.summaries.some(summary =>
        !allowedServices.includes(summary.sourceService) || !recentlyUpdated(summary.lastUpdatedAt, record.window))) {
    context.addIssue({ code: "custom", message: "Incomplete or inconsistent communications summary" });
  }
});
export type ProviderDiagnostic = z.infer<typeof providerDiagnosticSchema>;
export type ProviderSource = (typeof providerSources)[number];
export type ProviderCategory = (typeof providerCategories)[number];

// This facade accepts only approved provider fields, never arbitrary log attributes or HTTP errors.
export function providerLog(raw: ProviderDiagnostic): { body: string; timestamp: Date; attributes: Record<string, string | number | boolean> } {
  const record = providerDiagnosticSchema.parse(raw);
  const attributes: Record<string, string | number | boolean> = {
    "provider.service": record.service, "provider.collected_at": record.collectedAt,
    "provider.mode": record.kind === "skipped" ? "simulation" : "live",
  };
  let body: string;
  switch (record.kind) {
    case "issue-summary":
    case "message-summary":
      body = record.kind === "issue-summary" ? "m365-service-health-issue-summary" : "m365-message-center-summary";
      Object.assign(attributes, {
        "provider.source": record.kind === "issue-summary" ? "serviceAnnouncement.issues" : "serviceAnnouncement.messages",
        "provider.api_version": "v1.0",
        "provider.value": record.count, "provider.unit": "Count",
        "provider.recent_value": record.recentCount,
        "provider.window_start": record.window.startAt, "provider.window_end": record.window.endAt,
        "provider.summaries": JSON.stringify(record.summaries.slice(0, MAX_COMMUNICATION_SUMMARIES)),
        "provider.omitted": record.recentCount - Math.min(MAX_COMMUNICATION_SUMMARIES, record.summaries.length),
      });
      break;
    case "overview":
      body = "m365-service-health-overview";
      Object.assign(attributes, {
        "provider.source": "serviceAnnouncement.healthOverviews", "provider.api_version": "v1.0",
        "provider.service_id": record.serviceId, "provider.service_name": record.serviceName, "provider.status": record.status,
      });
      break;
    case "issue":
      body = "m365-service-health-issue";
      Object.assign(attributes, {
        "provider.source": "serviceAnnouncement.issues", "provider.api_version": "v1.0",
        "provider.issue_id": record.issueId, "provider.service_name": record.serviceName,
        "provider.status": record.status, "provider.issue": record.metadata, "provider.truncated": record.truncated,
      });
      break;
    case "activity":
      if (!(activityFunctions[record.service] as readonly string[]).includes(record.function) ||
          (isPercentageActivity(record.function)
            ? record.percentage === undefined || record.value !== undefined
            : record.value === undefined || record.percentage !== undefined)) {
        throw new Error("Invalid provider diagnostic");
      }
      body = "m365-service-activity";
      Object.assign(attributes, {
        "provider.source": record.function, "provider.api_version": "beta", "provider.function": record.function,
        "provider.interval_start": record.intervalStart, "provider.interval_end": record.intervalEnd,
        "provider.aggregation_interval_minutes": record.aggregationIntervalMinutes,
        ...(record.percentage === undefined ? {} : { "provider.percentage": record.percentage }),
        ...(record.value === undefined ? {} : { "provider.value": record.value }),
      });
      break;
    case "failure":
      body = "m365-provider-collection-failed";
      Object.assign(attributes, {
        "provider.source": record.source, "provider.api_version": record.apiVersion,
        "provider.category": record.category, "provider.observed_at": record.collectedAt,
        ...(record.httpStatus === undefined ? {} : { "provider.http_status": record.httpStatus }),
      });
      break;
    case "skipped":
      body = "m365-provider-collection-skipped";
      Object.assign(attributes, {
        "provider.source": record.source, "provider.api_version": record.apiVersion, "provider.skip_reason": record.reason,
      });
  }
  return { body, timestamp: new Date(record.collectedAt), attributes };
}
