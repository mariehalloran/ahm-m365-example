import { createHash } from "node:crypto";
import { convert } from "html-to-text";
import { z } from "zod";
import { IntegrationError } from "../integrations/http.js";

export const MAX_COMMUNICATION_SUMMARIES = 3;
export const MAX_COMMUNICATION_CANDIDATES = 500;
export const MAX_ANNOTATION_DESCRIPTION_BYTES = 4096;
export const COMMUNICATION_WINDOW_MILLISECONDS = 90000;
const MAX_EXCERPT_INPUT_LENGTH = 65536;

export const serviceHealthNames = {
  exchange: "Exchange Online", teams: "Microsoft Teams", onedrive: "Microsoft OneDrive",
} as const;
export const serviceMessageNames = {
  exchange: [serviceHealthNames.exchange],
  teams: [serviceHealthNames.teams],
  onedrive: [serviceHealthNames.onedrive, "OneDrive for Business"],
} as const;

const date = z.string().max(64).datetime({ offset: true });
export const communicationWindowSchema = z.object({
  startAt: date, endAt: date,
}).strict().refine(window =>
  Date.parse(window.endAt) - Date.parse(window.startAt) === COMMUNICATION_WINDOW_MILLISECONDS,
"Invalid communications lookback window");
export type CommunicationWindow = z.infer<typeof communicationWindowSchema>;
const summaryFields = {
  id: z.string().min(1).max(256),
  title: z.string().max(160),
  sourceService: z.string().min(1).max(128),
  sourceUrl: z.string().url(),
  lastUpdatedAt: date,
  excerpt: z.string().max(320),
  textTruncated: z.boolean(),
};
export const issueCommunicationSchema = z.object({
  ...summaryFields,
  source: z.literal("serviceAnnouncement.issues"),
  status: z.string().min(1).max(128),
  classification: z.string().max(80).optional(),
}).strict();
export const messageCommunicationSchema = z.object({
  ...summaryFields,
  source: z.literal("serviceAnnouncement.messages"),
  category: z.string().min(1).max(80),
  severity: z.string().min(1).max(80),
  isMajorChange: z.boolean(),
  actionRequiredBy: date.nullable(),
  endDateTime: date.nullable(),
}).strict();
export type IssueCommunication = z.infer<typeof issueCommunicationSchema>;
export type MessageCommunication = z.infer<typeof messageCommunicationSchema>;
export type CommunicationSummary = IssueCommunication | MessageCommunication;

export function communicationWindow(collectedAt: string): CommunicationWindow {
  const end = Date.parse(collectedAt);
  if (!Number.isFinite(end)) throw new IntegrationError("malformed-response");
  return { startAt: new Date(end - COMMUNICATION_WINDOW_MILLISECONDS).toISOString(), endAt: collectedAt };
}

export function recentlyUpdated(updatedAt: string, window: CommunicationWindow): boolean {
  const updated = Date.parse(updatedAt);
  return updated >= Date.parse(window.startAt) && updated <= Date.parse(window.endAt);
}

export function communicationVersion(summary: Pick<CommunicationSummary, "source" | "id" | "lastUpdatedAt">): string {
  return createHash("sha256").update(JSON.stringify([summary.source, summary.id, summary.lastUpdatedAt])).digest("hex");
}

export function boundedPlainText(value: string, maximum: number): { text: string; truncated: boolean } {
  const plain = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (plain.length <= maximum) return { text: plain, truncated: false };
  const prefix = plain.slice(0, maximum - 3).replace(/[\uD800-\uDBFF]$/, "").trimEnd();
  return { text: `${prefix}...`, truncated: true };
}

export function communicationExcerpt(body: { contentType: string; content: string }): { text: string; truncated: boolean } {
  const contentType = body.contentType.toLowerCase();
  if (contentType !== "html" && contentType !== "text") throw new IntegrationError("malformed-response");
  const input = body.content.slice(0, MAX_EXCERPT_INPUT_LENGTH);
  const plain = contentType === "text" ? input : convert(input, {
    wordwrap: false,
    selectors: [{ selector: "a", options: { ignoreHref: true } }, { selector: "img", format: "skip" }],
  });
  const excerpt = boundedPlainText(plain, 320);
  return { text: excerpt.text, truncated: excerpt.truncated || input.length !== body.content.length };
}

type UpdatedCommunication = { id: string; lastModifiedDateTime?: string | null | undefined };

export function compareCommunicationUpdates(left: UpdatedCommunication, right: UpdatedCommunication): number {
  if (left.lastModifiedDateTime && right.lastModifiedDateTime) {
    return Date.parse(right.lastModifiedDateTime) - Date.parse(left.lastModifiedDateTime) || left.id.localeCompare(right.id);
  }
  if (left.lastModifiedDateTime) return -1;
  if (right.lastModifiedDateTime) return 1;
  return left.id.localeCompare(right.id);
}

export function distinctCommunications<T extends UpdatedCommunication>(records: T[]): T[] {
  const distinct = new Map<string, T>();
  for (const record of records) {
    const previous = distinct.get(record.id);
    if (!previous || compareCommunicationUpdates(record, previous) < 0) {
      distinct.set(record.id, record);
    }
  }
  return [...distinct.values()];
}

export function communicationSourceUrl(source: "issues" | "messages", id: string): string {
  return `https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/${source}/${encodeURIComponent(id)}`;
}
