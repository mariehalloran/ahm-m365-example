import { z } from "zod";
import { graphNextPagePath, type GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";

const driveItemSchema = z.object({ id: z.string().min(1), name: z.string() });
const siteDrivesSchema = z.object({
  value: z.array(z.object({ id: z.string() })), "@odata.nextLink": z.string().optional(),
});

export interface FileAttempt {
  siteId: string;
  driveId: string;
  folderId: string;
  correlationId: string;
  mutationAttempted: boolean;
  uploadedFileId?: string;
}

function paths(attempt: FileAttempt) {
  const drive = `/drives/${encodeURIComponent(attempt.driveId)}`;
  const name = `ahm-synthetic-${attempt.correlationId}.txt`;
  return { drive, name, file: `${drive}/items/${encodeURIComponent(attempt.folderId)}:/${name}` };
}

export async function authenticate(graph: GraphClient | undefined, signal: AbortSignal): Promise<GraphClient> {
  if (!graph) throw new IntegrationError("collector-failure");
  await graph.authenticate(signal);
  return graph;
}

export async function verifyDrive(graph: GraphClient, attempt: FileAttempt, signal: AbortSignal): Promise<void> {
  const collection = `/sites/${encodeURIComponent(attempt.siteId)}/drives`;
  let path: string | undefined = `${collection}?$select=id`;
  for (let page = 0; page < 5 && path; page++) {
    const drives: z.infer<typeof siteDrivesSchema> = await graph.json(path, siteDrivesSchema, signal);
    if (drives.value.some(drive => drive.id === attempt.driveId)) return;
    path = drives["@odata.nextLink"] ? graphNextPagePath(drives["@odata.nextLink"], collection) : undefined;
  }
  throw new IntegrationError(path ? "read-failure" : "permission-failure");
}

export async function uploadFile(graph: GraphClient, attempt: FileAttempt, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const location = paths(attempt);
  attempt.mutationAttempted = true;
  const file = await graph.json(`${location.file}:/content`, driveItemSchema, signal, "PUT", {
    correlationId: attempt.correlationId,
  }, false);
  if (file.name !== location.name) throw new IntegrationError("malformed-response");
  attempt.uploadedFileId = file.id;
  return file.id;
}

export async function readFile(graph: GraphClient, attempt: FileAttempt, fileId: string, signal: AbortSignal): Promise<void> {
  const content = await graph.downloadJson(`${paths(attempt).drive}/items/${encodeURIComponent(fileId)}/content`, signal);
  if (!z.object({ correlationId: z.literal(attempt.correlationId) }).strict().safeParse(content).success) {
    throw new IntegrationError("read-failure");
  }
}

export async function cleanup(graph: GraphClient, attempt: FileAttempt, signal: AbortSignal): Promise<void> {
  const location = paths(attempt);
  // The generated path permits cleanup after an ambiguous or malformed upload response.
  const path = attempt.uploadedFileId
    ? `${location.drive}/items/${encodeURIComponent(attempt.uploadedFileId)}` : location.file;
  await graph.request(path, signal, "DELETE");
}
