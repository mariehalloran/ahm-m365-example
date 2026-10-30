import { createHash } from "node:crypto";
import { z } from "zod";
import type { OneDriveProbe } from "../../utils/src/resolved-probes.js";
import { graphNextPagePath, type GraphFileOperations } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";

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
export interface Payload {
  schemaVersion: "1.0";
  owner: "ahm-onedrive";
  targetId: string;
  userId: string;
  correlationId: string;
  revision: 1 | 2;
  text: string;
  sha256: string;
}

export interface FileAttempt {
  probe: OneDriveProbe;
  correlationId: string;
  driveId: string;
  parentId: string;
  folderName: string;
  folderId?: string;
  fileId?: string;
  mutationAttempted: boolean;
}

const encoded = encodeURIComponent;
export const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const drivePath = (attempt: FileAttempt) => `/drives/${encoded(attempt.driveId)}`;
const itemPath = (attempt: FileAttempt, id: string) => `${drivePath(attempt)}/items/${encoded(id)}`;
const childPath = (attempt: FileAttempt, parentId: string, name: string) => `${itemPath(attempt, parentId)}:/${encoded(name)}`;

export function payload(attempt: FileAttempt, revision: 1 | 2): Payload {
  const text = `OneDrive synthetic ${attempt.correlationId} revision ${revision}`;
  return {
    schemaVersion: "1.0", owner: "ahm-onedrive", targetId: attempt.probe.id,
    userId: attempt.probe.userId, correlationId: attempt.correlationId, revision, text, sha256: digest(text),
  };
}

function validateItem(attempt: FileAttempt, item: Item, name: string, parentId: string, folder: boolean): Item {
  if (item.name !== name || item.id === parentId || item.parentReference.id !== parentId ||
      item.parentReference.driveId !== attempt.driveId || !(folder ? item.folder : item.file)) {
    throw new IntegrationError("malformed-response");
  }
  return item;
}

async function getOptional(graph: GraphFileOperations, path: string, signal: AbortSignal): Promise<Item | undefined> {
  try { return await graph.json(path, itemSchema, signal); }
  catch (error) {
    if (error instanceof IntegrationError && error.status === 404) return undefined;
    throw error;
  }
}

export async function verifySelectedFolder(graph: GraphFileOperations, attempt: FileAttempt, signal: AbortSignal): Promise<void> {
  if (!attempt.driveId || !attempt.parentId || !attempt.probe.folderName) throw new IntegrationError("configuration-failure");
  const folder = await graph.json(itemPath(attempt, attempt.parentId), itemSchema, signal);
  if (!folder.folder || folder.id !== attempt.parentId || folder.name !== attempt.probe.folderName ||
      folder.parentReference.driveId !== attempt.driveId) throw new IntegrationError("configuration-failure");
}

async function createFolder(graph: GraphFileOperations, attempt: FileAttempt, signal: AbortSignal): Promise<void> {
  attempt.mutationAttempted = true;
  const folder = await graph.json(`${itemPath(attempt, attempt.parentId)}/children`, itemSchema, signal, "POST", {
    name: attempt.folderName, folder: {}, "@microsoft.graph.conflictBehavior": "fail",
  }, false);
  attempt.folderId = validateItem(attempt, folder, attempt.folderName, attempt.parentId, true).id;
}

export async function createOwnedFolder(graph: GraphFileOperations, attempt: FileAttempt, signal: AbortSignal): Promise<void> {
  await verifySelectedFolder(graph, attempt, signal);
  await createFolder(graph, attempt, signal);
}

export async function writeFile(
  graph: GraphFileOperations, attempt: FileAttempt, value: Payload, signal: AbortSignal, name = "probe.json",
): Promise<string> {
  if (!attempt.folderId) throw new IntegrationError("configuration-failure");
  attempt.mutationAttempted = true;
  const file = await graph.json(`${childPath(attempt, attempt.folderId, name)}:/content`, itemSchema, signal, "PUT", value, false);
  return validateItem(attempt, file, name, attempt.folderId, false).id;
}

export async function downloadFile(graph: GraphFileOperations, attempt: FileAttempt, fileId: string, signal: AbortSignal): Promise<Buffer> {
  return graph.downloadContent(`${itemPath(attempt, fileId)}/content`, signal);
}

export function verifyBytes(actual: Buffer, expected: Payload): void {
  if (digest(actual) !== digest(JSON.stringify(expected))) throw new IntegrationError("read-failure");
}

export async function reopenOwnedFile(graph: GraphFileOperations, attempt: FileAttempt, signal: AbortSignal): Promise<Buffer> {
  const collection = `${itemPath(attempt, attempt.folderId!)}/children`;
  let path: string | undefined = `${collection}?$top=200`;
  for (let page = 0; page < 5 && path; page++) {
    const items: z.infer<typeof collectionSchema> = await graph.json(path, collectionSchema, signal);
    const file = items.value.find(item => item.id === attempt.fileId);
    if (file) {
      validateItem(attempt, file, "probe.json", attempt.folderId!, false);
      return downloadFile(graph, attempt, file.id, signal);
    }
    path = items["@odata.nextLink"] ? graphNextPagePath(items["@odata.nextLink"], collection) : undefined;
  }
  throw new IntegrationError("read-failure");
}

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

export async function deleteOwnedFolder(graph: GraphFileOperations, attempt: FileAttempt, signal: AbortSignal): Promise<void> {
  if (!attempt.driveId || !attempt.parentId) throw new IntegrationError("configuration-failure");
  if (!attempt.folderId) {
    const folder = await getOptional(graph, childPath(attempt, attempt.parentId, attempt.folderName), signal);
    if (!folder) { attempt.mutationAttempted = false; return; }
    attempt.folderId = validateItem(attempt, folder, attempt.folderName, attempt.parentId, true).id;
  }
  await deleteVerified(graph, attempt, attempt.folderId, attempt.folderName, attempt.parentId, true, signal);
  attempt.mutationAttempted = false;
}

export async function openAppFolder(graph: GraphFileOperations, attempt: FileAttempt, signal: AbortSignal): Promise<void> {
  // AppFolder-only access need not permit reading the drive root; resolve through the approved user instead.
  const root = await graph.json(`/users/${encoded(attempt.probe.userId)}/drive/special/approot`,
    z.object({
      id: z.string().min(1), folder: z.object({}), specialFolder: z.object({ name: z.literal("approot") }),
      parentReference: z.object({ driveId: z.string().min(1) }),
    }), signal);
  if (attempt.driveId && root.parentReference.driveId !== attempt.driveId) throw new IntegrationError("configuration-failure");
  attempt.driveId = root.parentReference.driveId;
  attempt.parentId = root.id;
  await createFolder(graph, attempt, signal);
}

export async function listVersions(graph: GraphFileOperations, attempt: FileAttempt, signal: AbortSignal): Promise<string[]> {
  const collection = `${itemPath(attempt, attempt.fileId!)}/versions`;
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

export async function findPriorVersion(
  graph: GraphFileOperations, attempt: FileAttempt, versions: string[], expected: Payload, signal: AbortSignal,
): Promise<Payload | undefined> {
  // Graph returns newest/current first; /versions/{current}/content is explicitly unsupported.
  for (const version of versions.slice(1).reverse().slice(0, 10)) {
    const bytes = await graph.downloadContent(`${itemPath(attempt, attempt.fileId!)}/versions/${encoded(version)}/content`, signal);
    if (digest(bytes) === digest(JSON.stringify(expected))) return expected;
  }
  return undefined;
}
