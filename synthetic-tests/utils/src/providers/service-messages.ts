import { z } from "zod";
import type { GraphClient } from "../integrations/graph.js";
import { readProviderCollection, type ProviderSourceDefinition } from "./provider-collection.js";
import {
  boundedPlainText, communicationExcerpt, communicationSourceUrl, communicationWindow, compareCommunicationUpdates, distinctCommunications,
  recentlyUpdated, serviceMessageNames, type MessageCommunication,
} from "./service-communications.js";
import type { ServiceConfig } from "../configuration/service-config.js";

const date = z.string().max(64).datetime({ offset: true });
const messageSchema = z.object({
  id: z.string().min(1).max(256),
  services: z.array(z.string().min(1).max(128)).min(1),
  title: z.string(),
  body: z.object({ contentType: z.string(), content: z.string() }),
  category: z.string().min(1).max(80),
  severity: z.string().min(1).max(80),
  isMajorChange: z.boolean(),
  lastModifiedDateTime: date,
  endDateTime: date.nullable().optional(),
  actionRequiredByDateTime: date.nullable().optional(),
});
export type ServiceUpdateMessage = z.infer<typeof messageSchema>;

export function getServiceMessages(
  graph: GraphClient, service: ServiceConfig["type"], signal: AbortSignal,
): Promise<ServiceUpdateMessage[]> {
  const query = new URLSearchParams({
    "$filter": serviceMessageNames[service].map(name => `services/any(s:s eq '${name}')`).join(" or "),
    "$select": "id,services,title,body,category,severity,isMajorChange,lastModifiedDateTime,endDateTime,actionRequiredByDateTime",
  });
  return readProviderCollection(graph, "/admin/serviceAnnouncement/messages", messageSchema, signal, "v1.0", `?${query}`);
}

function requiresAction(message: ServiceUpdateMessage): boolean {
  return (message.actionRequiredByDateTime !== null && message.actionRequiredByDateTime !== undefined) ||
    message.category.toLowerCase() === "preventorfixissue";
}

export function relevantServiceMessages(
  records: ServiceUpdateMessage[], service: ServiceConfig["type"], now: number,
): ServiceUpdateMessage[] {
  const names: readonly string[] = serviceMessageNames[service];
  return distinctCommunications(records)
    .filter(message => message.services.some(name => names.includes(name)) &&
      (message.endDateTime === null || message.endDateTime === undefined || Date.parse(message.endDateTime) > now))
    .toSorted((left, right) => Number(requiresAction(right)) - Number(requiresAction(left)) ||
      Number(right.isMajorChange) - Number(left.isMajorChange) ||
      compareCommunicationUpdates(left, right));
}

export function summarizeServiceMessage(message: ServiceUpdateMessage, service: ServiceConfig["type"]): MessageCommunication {
  const names: readonly string[] = serviceMessageNames[service];
  const title = boundedPlainText(message.title, 160);
  const excerpt = communicationExcerpt(message.body);
  const sourceService = message.services.find(name => names.includes(name));
  if (!sourceService) throw new Error("Cannot summarize an announcement for an unrelated service");
  return {
    id: message.id, source: "serviceAnnouncement.messages",
    title: title.text, sourceService, sourceUrl: communicationSourceUrl("messages", message.id),
    lastUpdatedAt: message.lastModifiedDateTime, excerpt: excerpt.text,
    textTruncated: title.truncated || excerpt.truncated,
    category: message.category, severity: message.severity, isMajorChange: message.isMajorChange,
    actionRequiredBy: message.actionRequiredByDateTime ?? null, endDateTime: message.endDateTime ?? null,
  };
}

export function serviceMessageSources(service: ServiceConfig["type"]): ProviderSourceDefinition[] {
  return [{
    source: "serviceAnnouncement.messages", apiVersion: "v1.0",
    async collect(graph, signal, collectedAt) {
      const window = communicationWindow(collectedAt);
      const messages = relevantServiceMessages(await getServiceMessages(graph, service, signal), service, Date.parse(collectedAt));
      const recent = messages.filter(message => recentlyUpdated(message.lastModifiedDateTime, window));
      return [{
        kind: "message-summary", service, collectedAt, window, count: messages.length, recentCount: recent.length,
        summaries: recent.map(message => summarizeServiceMessage(message, service)),
      }];
    },
  }];
}
