import { z } from "zod";
import type { GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";
import { mailMarker, type MailAttempt } from "./steps.js";

const savedDraftSchema = z.object({
  id: z.string().min(1),
  subject: z.string(),
  bodyPreview: z.string(),
  isDraft: z.boolean(),
});

function draftPath(attempt: MailAttempt, draftId: string): string {
  if (!attempt.ownedMessageIds.has(draftId)) throw new IntegrationError("collector-failure");
  return `/users/${encodeURIComponent(attempt.mailbox)}/messages/${encodeURIComponent(draftId)}`;
}

export function editedDraftContent(attempt: MailAttempt): string {
  return `Edited synthetic draft ${attempt.correlationId}. Safe to delete.`;
}

export async function updateDraft(
  graph: GraphClient, attempt: MailAttempt, draftId: string, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await graph.request(draftPath(attempt, draftId), signal, "PATCH", {
    body: { contentType: "Text", content: editedDraftContent(attempt) },
  }, false);
}

export async function readDraft(
  graph: GraphClient, attempt: MailAttempt, draftId: string, signal: AbortSignal, edited = true,
): Promise<void> {
  const query = new URLSearchParams({ "$select": "id,subject,bodyPreview,isDraft" });
  const draft = await graph.json(`${draftPath(attempt, draftId)}?${query}`, savedDraftSchema, signal);
  if (draft.id !== draftId || draft.subject !== `AHM synthetic ${attempt.correlationId}` ||
      !draft.isDraft || draft.bodyPreview !== (edited ? editedDraftContent(attempt) : `${mailMarker(attempt)}. Safe to delete.`)) {
    throw new IntegrationError("read-failure");
  }
}

export async function deleteDraft(graph: GraphClient, attempt: MailAttempt, draftId: string, signal: AbortSignal): Promise<void> {
  await graph.request(draftPath(attempt, draftId), signal, "DELETE");
  attempt.ownedMessageIds.delete(draftId);
}
