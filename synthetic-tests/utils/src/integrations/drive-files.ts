import { createHash } from "node:crypto";
import { z } from "zod";
import { graphNextPagePath, type GraphFileOperations } from "./graph.js";
import { IntegrationError } from "./http.js";

const parentSchema = z.object({ id: z.string().min(1), driveId: z.string().min(1) });
const itemSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), parentReference: parentSchema,
  folder: z.object({}).optional(), file: z.object({}).optional(),
});
type Item = z.infer<typeof itemSchema>;
const collectionSchema = z.object({ value: z.array(itemSchema).max(200), "@odata.nextLink": z.string().optional() });
const versionsSchema = z.object({
  value: z.array(z.object({ id: z.string().min(1).max(100) })).max(200), "@odata.nextLink": z.string().optional(),
});

export interface FileAttempt {
  probe: { folderName?: string };
  correlationId: string;
  driveId: string;
  parentId: string;
  folderName: string;
  folderId?: string;
  fileId?: string;
  mutationAttempted: boolean;
}
export type OwnedFolderAttempt = FileAttempt & { folderId: string };
export type WrittenFileAttempt = OwnedFolderAttempt & { fileId: string };
const encoded = encodeURIComponent;

/** Hashes the exact persisted byte representation. */
export function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Addresses only the selected drive. */
export function drivePath(attempt: FileAttempt): string {
  return `/drives/${encoded(attempt.driveId)}`;
}

/** Addresses an item without allowing its ID to change the Graph path. */
function itemPath(attempt: FileAttempt, id: string): string {
  return `${drivePath(attempt)}/items/${encoded(id)}`;
}

/** Addresses one named child of a selected item. */
function childPath(attempt: FileAttempt, parentId: string, name: string): string {
  return `${itemPath(attempt, parentId)}:/${encoded(name)}`;
}

/** Confirms an observed item's type, exact name and selected parent/drive. */
function validateItem(attempt: FileAttempt, item: Item, name: string, parentId: string, folder: boolean): Item {
  if (item.name !== name || item.id === parentId || item.parentReference.id !== parentId ||
      item.parentReference.driveId !== attempt.driveId || !(folder ? item.folder : item.file)) {
    throw new IntegrationError("malformed-response");
  }
  return item;
}

/** Treats only an actual missing item as absent; permission and transport failures remain failures. */
async function getOptional(graph: GraphFileOperations, path: string, signal: AbortSignal): Promise<Item | undefined> {
  try { return await graph.json(path, itemSchema, signal); }
  catch (error) {
    if (error instanceof IntegrationError && error.status === 404) return undefined;
    throw error;
  }
}

/** Verifies the configured, pre-approved parent folder without discovering or creating a root. */
export async function verifySelectedFolder(graph: GraphFileOperations, attempt: FileAttempt, signal: AbortSignal): Promise<void> {
  if (!attempt.driveId || !attempt.parentId || !attempt.probe.folderName) throw new IntegrationError("configuration-failure");
  const folder = await graph.json(itemPath(attempt, attempt.parentId), itemSchema, signal);
  if (!folder.folder || folder.id !== attempt.parentId || folder.name !== attempt.probe.folderName ||
      folder.parentReference.driveId !== attempt.driveId) throw new IntegrationError("configuration-failure");
}

/** Creates exactly this attempt's correlated folder; a name conflict never establishes cleanup ownership. */
export async function createAttemptFolder(
  graph: GraphFileOperations, attempt: FileAttempt, signal: AbortSignal,
): Promise<OwnedFolderAttempt> {
  if (attempt.folderName !== `ahm-synthetic-${attempt.correlationId}`) throw new IntegrationError("configuration-failure");
  attempt.mutationAttempted = true;
  try {
    const folder = await graph.json(`${itemPath(attempt, attempt.parentId)}/children`, itemSchema, signal, "POST", {
      name: attempt.folderName, folder: {}, "@microsoft.graph.conflictBehavior": "fail",
    }, false);
    return Object.assign(attempt, { folderId: validateItem(attempt, folder, attempt.folderName, attempt.parentId, true).id });
  } catch (error) {
    if (error instanceof IntegrationError && error.status === 409) attempt.mutationAttempted = false;
    throw error;
  }
}

/** Creates a cycle-owned folder only below the verified selected folder. */
export async function createOwnedFolder(graph: GraphFileOperations, attempt: FileAttempt, signal: AbortSignal): Promise<OwnedFolderAttempt> {
  await verifySelectedFolder(graph, attempt, signal);
  return createAttemptFolder(graph, attempt, signal);
}

/** Writes a small JSON document only inside this attempt's owned folder. */
export async function writeFile(
  graph: GraphFileOperations, attempt: OwnedFolderAttempt, value: object, signal: AbortSignal, name = "probe.json",
): Promise<string> {
  if (!attempt.folderId) throw new IntegrationError("configuration-failure");
  attempt.mutationAttempted = true;
  const file = await graph.json(`${childPath(attempt, attempt.folderId, name)}:/content`, itemSchema, signal, "PUT", value, false);
  return validateItem(attempt, file, name, attempt.folderId, false).id;
}

