import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";

const messageSchema = z.object({ id: z.string().min(1) });
const messageListSchema = z.object({
  value: z.array(messageSchema), "@odata.nextLink": z.string().optional(),
});

export interface MailAttempt {
  mailbox: string;
  correlationId: string;
  ownedMessageIds: Set<string>;
  mutationAttempted: boolean;
  recipientMailbox?: string | undefined;
  deliveredMessageIds?: Set<string>;
}

function paths(attempt: MailAttempt) {
  const mailbox = `/users/${encodeURIComponent(attempt.mailbox)}`;
  const query = new URLSearchParams({
    "$filter": `subject eq 'AHM synthetic ${attempt.correlationId}'`, "$select": "id", "$top": "100",
  });
  return {
    messages: `${mailbox}/messages`,
    inbox: `/users/${encodeURIComponent(attempt.recipientMailbox ?? attempt.mailbox)}/mailFolders/inbox/messages?${query}`,
    copies: `${mailbox}/messages?${query}`,
  };
}

export async function authenticate(graph: GraphClient | undefined, signal: AbortSignal): Promise<GraphClient> {
  if (!graph) throw new IntegrationError("collector-failure");
  await graph.authenticate(signal);
  return graph;
}

export async function createDraft(graph: GraphClient, attempt: MailAttempt, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  attempt.mutationAttempted = true;
  const draft = await graph.json(paths(attempt).messages, messageSchema, signal, "POST", {
    subject: `AHM synthetic ${attempt.correlationId}`,
    body: { contentType: "Text", content: "Dedicated synthetic probe. Safe to delete." },
    toRecipients: [{ emailAddress: { address: attempt.recipientMailbox ?? attempt.mailbox } }],
    internetMessageHeaders: [{ name: "x-ahm-correlation-id", value: attempt.correlationId }],
  }, false);
  attempt.ownedMessageIds.add(draft.id);
  return draft.id;
}

export async function sendMessage(graph: GraphClient, attempt: MailAttempt, draftId: string, signal: AbortSignal): Promise<void> {
  await graph.request(`${paths(attempt).messages}/${encodeURIComponent(draftId)}/send`, signal, "POST", undefined, false);
}

export async function confirmDelivery(
  graph: GraphClient, attempt: MailAttempt, signal: AbortSignal,
  deadline: number, pollIntervalMs: number, now: () => number = Date.now,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = (ms, abort) => delay(ms, undefined, { signal: abort }),
): Promise<void> {
  while (now() < deadline) {
    signal.throwIfAborted();
    const inbox = await graph.json(paths(attempt).inbox, messageListSchema, signal);
    for (const message of inbox.value) {
      if (attempt.recipientMailbox && attempt.recipientMailbox.toLowerCase() !== attempt.mailbox.toLowerCase()) {
        (attempt.deliveredMessageIds ??= new Set()).add(message.id);
      } else attempt.ownedMessageIds.add(message.id);
    }
    if (inbox.value.length > 0) return;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())), signal);
  }
  throw new IntegrationError("delivery-timeout");
}

export async function cleanup(graph: GraphClient, attempt: MailAttempt, signal: AbortSignal): Promise<void> {
  const failures: unknown[] = [];
  const mailboxes = [{ mailbox: attempt.mailbox, ids: attempt.ownedMessageIds }];
  if (attempt.recipientMailbox && attempt.recipientMailbox.toLowerCase() !== attempt.mailbox.toLowerCase()) {
    mailboxes.push({ mailbox: attempt.recipientMailbox, ids: attempt.deliveredMessageIds ??= new Set() });
  }
  // The exact unguessable marker also finds a sent copy whose ID changed after submission.
  for (const { mailbox, ids } of mailboxes) {
    try {
      const collection = paths({ ...attempt, mailbox, recipientMailbox: undefined });
      const copies = await graph.json(collection.copies, messageListSchema, signal);
      for (const message of copies.value) ids.add(message.id);
      if (copies["@odata.nextLink"]) throw new IntegrationError("cleanup-failure");
    } catch (error) { failures.push(error); }
  }
  for (const { mailbox, ids } of mailboxes) {
    for (const id of ids) {
      try {
        await graph.request(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(id)}`, signal, "DELETE");
      } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw new IntegrationError("cleanup-failure");
}
