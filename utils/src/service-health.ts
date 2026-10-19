import { z } from "zod";
import type { GraphClient } from "./graph.js";
import { ProviderCollectionError, readProviderCollection, type ProviderSourceDefinition } from "./provider-collection.js";
import type { ProviderDiagnostic } from "./provider-diagnostics.js";
import type { ServiceConfig } from "./service-config.js";

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
  lastModifiedDateTime: date.nullable().optional(), isResolved: z.boolean().optional(),
  posts: z.array(z.object({
    createdDateTime: date, postType: z.string(),
    description: z.object({ contentType: z.string(), content: z.string() }),
  })).optional(),
});
export type ServiceHealthOverview = z.infer<typeof overviewSchema>;
export type ServiceHealthIssue = z.infer<typeof issueSchema>;
export const serviceHealthNames = {
  exchange: "Exchange Online", teams: "Microsoft Teams", sharepoint: "SharePoint Online",
} as const;

export function getServiceHealthOverviews(graph: GraphClient, signal: AbortSignal): Promise<ServiceHealthOverview[]> {
  return readProviderCollection(graph, "/admin/serviceAnnouncement/healthOverviews", overviewSchema, signal, "v1.0");
}
export function getServiceHealthIssues(graph: GraphClient, signal: AbortSignal): Promise<ServiceHealthIssue[]> {
  return readProviderCollection(graph, "/admin/serviceAnnouncement/issues", issueSchema, signal, "v1.0");
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
    metadata.posts = posts.slice(0, 10).map(post => ({
      createdDateTime: post.createdDateTime, postType: clip(post.postType, 64),
      description: { contentType: clip(post.description.contentType, 32), content: clip(post.description.content, 300) },
    }));
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
        const records = (await getServiceHealthOverviews(graph, signal)).filter(item => item.service === name);
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
        return (await getServiceHealthIssues(graph, signal))
          .filter(item => item.service === name).map(item => normalizeServiceHealthIssue(item, service, collectedAt));
      },
    },
  ];
}
