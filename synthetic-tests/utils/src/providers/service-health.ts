import { z } from "zod";
import type { GraphClient } from "../integrations/graph.js";
import { ProviderCollectionError, readProviderCollection, type ProviderSourceDefinition } from "./provider-collection.js";
import type { ProviderDiagnostic } from "./provider-diagnostics.js";
import type { ServiceConfig } from "../configuration/service-config.js";
import {
  boundedPlainText, communicationExcerpt, communicationSourceUrl, communicationWindow,
  compareCommunicationUpdates, distinctCommunications, recentlyUpdated,
  type CommunicationWindow,
  serviceHealthNames, type IssueCommunication,
} from "./service-communications.js";
export { serviceHealthNames } from "./service-communications.js";

const identifier = z.string().min(1).max(256);
const serviceName = z.string().min(1).max(128);
const status = z.string().min(1).max(128);
const date = z.string().max(64).datetime({ offset: true });
const overviewSchema = z.object({ id: identifier, service: serviceName, status });
const issueSchema = z.object({
  id: identifier, service: serviceName, status,
  classification: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  impactDescription: z.string().nullable().optional(),
  feature: z.string().nullable().optional(), featureGroup: z.string().nullable().optional(),
  startDateTime: date.nullable().optional(), endDateTime: date.nullable().optional(),
  lastModifiedDateTime: date, isResolved: z.boolean(),
  posts: z.array(z.object({
    createdDateTime: date, postType: z.string(),
    description: z.object({ contentType: z.string(), content: z.string() }),
  })).optional(),
});
export type ServiceHealthOverview = z.infer<typeof overviewSchema>;
export type ServiceHealthIssue = z.infer<typeof issueSchema>;
export function getServiceHealthOverviews(graph: GraphClient, signal: AbortSignal): Promise<ServiceHealthOverview[]> {
  return readProviderCollection(graph, "/admin/serviceAnnouncement/healthOverviews", overviewSchema, signal, "v1.0");
}
export function getServiceHealthIssues(
  graph: GraphClient, service: ServiceConfig["type"], window: CommunicationWindow, signal: AbortSignal,
): Promise<ServiceHealthIssue[]> {
  const query = new URLSearchParams({
    "$filter": `service eq '${serviceHealthNames[service]}' and (isResolved eq false or lastModifiedDateTime ge ${window.startAt})`,
    "$select": "id,service,status,isResolved,classification,title,impactDescription,feature,featureGroup,startDateTime,endDateTime,lastModifiedDateTime,posts",
  });
  return readProviderCollection(graph, "/admin/serviceAnnouncement/issues", issueSchema, signal, "v1.0", `?${query}`);
}

export function summarizeServiceHealthIssue(issue: ServiceHealthIssue): IssueCommunication {
  const latestPost = issue.posts?.toSorted((left, right) =>
    Date.parse(right.createdDateTime) - Date.parse(left.createdDateTime))[0];
  const title = boundedPlainText(issue.title ?? "", 160);
  const excerpt = communicationExcerpt(latestPost?.description ?? { contentType: "text", content: issue.impactDescription ?? "" });
  const classification = issue.classification === null || issue.classification === undefined
    ? undefined : boundedPlainText(issue.classification, 80);
  return {
    id: issue.id, source: "serviceAnnouncement.issues",
    title: title.text, sourceService: issue.service, sourceUrl: communicationSourceUrl("issues", issue.id),
    lastUpdatedAt: issue.lastModifiedDateTime,
    status: issue.status, ...(classification ? { classification: classification.text } : {}),
    excerpt: excerpt.text, textTruncated: title.truncated || excerpt.truncated || classification?.truncated === true,
  };
}

export function normalizeServiceHealthIssue(
  issue: ServiceHealthIssue, service: ServiceConfig["type"], collectedAt: string,
): ProviderDiagnostic {
  let truncated = false;
  const clip = (value: string, length: number) => {
    if (value.length > length) truncated = true;
    return value.slice(0, length);
  };
  const { posts, ...fields } = issue;
  const metadata: Record<string, unknown> = Object.fromEntries(Object.entries(fields).map(([key, value]) =>
    [key, typeof value === "string" ? clip(value, key === "impactDescription" ? 1000 : 300) : value],
  ));
  if (posts !== undefined) {
    if (posts.length > 10) truncated = true;
    metadata.postsTotal = posts.length;
    metadata.posts = posts.toSorted((left, right) =>
      Date.parse(right.createdDateTime) - Date.parse(left.createdDateTime)).slice(0, 10).map(post => {
      const excerpt = communicationExcerpt(post.description);
      if (excerpt.truncated) truncated = true;
      return {
        createdDateTime: post.createdDateTime, postType: clip(post.postType, 64),
        description: { contentType: "text", content: clip(excerpt.text, 300) },
      };
    });
  }
  // Bound the serialized attribute too: escaping can expand even short input strings.
  while (JSON.stringify(metadata).length > 5900) {
    const boundedPosts = metadata.posts as unknown[] | undefined;
    if (boundedPosts?.length) boundedPosts.pop();
    else {
      for (const key of ["title", "impactDescription", "feature", "featureGroup", "classification"]) {
        if (typeof metadata[key] === "string") metadata[key] = (metadata[key] as string).slice(0, 64);
      }
    }
    truncated = true;
  }
  metadata.truncated = truncated;
  return {
    kind: "issue", service, collectedAt, issueId: issue.id, serviceName: issue.service,
    status: issue.status, metadata: JSON.stringify(metadata), truncated,
  };
}

export function serviceHealthSources(service: ServiceConfig["type"]): ProviderSourceDefinition[] {
  const name = serviceHealthNames[service];
  return [
    {
      source: "serviceAnnouncement.healthOverviews", apiVersion: "v1.0",
      async collect(graph, signal, collectedAt) {
        const records = (await getServiceHealthOverviews(graph, signal)).filter(item =>
          item.service === name && (service !== "onedrive" || item.id === "OneDriveForBusiness"));
        if (!records.length) throw new ProviderCollectionError("no-data");
        return records.map(item => ({
          kind: "overview" as const, service, collectedAt,
          serviceId: item.id, serviceName: item.service, status: item.status,
        }));
      },
    },
    {
      source: "serviceAnnouncement.issues", apiVersion: "v1.0",
      async collect(graph, signal, collectedAt) {
        const window = communicationWindow(collectedAt);
        const issues = distinctCommunications(await getServiceHealthIssues(graph, service, window, signal))
          .filter(item => item.service === name)
          .toSorted(compareCommunicationUpdates);
        const recent = issues.filter(item => recentlyUpdated(item.lastModifiedDateTime, window));
        return [
          ...issues.map(item => normalizeServiceHealthIssue(item, service, collectedAt)),
          {
            kind: "issue-summary" as const, service, collectedAt, window,
            count: issues.filter(item => !item.isResolved).length, recentCount: recent.length,
            summaries: recent.map(summarizeServiceHealthIssue),
          },
        ];
      },
    },
  ];
}
