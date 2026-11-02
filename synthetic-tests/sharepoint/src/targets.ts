import { z } from "zod";
import type { ServiceConfig } from "../../utils/src/configuration/service-config.js";
import { sharePointSiteUrlSchema, type SharePointLocation } from "../../utils/src/configuration/sharepoint-target.js";
import { graphNextPagePath, type GraphOperations } from "../../utils/src/integrations/graph.js";
import { IntegrationError } from "../../utils/src/integrations/http.js";

export type SharePointTarget = Extract<ServiceConfig, { type: "sharepoint" }>["targets"][number];
const encoded = encodeURIComponent;
const siteSchema = z.object({ id: z.string().min(1), webUrl: sharePointSiteUrlSchema });
const driveSchema = z.object({ id: z.string().min(1), name: z.string(), driveType: z.string() });
const listSchema = z.object({
  id: z.string().uuid(), displayName: z.string(), list: z.object({ template: z.string() }),
});
const folderSchema = z.object({
  id: z.string().min(1), name: z.string(), folder: z.object({}),
  parentReference: z.object({ driveId: z.string().min(1) }), root: z.object({}).optional(),
});

/** Addresses only the explicitly bound site, never tenant-wide site search. */
export function sitePath(siteId: string): string {
  if (!siteId) throw new IntegrationError("configuration-failure");
  return `/sites/${encoded(siteId)}`;
}

/** Confirms that a discovered/bound site is exactly the user-approved site URL. */
function verifySiteUrl(actual: string, expected: string): void {
  if (actual.toLowerCase() !== expected.replace(/\/$/, "").toLowerCase()) {
    throw new IntegrationError("configuration-failure", undefined, "selected-site-mismatch");
  }
}

/** Verifies the pinned site binding before any mutation. */
export async function verifySharePointSite(
  graph: GraphOperations, target: Pick<SharePointLocation, "siteUrl"> & { siteId: string }, signal: AbortSignal,
): Promise<void> {
  const site = await graph.json(`${sitePath(target.siteId)}?$select=id,webUrl`, siteSchema, signal);
  if (site.id !== target.siteId) throw new IntegrationError("configuration-failure");
  verifySiteUrl(site.webUrl, target.siteUrl);
}

/** Reads only one site's library inventory and rejects incomplete or duplicate pagination. */
async function siteDrives(graph: GraphOperations, siteId: string, signal: AbortSignal): Promise<z.infer<typeof driveSchema>[]> {
  const collection = `${sitePath(siteId)}/drives`;
  const schema = z.object({ value: z.array(driveSchema).max(200), "@odata.nextLink": z.string().optional() });
  let path: string | undefined = `${collection}?$select=id,name,driveType&$top=200`;
  const drives: z.infer<typeof driveSchema>[] = [];
  for (let page = 0; path && page < 20; page++) {
    const response: z.infer<typeof schema> = await graph.json(path, schema, signal);
    drives.push(...response.value);
    path = response["@odata.nextLink"] ? graphNextPagePath(response["@odata.nextLink"], collection) : undefined;
  }
  if (path || new Set(drives.map(drive => drive.id)).size !== drives.length) throw new IntegrationError("read-failure");
  return drives;
}

/** Resolves the pre-existing named child folder; library roots are never accepted as test folders. */
async function selectedFolder(
  graph: GraphOperations, driveId: string, folderName: string, signal: AbortSignal,
): Promise<z.infer<typeof folderSchema>> {
  const folder = await graph.json(`/drives/${encoded(driveId)}/root:/${encoded(folderName)}`, folderSchema, signal);
  if (folder.name !== folderName || folder.parentReference.driveId !== driveId || folder.root) {
    throw new IntegrationError("configuration-failure", undefined, "selected-folder-mismatch");
  }
  return folder;
}

/** Prevents stale or cross-site drive/folder bindings from reaching any document write. */
export async function verifySharePointLibrary(
  graph: GraphOperations,
  target: SharePointLocation & { siteId: string; driveId: string; folderId: string },
  signal: AbortSignal,
): Promise<void> {
  const drives = await siteDrives(graph, target.siteId, signal);
  const matches = drives.filter(drive => drive.name === target.libraryName);
  if (matches.length !== 1 || matches[0]!.id !== target.driveId || matches[0]!.driveType !== "documentLibrary") {
    throw new IntegrationError("configuration-failure", undefined, "selected-library-mismatch");
  }
  if ((await selectedFolder(graph, target.driveId, target.folderName, signal)).id !== target.folderId) {
    throw new IntegrationError("configuration-failure", undefined, "selected-folder-binding-mismatch");
  }
}

/** Confirms the bound destination is the ordinary named list, not a document library or another site's list. */
export async function verifySharePointList(
  graph: GraphOperations, target: Pick<SharePointLocation, "listName"> & { siteId: string; listId: string }, signal: AbortSignal,
): Promise<void> {
  const list = await graph.json(`${sitePath(target.siteId)}/lists/${encoded(target.listId)}?$select=id,displayName,list`, listSchema, signal);
  if (list.id !== target.listId || list.displayName !== target.listName || list.list.template !== "genericList") {
    throw new IntegrationError("configuration-failure", undefined, "selected-list-mismatch");
  }
}

/** Resolves existing site/library/folder/list IDs using read-only Graph calls and no permission/provisioning APIs. */
export async function discoverSharePointBindings(
  graph: GraphOperations, target: SharePointLocation, signal: AbortSignal,
): Promise<{ siteId: string; driveId: string; folderId: string; listId: string }> {
  const url = new URL(target.siteUrl);
  const site = await graph.json(`/sites/${encoded(url.hostname)}:${url.pathname}?$select=id,webUrl`, siteSchema, signal);
  verifySiteUrl(site.webUrl, target.siteUrl);
  const drives = (await siteDrives(graph, site.id, signal)).filter(drive => drive.name === target.libraryName);
  if (drives.length !== 1 || drives[0]!.driveType !== "documentLibrary") {
    throw new IntegrationError("configuration-failure", undefined, "named-library-not-unique");
  }
  const driveId = drives[0]!.id;
  const folder = await selectedFolder(graph, driveId, target.folderName, signal);
  const collection = `${sitePath(site.id)}/lists`;
  const schema = z.object({ value: z.array(listSchema).max(200), "@odata.nextLink": z.string().optional() });
  let path: string | undefined = `${collection}?$select=id,displayName,list&$top=200`;
  const lists: z.infer<typeof listSchema>[] = [];
  for (let page = 0; path && page < 20; page++) {
    const response: z.infer<typeof schema> = await graph.json(path, schema, signal);
    lists.push(...response.value);
    path = response["@odata.nextLink"] ? graphNextPagePath(response["@odata.nextLink"], collection) : undefined;
  }
  if (path || new Set(lists.map(list => list.id)).size !== lists.length) throw new IntegrationError("read-failure");
  const matches = lists.filter(list => list.displayName === target.listName && list.list.template === "genericList");
  if (matches.length !== 1) throw new IntegrationError("configuration-failure", undefined, "named-list-not-unique");
  return { siteId: site.id, driveId, folderId: folder.id, listId: matches[0]!.id };
}
