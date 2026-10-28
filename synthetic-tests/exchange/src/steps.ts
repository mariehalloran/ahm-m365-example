import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";
import { messageSelect, messagesSchema, ownedMessage } from "./mail-safety.js";

const messageSchema = z.object({ id: z.string().min(1) });

export interface MailAttempt {
  mailbox: string;
  correlationId: string;
  ownedMessageIds: Set<string>;
  mutationAttempted: boolean;
}

export const mailSubject = (attempt: MailAttempt) => `AHM synthetic ${attempt.correlationId}`;
export const mailMarker = (attempt: MailAttempt) => `Synthetic ${attempt.correlationId}`;

function paths(attempt: MailAttempt) {
  const mailbox = `/users/${encodeURIComponent(attempt.mailbox)}`;
  const query = new URLSearchParams({
    "$filter": `subject eq '${mailSubject(attempt)}'`, "$select": messageSelect, "$top": "100",
  });
  return {
    messages: `${mailbox}/messages`,
    inbox: `${mailbox}/mailFolders/inbox/messages?${query}`,
    copies: `${mailbox}/messages?${query}`,
  };
}

export async function authenticate(graph: GraphClient | undefined, signal: AbortSignal): Promise<GraphClient> {
  if (!graph) throw new IntegrationError("collector-failure");
  await graph.authenticate(signal);
  return graph;
}

export async function createDraft(graph: GraphClient, attempt: MailAttempt, signal: AbortSignal, attachment?: string): Promise<string> {
  signal.throwIfAborted();
  attempt.mutationAttempted = true;
  const draft = await graph.json(paths(attempt).messages, messageSchema, signal, "POST", {
    subject: mailSubject(attempt),
    body: { contentType: "Text", content: `${mailMarker(attempt)}. Safe to delete.` },
    toRecipients: [{ emailAddress: { address: attempt.mailbox } }],
    internetMessageHeaders: [{ name: "x-ahm-correlation-id", value: attempt.correlationId }],
    ...(attachment === undefined ? {} : { attachments: [{
      "@odata.type": "#microsoft.graph.fileAttachment", name: "synthetic.txt", contentType: "text/plain", contentBytes: attachment,
    }] }),
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
    const inbox = await graph.json(paths(attempt).inbox, messagesSchema, signal);
    const owned = inbox.value.filter(message => message.isDraft !== true &&
      ownedMessage(message, attempt.mailbox, mailSubject(attempt), mailMarker(attempt)));
    for (const message of owned) attempt.ownedMessageIds.add(message.id);
    if (inbox["@odata.nextLink"]) throw new IntegrationError("read-failure");
    if (owned.length > 0) return;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())), signal);
  }
  throw new IntegrationError("delivery-timeout");
}

export async function cleanup(graph: GraphClient, attempt: MailAttempt, signal: AbortSignal): Promise<void> {
  const failures: unknown[] = [];
  const attempted = new Set<string>();
  const deleteKnown = async () => {
    for (const id of attempt.ownedMessageIds) {
      if (attempted.has(id)) continue;
      attempted.add(id);
      try { await graph.request(`${paths(attempt).messages}/${encodeURIComponent(id)}`, signal, "DELETE"); }
      catch (error) { failures.push(error); }
    }
  };
  // A slow discovery request must not prevent deletion of copies already known to this attempt.
  await deleteKnown();
  // The exact unguessable marker also finds a sent copy whose ID changed after submission.
  try {
    const copies = await graph.json(paths(attempt).copies, messagesSchema, signal);
    for (const message of copies.value) {
      if (ownedMessage(message, attempt.mailbox, mailSubject(attempt), mailMarker(attempt))) attempt.ownedMessageIds.add(message.id);
    }
    if (copies["@odata.nextLink"]) throw new IntegrationError("cleanup-failure");
  } catch (error) { failures.push(error); }
  await deleteKnown();
  if (failures.length) throw new IntegrationError("cleanup-failure");
}
