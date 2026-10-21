import { z } from "zod";
import type { GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";
import { readFile, type FileAttempt } from "./steps.js";

const renamedFileSchema = z.object({ id: z.string().min(1), name: z.string() });

function itemPath(attempt: FileAttempt, fileId: string): string {
  if (attempt.uploadedFileId !== fileId) throw new IntegrationError("collector-failure");
  return `/drives/${encodeURIComponent(attempt.driveId)}/items/${encodeURIComponent(fileId)}`;
}

export function renamedFileName(attempt: FileAttempt): string {
  return `ahm-synthetic-${attempt.correlationId}-renamed.txt`;
}

function verifyRenamedFile(file: z.infer<typeof renamedFileSchema>, attempt: FileAttempt, fileId: string): void {
  if (file.id !== fileId || file.name !== renamedFileName(attempt)) {
    throw new IntegrationError("read-failure");
  }
}

export async function renameFile(
  graph: GraphClient, attempt: FileAttempt, fileId: string, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const file = await graph.json(itemPath(attempt, fileId), renamedFileSchema, signal, "PATCH", {
    name: renamedFileName(attempt),
  }, false);
  verifyRenamedFile(file, attempt, fileId);
}

export async function readRenamedFile(
  graph: GraphClient, attempt: FileAttempt, fileId: string, signal: AbortSignal,
): Promise<void> {
  const query = new URLSearchParams({ "$select": "id,name" });
  const file = await graph.json(`${itemPath(attempt, fileId)}?${query}`, renamedFileSchema, signal);
  verifyRenamedFile(file, attempt, fileId);
  await readFile(graph, attempt, fileId, signal);
}
