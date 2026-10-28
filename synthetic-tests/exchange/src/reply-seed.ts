import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Probe, Telemetry } from "../../utils/src/contracts.js";
import type { GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";

type ReplyTarget = Pick<Probe, "id" | "mailbox" | "recipientMailbox" | "replySeed">;
export type ReplySeedGraph = Pick<GraphClient, "authenticate" | "json" | "request">;
export interface ReplySeedOptions {
  signal: AbortSignal; telemetry: Telemetry;
  now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
const seedMessage = z.object({
  id: z.string().min(1), subject: z.string(), isDraft: z.boolean(),
  conversationId: z.string().min(1), internetMessageId: z.string().min(1),
  from: z.object({ emailAddress: z.object({ address: z.string() }) }),
  internetMessageHeaders: z.array(z.object({ name: z.string(), value: z.string() })),
});
const select = "id,subject,isDraft,conversationId,internetMessageId,from,internetMessageHeaders";
const user = (mailbox: string) => `/users/${encodeURIComponent(mailbox)}`;
export const replySeedSubject = (correlationId: string) => `AHM reply seed ${correlationId}`;

function requireParticipants(target: ReplyTarget): { sender: string; recipient: string } {
  if (!target.mailbox || !target.recipientMailbox ||
      target.mailbox.toLowerCase() === target.recipientMailbox.toLowerCase()) {
    throw new IntegrationError("configuration-failure");
  }
  return { sender: target.mailbox, recipient: target.recipientMailbox };
}

function validateSeed(message: z.infer<typeof seedMessage>, sender: string, correlationId: string) {
  const headers = message.internetMessageHeaders.filter(header => header.name.toLowerCase() === "x-ahm-reply-seed-id");
  if (message.isDraft || message.subject !== replySeedSubject(correlationId) ||
      message.from.emailAddress.address.toLowerCase() !== sender.toLowerCase() ||
      headers.length !== 1 || headers[0]!.value !== correlationId) {
    throw new IntegrationError("configuration-failure");
  }
  return message;
}

export async function readReplySeed(graph: ReplySeedGraph, target: ReplyTarget, signal: AbortSignal) {
  const { sender, recipient } = requireParticipants(target);
  if (!target.replySeed) throw new IntegrationError("configuration-failure");
  const saved = await graph.json(
    `${user(recipient)}/messages/${encodeURIComponent(target.replySeed.messageId)}?$select=${select}`, seedMessage, signal,
  );
  if (saved.id !== target.replySeed.messageId) throw new IntegrationError("configuration-failure");
  return validateSeed(saved, sender, target.replySeed.correlationId);
}

export async function provisionReplySeed(graph: ReplySeedGraph, target: ReplyTarget, options: ReplySeedOptions) {
  const { sender, recipient } = requireParticipants(target);
  const now = options.now ?? Date.now;
  const started = now();
  await graph.authenticate(options.signal);
  if (target.replySeed) {
    try {
      await readReplySeed(graph, target, options.signal);
      options.telemetry.emit("exchange-reply-seed-ready", {
        targetId: target.id, created: false, durationMs: now() - started,
      });
      return target.replySeed;
    } catch (error) {
      if (!(error instanceof IntegrationError) || error.status !== 404) throw error;
      options.telemetry.emit("exchange-reply-seed-missing", { targetId: target.id, action: "reprovision" });
    }
  }
  const correlationId = randomUUID();
  const subject = replySeedSubject(correlationId);
  const draft = await graph.json(`${user(sender)}/messages`, z.object({ id: z.string().min(1) }), options.signal, "POST", {
    subject, body: { contentType: "Text", content: `Retained synthetic reply fixture ${correlationId}.` },
    toRecipients: [{ emailAddress: { address: recipient } }],
    internetMessageHeaders: [{ name: "x-ahm-reply-seed-id", value: correlationId }],
  }, false);
  await graph.request(`${user(sender)}/messages/${encodeURIComponent(draft.id)}/send`, options.signal, "POST", undefined, false);
  const query = new URLSearchParams({ "$filter": `subject eq '${subject}'`, "$select": select, "$top": "100" });
  const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  while (true) {
    options.signal.throwIfAborted();
    const inbox = await graph.json(`${user(recipient)}/mailFolders/inbox/messages?${query}`,
      z.object({ value: z.array(seedMessage), "@odata.nextLink": z.string().optional() }), options.signal);
    if (inbox["@odata.nextLink"]) throw new IntegrationError("read-failure");
    const saved = inbox.value.find(message => message.subject === subject);
    if (saved) {
      validateSeed(saved, sender, correlationId);
      const binding = { messageId: saved.id, correlationId };
      options.telemetry.emit("exchange-reply-seed-ready", {
        targetId: target.id, created: true, durationMs: now() - started,
      });
      return binding;
    }
    await sleep(2000, options.signal);
  }
}
