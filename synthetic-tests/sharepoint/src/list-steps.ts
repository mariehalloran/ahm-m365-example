import { z } from "zod";
import type { LiveProbeFor } from "../../utils/src/configuration/resolved-probes.js";
import { graphNextPagePath, type GraphOperations } from "../../utils/src/integrations/graph.js";
import { IntegrationError } from "../../utils/src/integrations/http.js";
import { sitePath } from "./targets.js";

const itemSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/),
  fields: z.object({ Title: z.string().nullable().optional() }),
});
type ListItem = z.infer<typeof itemSchema>;
export interface ListAttempt {
  probe: LiveProbeFor<"sharepoint-list-item">;
  correlationId: string;
  itemId?: string;
  mutationAttempted: boolean;
}

/** Uses only the ordinary Title field, with an unguessable attempt-specific ownership marker. */
export function listTitle(attempt: ListAttempt, revision: 1 | 2): string {
  return `AHM SharePoint ${attempt.probe.id} ${attempt.correlationId} revision ${revision}`;
}

/** Addresses items only in the approved site's bound list. */
function itemsPath(attempt: ListAttempt): string {
  return `${sitePath(attempt.probe.siteId)}/lists/${encodeURIComponent(attempt.probe.listId)}/items`;
}

/** Requires a server-issued item ID before an item-specific mutation or read. */
function itemPath(attempt: ListAttempt): string {
  if (!attempt.itemId || !/^[1-9]\d*$/.test(attempt.itemId)) throw new IntegrationError("configuration-failure");
  return `${itemsPath(attempt)}/${encodeURIComponent(attempt.itemId)}`;
}

/** Rejects an item whose ID or Title no longer identifies this attempt. */
function verifyOwnedItem(attempt: ListAttempt, item: ListItem, revision?: 1 | 2): void {
  const titles = revision ? [listTitle(attempt, revision)] : [listTitle(attempt, 1), listTitle(attempt, 2)];
  if ((attempt.itemId && item.id !== attempt.itemId) || !titles.includes(item.fields.Title ?? "")) {
    throw new IntegrationError("read-failure", undefined, "list-item-ownership-or-title-mismatch");
  }
}

/** Records the created ID without assuming expanded fields; the business read verifies persisted Title. */
export async function createListItem(graph: GraphOperations, attempt: ListAttempt, signal: AbortSignal): Promise<void> {
  attempt.mutationAttempted = true;
  const item = await graph.json(itemsPath(attempt), itemSchema.pick({ id: true }), signal, "POST", {
    fields: { Title: listTitle(attempt, 1) },
  }, false);
  attempt.itemId = item.id;
}

/** Reads persisted fields and verifies the exact expected revision, not just HTTP success. */
export async function readListItem(
  graph: GraphOperations, attempt: ListAttempt, revision: 1 | 2, signal: AbortSignal,
): Promise<void> {
  const item = await graph.json(`${itemPath(attempt)}?$expand=fields($select=Title)`, itemSchema, signal);
  verifyOwnedItem(attempt, item, revision);
}

/** Changes only this attempt's Title after rechecking ownership. */
export async function updateListItem(graph: GraphOperations, attempt: ListAttempt, signal: AbortSignal): Promise<void> {
  await readListItem(graph, attempt, 1, signal);
  const fields = await graph.json(`${itemPath(attempt)}/fields`, z.object({ Title: z.string() }), signal, "PATCH", {
    Title: listTitle(attempt, 2),
  });
  if (fields.Title !== listTitle(attempt, 2)) throw new IntegrationError("read-failure");
}

/** Treats only 404 as verified absence; authorization or network errors must not masquerade as deletion. */
async function optionalListItem(graph: GraphOperations, attempt: ListAttempt, signal: AbortSignal): Promise<ListItem | undefined> {
  try { return await graph.json(`${itemPath(attempt)}?$expand=fields($select=Title)`, itemSchema, signal); }
  catch (error) {
    if (error instanceof IntegrationError && error.status === 404) return undefined;
    throw error;
  }
}

/** Recovers a lost create response by exact nonce Title, without requiring an indexed/custom column. */
async function recoverListItem(graph: GraphOperations, attempt: ListAttempt, signal: AbortSignal): Promise<string | undefined> {
  const collection = itemsPath(attempt);
  const schema = z.object({ value: z.array(itemSchema).max(200), "@odata.nextLink": z.string().optional() });
  let path: string | undefined = `${collection}?$expand=fields($select=Title)&$top=200`;
  const matches: ListItem[] = [];
  for (let page = 0; path && page < 20; page++) {
    const response: z.infer<typeof schema> = await graph.json(path, schema, signal);
    matches.push(...response.value.filter(item => item.fields.Title === listTitle(attempt, 1)));
    path = response["@odata.nextLink"] ? graphNextPagePath(response["@odata.nextLink"], collection) : undefined;
  }
  if (path || matches.length > 1) throw new IntegrationError("read-failure", undefined, "ambiguous-list-item-ownership");
  return matches[0]?.id;
}

/** Deletes only this attempt's verified item and requires a subsequent 404, never deleting list/site roots. */
export async function deleteOwnedListItem(graph: GraphOperations, attempt: ListAttempt, signal: AbortSignal): Promise<void> {
  if (!attempt.mutationAttempted) return;
  if (!attempt.itemId) {
    const recovered = await recoverListItem(graph, attempt, signal);
    if (!recovered) { attempt.mutationAttempted = false; return; }
    attempt.itemId = recovered;
  }
  const item = await optionalListItem(graph, attempt, signal);
  if (item) {
    verifyOwnedItem(attempt, item);
    await graph.request(itemPath(attempt), signal, "DELETE");
    if (await optionalListItem(graph, attempt, signal)) throw new IntegrationError("read-failure");
  }
  attempt.mutationAttempted = false;
}
