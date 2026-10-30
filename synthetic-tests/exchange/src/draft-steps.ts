import { z } from "zod";
import type { GraphOperations } from "../../utils/src/integrations/graph.js";
import { IntegrationError } from "../../utils/src/integrations/http.js";
import { mailMarker, type MailAttempt } from "./steps.js";

const savedDraftSchema = z.object({
  id: z.string().min(1),
  subject: z.string(),
  bodyPreview: z.string(),
  isDraft: z.boolean(),
});

/**
 * Builds the Graph API path for a draft message after verifying that the draft ID
 * belongs to the current synthetic attempt.
 */
function draftPath(attempt: MailAttempt, draftId: string): string {
  if (!attempt.ownedMessageIds.has(draftId)) {
    throw new IntegrationError("collector-failure");
  }
  const encodedMailbox = encodeURIComponent(attempt.mailbox);
  const encodedDraftId = encodeURIComponent(draftId);
  return `/users/${encodedMailbox}/messages/${encodedDraftId}`;
}

/**
 * Formats the expected body text written when updating a synthetic draft message.
 */
export function editedDraftContent(attempt: MailAttempt): string {
  return `Edited synthetic draft ${attempt.correlationId}. Safe to delete.`;
}

/**
 * Updates the body content of an existing synthetic draft message in Exchange.
 */
export async function updateDraft(
  graph: GraphOperations,
  attempt: MailAttempt,
  draftId: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const updatePayload = {
    body: {
      contentType: "Text",
      content: editedDraftContent(attempt),
    },
  };
  await graph.request(
    draftPath(attempt, draftId),
    signal,
    "PATCH",
    updatePayload,
    false,
  );
}

/**
 * Reads a synthetic draft message from Exchange and verifies its subject, draft flag,
 * and expected body preview before or after an edit.
 */
export async function readDraft(
  graph: GraphOperations,
  attempt: MailAttempt,
  draftId: string,
  signal: AbortSignal,
  edited = true,
): Promise<void> {
  const query = new URLSearchParams({
    "$select": "id,subject,bodyPreview,isDraft",
  });
  const draft = await graph.json(
    `${draftPath(attempt, draftId)}?${query}`,
    savedDraftSchema,
    signal,
  );

  const expectedSubject = `AHM synthetic ${attempt.correlationId}`;
  let expectedBodyPreview = `${mailMarker(attempt)}. Safe to delete.`;
  if (edited) {
    expectedBodyPreview = editedDraftContent(attempt);
  }

  const hasMatchingId = draft.id === draftId;
  const hasMatchingSubject = draft.subject === expectedSubject;
  const hasMatchingBody = draft.bodyPreview === expectedBodyPreview;

  if (!hasMatchingId || !hasMatchingSubject || !draft.isDraft || !hasMatchingBody) {
    throw new IntegrationError("read-failure");
  }
}

/**
 * Deletes the synthetic draft message from Exchange and removes its ID from the owned set.
 */
export async function deleteDraft(
  graph: GraphOperations,
  attempt: MailAttempt,
  draftId: string,
  signal: AbortSignal,
): Promise<void> {
  await graph.request(draftPath(attempt, draftId), signal, "DELETE");
  attempt.ownedMessageIds.delete(draftId);
}
