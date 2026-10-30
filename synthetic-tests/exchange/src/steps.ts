import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { GraphOperations } from "../../utils/src/integrations/graph.js";
import { IntegrationError } from "../../utils/src/integrations/http.js";
import { messageSelect, messagesSchema, ownedMessage } from "./mail-safety.js";

const messageSchema = z.object({
  id: z.string().min(1),
});

export interface MailAttempt {
  mailbox: string;
  correlationId: string;
  ownedMessageIds: Set<string>;
  mutationAttempted: boolean;
}

/**
 * Formats the synthetic email subject line for a mail attempt.
 */
export function mailSubject(attempt: MailAttempt): string {
  return `AHM synthetic ${attempt.correlationId}`;
}

/**
 * Formats the correlation marker embedded in a synthetic email body.
 */
export function mailMarker(attempt: MailAttempt): string {
  return `Synthetic ${attempt.correlationId}`;
}

/**
 * Builds the Graph endpoint paths used to create, poll, and clean up messages for a mail attempt.
 */
function paths(attempt: MailAttempt) {
  const mailboxPath = `/users/${encodeURIComponent(attempt.mailbox)}`;
  const query = new URLSearchParams({
    "$filter": `subject eq '${mailSubject(attempt)}'`,
    "$select": messageSelect,
    "$top": "100",
  });
  return {
    messages: `${mailboxPath}/messages`,
    inbox: `${mailboxPath}/mailFolders/inbox/messages?${query}`,
    copies: `${mailboxPath}/messages?${query}`,
  };
}

/**
 * Verifies that a Graph client is configured and authenticates it before running probe steps.
 */
export async function authenticate(
  graph: GraphOperations | undefined,
  signal: AbortSignal,
): Promise<GraphOperations> {
  if (!graph) {
    throw new IntegrationError("collector-failure");
  }
  await graph.authenticate(signal);
  return graph;
}

/**
 * Creates a self-addressed synthetic draft message in the target mailbox, optionally attaching
 * a base64-encoded text file, and records the created draft ID for cleanup.
 */
export async function createDraft(
  graph: GraphOperations,
  attempt: MailAttempt,
  signal: AbortSignal,
  attachment?: string,
): Promise<string> {
  signal.throwIfAborted();
  attempt.mutationAttempted = true;

  const draftPayload: Record<string, unknown> = {
    subject: mailSubject(attempt),
    body: {
      contentType: "Text",
      content: `${mailMarker(attempt)}. Safe to delete.`,
    },
    toRecipients: [
      {
        emailAddress: {
          address: attempt.mailbox,
        },
      },
    ],
    internetMessageHeaders: [
      {
        name: "x-ahm-correlation-id",
        value: attempt.correlationId,
      },
    ],
  };

  if (attachment !== undefined) {
    draftPayload.attachments = [
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: "synthetic.txt",
        contentType: "text/plain",
        contentBytes: attachment,
      },
    ];
  }

  const draft = await graph.json(
    paths(attempt).messages,
    messageSchema,
    signal,
    "POST",
    draftPayload,
    false,
  );
  attempt.ownedMessageIds.add(draft.id);
  return draft.id;
}

/**
 * Sends an existing draft message through Microsoft Graph.
 */
export async function sendMessage(
  graph: GraphOperations,
  attempt: MailAttempt,
  draftId: string,
  signal: AbortSignal,
): Promise<void> {
  const sendPath = `${paths(attempt).messages}/${encodeURIComponent(draftId)}/send`;
  await graph.request(sendPath, signal, "POST", undefined, false);
}

/**
 * Polls the target mailbox inbox until the delivered synthetic message appears or the deadline expires.
 */
export async function confirmDelivery(
  graph: GraphOperations,
  attempt: MailAttempt,
  signal: AbortSignal,
  deadline: number,
  pollIntervalMs: number,
): Promise<void> {
  const attemptPaths = paths(attempt);
  const subject = mailSubject(attempt);
  const marker = mailMarker(attempt);

  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const inbox = await graph.json(attemptPaths.inbox, messagesSchema, signal);
    const deliveredMessages = inbox.value.filter((message) => {
      if (message.isDraft === true) {
        return false;
      }
      return ownedMessage(message, attempt.mailbox, subject, marker);
    });

    for (const message of deliveredMessages) {
      attempt.ownedMessageIds.add(message.id);
    }
    if (inbox["@odata.nextLink"]) {
      throw new IntegrationError("read-failure");
    }
    if (deliveredMessages.length > 0) {
      return;
    }

    const remainingMs = Math.max(0, deadline - Date.now());
    const waitMs = Math.min(pollIntervalMs, remainingMs);
    await delay(waitMs, undefined, { signal });
  }

  throw new IntegrationError("delivery-timeout");
}

/**
 * Deletes all synthetic message copies owned by or discovered for the current mail attempt.
 */
export async function cleanup(
  graph: GraphOperations,
  attempt: MailAttempt,
  signal: AbortSignal,
): Promise<void> {
  const attemptPaths = paths(attempt);
  const subject = mailSubject(attempt);
  const marker = mailMarker(attempt);
  const failures: unknown[] = [];
  const attemptedMessageIds = new Set<string>();

  /**
   * Deletes any owned message IDs that have not yet been attempted in this cleanup pass.
   */
  async function deleteKnownMessages(): Promise<void> {
    for (const messageId of attempt.ownedMessageIds) {
      if (attemptedMessageIds.has(messageId)) {
        continue;
      }
      attemptedMessageIds.add(messageId);
      try {
        await graph.request(
          `${attemptPaths.messages}/${encodeURIComponent(messageId)}`,
          signal,
          "DELETE",
        );
      } catch (error) {
        failures.push(error);
      }
    }
  }

  // A slow discovery request must not prevent deletion of copies already known to this attempt.
  await deleteKnownMessages();

  // The exact unguessable marker also finds a sent copy whose ID changed after submission.
  try {
    const copies = await graph.json(attemptPaths.copies, messagesSchema, signal);
    for (const message of copies.value) {
      if (ownedMessage(message, attempt.mailbox, subject, marker)) {
        attempt.ownedMessageIds.add(message.id);
      }
    }
    if (copies["@odata.nextLink"]) {
      throw new IntegrationError("cleanup-failure");
    }
  } catch (error) {
    failures.push(error);
  }

  await deleteKnownMessages();

  if (failures.length > 0) {
    throw new IntegrationError("cleanup-failure");
  }
}