/** Downloads current content through the shared bounded, credential-free redirect handling. */
export async function downloadFile(graph: GraphFileOperations, attempt: FileAttempt, fileId: string, signal: AbortSignal): Promise<Buffer> {
  return graph.downloadContent(`${itemPath(attempt, fileId)}/content`, signal);
}

/** Requires byte-for-byte JSON content integrity, rather than a successful download status alone. */
export function verifyBytes(actual: Buffer, expected: object): void {
  if (digest(actual) !== digest(JSON.stringify(expected))) throw new IntegrationError("read-failure");
}

/** Enumerates only the owned folder, then reopens the exact document it contains. */
export async function reopenOwnedFile(graph: GraphFileOperations, attempt: WrittenFileAttempt, signal: AbortSignal): Promise<Buffer> {
  const collection = `${itemPath(attempt, attempt.folderId)}/children`;
  let path: string | undefined = `${collection}?$top=200`;
  for (let page = 0; page < 5 && path; page++) {
    const items: z.infer<typeof collectionSchema> = await graph.json(path, collectionSchema, signal);
    const file = items.value.find(item => item.id === attempt.fileId);
    if (file) {
      validateItem(attempt, file, "probe.json", attempt.folderId, false);
      return downloadFile(graph, attempt, file.id, signal);
    }
    path = items["@odata.nextLink"] ? graphNextPagePath(items["@odata.nextLink"], collection) : undefined;
  }
  throw new IntegrationError("read-failure");
}

/** Deletes only an item whose current metadata still proves this attempt's ownership and verifies absence. */
async function deleteVerified(
  graph: GraphFileOperations, attempt: FileAttempt, id: string, name: string, parentId: string, folder: boolean, signal: AbortSignal,
): Promise<void> {
  const current = await getOptional(graph, itemPath(attempt, id), signal);
  if (!current) return;
  validateItem(attempt, current, name, parentId, folder);
  if (current.id !== id) throw new IntegrationError("malformed-response");
  await graph.request(itemPath(attempt, id), signal, "DELETE");
  if (await getOptional(graph, itemPath(attempt, id), signal)) throw new IntegrationError("read-failure");
}

/** Recovers an ambiguous create by its nonce path, never deleting the configured parent or a conflicting folder. */
export async function deleteOwnedFolder(graph: GraphFileOperations, attempt: FileAttempt, signal: AbortSignal): Promise<void> {
  if (!attempt.mutationAttempted) return;
  if (!attempt.driveId || !attempt.parentId || attempt.folderName !== `ahm-synthetic-${attempt.correlationId}`) {
    throw new IntegrationError("configuration-failure");
  }
  if (!attempt.folderId) {
    const folder = await getOptional(graph, childPath(attempt, attempt.parentId, attempt.folderName), signal);
    if (!folder) { attempt.mutationAttempted = false; return; }
    attempt.folderId = validateItem(attempt, folder, attempt.folderName, attempt.parentId, true).id;
  }
  await deleteVerified(graph, attempt, attempt.folderId, attempt.folderName, attempt.parentId, true, signal);
  attempt.mutationAttempted = false;
}

/** Enumerates the document's actual version history, rejecting truncated or duplicate inventories. */
export async function listVersions(graph: GraphFileOperations, attempt: WrittenFileAttempt, signal: AbortSignal): Promise<string[]> {
  const collection = `${itemPath(attempt, attempt.fileId)}/versions`;
  let path: string | undefined = `${collection}?$top=200`;
  const ids: string[] = [];
  for (let page = 0; page < 5 && path; page++) {
    const versions: z.infer<typeof versionsSchema> = await graph.json(path, versionsSchema, signal);
    ids.push(...versions.value.map(version => version.id));
    path = versions["@odata.nextLink"] ? graphNextPagePath(versions["@odata.nextLink"], collection) : undefined;
  }
  if (path || new Set(ids).size !== ids.length) throw new IntegrationError("read-failure");
  return ids;
}

/** Downloads an older revision and requires its bytes to equal the first persisted revision. */
export async function findPriorVersion<T extends object>(
  graph: GraphFileOperations, attempt: WrittenFileAttempt, versions: string[], expected: T, signal: AbortSignal,
): Promise<T | undefined> {
  // Graph returns newest/current first; downloading /versions/{current}/content is unsupported.
  for (const version of versions.slice(1).reverse().slice(0, 10)) {
    const bytes = await graph.downloadContent(`${itemPath(attempt, attempt.fileId)}/versions/${encoded(version)}/content`, signal);
    if (digest(bytes) === digest(JSON.stringify(expected))) return expected;
  }
  return undefined;
}
