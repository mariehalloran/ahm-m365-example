import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Probe, Telemetry } from "../../utils/src/contracts.js";
import type { GraphOperations } from "../../utils/src/integrations/graph.js";
import { IntegrationError } from "../../utils/src/integrations/http.js";
import { messageSchema, messageSelect, messagesSchema, ownedMessage, selfMessage } from "./mail-safety.js";

type ReplyTarget = Pick<Probe, "id" | "mailbox" | "replySeed">;
export type ReplySeedGraph = GraphOperations;
export interface ReplySeedOptions {
  signal: AbortSignal; telemetry: Telemetry;
  now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  reprovision?: boolean;
}
const seedMessage = messageSchema.extend({
  subject: z.string(), isDraft: z.boolean(), bodyPreview: z.string(),
  conversationId: z.string().min(1), internetMessageId: z.string().min(1),
  internetMessageHeaders: z.array(z.object({ name: z.string(), value: z.string() })),
});
const user = (mailbox: string) => `/users/${encodeURIComponent(mailbox)}`;
export const replySeedSubject = (correlationId: string) => `AHM SELF-REPLY seed ${correlationId}`;
const seedMarker = (correlationId: string) => `Retained self-addressed synthetic reply fixture ${correlationId}`;

function validateSeed(message: z.infer<typeof seedMessage>, mailbox: string, correlationId: string) {
  const header = (name: string, value: string) => {
    const matches = message.internetMessageHeaders.filter(header => header.name.toLowerCase() === name);
    return matches.length === 1 && matches[0]!.value === value;
  };
  if (message.isDraft || message.subject !== replySeedSubject(correlationId) || !selfMessage(message, mailbox) ||
      !message.bodyPreview.includes(seedMarker(correlationId)) ||
      !header("x-ahm-reply-seed-id", correlationId) || !header("x-ahm-reply-seed-scope", "self-v1")) {
    throw new IntegrationError("configuration-failure", undefined, "self-reply-seed-incompatible-reprovision");
  }
  return message;
}

export async function readReplySeed(graph: ReplySeedGraph, target: ReplyTarget, signal: AbortSignal) {
  if (!target.mailbox || !target.replySeed) throw new IntegrationError("configuration-failure", undefined, "self-reply-seed-required");
  let saved: z.infer<typeof seedMessage>;
  try {
    // Folder-scoped lookup excludes the sent copy even though sender and recipient are the same user.
    saved = await graph.json(
      `${user(target.mailbox)}/mailFolders/inbox/messages/${encodeURIComponent(target.replySeed.messageId)}?$select=${messageSelect}`,
      seedMessage, signal,
    );
  } catch (error) {
    if (error instanceof IntegrationError && error.status === 404) {
      throw new IntegrationError("configuration-failure", 404, "self-reply-seed-missing-or-paired-reprovision");
    }
    throw error;
  }
  if (saved.id !== target.replySeed.messageId) throw new IntegrationError("configuration-failure", undefined, "self-reply-seed-id-mismatch");
  return validateSeed(saved, target.mailbox, target.replySeed.correlationId);
}

export async function provisionReplySeed(graph: ReplySeedGraph, target: ReplyTarget, options: ReplySeedOptions) {
  const mailbox = target.mailbox;
  if (!mailbox) throw new IntegrationError("configuration-failure");
  const now = options.now ?? Date.now;
  const started = now();
  await graph.authenticate(options.signal);
  if (target.replySeed) {
    try {
      await readReplySeed(graph, target, options.signal);
      options.telemetry.emit("exchange-self-reply-seed-ready", { targetId: target.id, created: false, durationMs: now() - started });
      return target.replySeed;
    } catch (error) {
      if (!(error instanceof IntegrationError) ||
          (error.status !== 404 && !(options.reprovision && error.category === "configuration-failure"))) throw error;
      options.telemetry.emit("exchange-self-reply-seed-reprovisioning", {
        targetId: target.id, action: "create-self-fixture-without-deleting-prior-seed",
        reason: error.status === 404 ? "missing-or-paired-binding" : "incompatible-fixture",
      });
    }
  }
  const correlationId = randomUUID();
  const subject = replySeedSubject(correlationId);
  const query = new URLSearchParams({ "$filter": `subject eq '${subject}'`, "$select": messageSelect, "$top": "100" });
  const owned = new Set<string>();
  let retainedId: string | undefined;
  let cleanupFailed = false;
  try {
    const draft = await graph.json(`${user(mailbox)}/messages`, z.object({ id: z.string().min(1) }), options.signal, "POST", {
      subject, body: { contentType: "Text", content: `${seedMarker(correlationId)}.` },
      toRecipients: [{ emailAddress: { address: mailbox } }],
      internetMessageHeaders: [
        { name: "x-ahm-reply-seed-id", value: correlationId },
        { name: "x-ahm-reply-seed-scope", value: "self-v1" },
      ],
    }, false);
    owned.add(draft.id);
    await graph.request(`${user(mailbox)}/messages/${encodeURIComponent(draft.id)}/send`, options.signal, "POST", undefined, false);
    const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
    while (true) {
      options.signal.throwIfAborted();
      const inbox = await graph.json(`${user(mailbox)}/mailFolders/inbox/messages?${query}`,
        z.object({ value: z.array(seedMessage), "@odata.nextLink": z.string().optional() }), options.signal);
      if (inbox["@odata.nextLink"]) throw new IntegrationError("read-failure");
      const saved = inbox.value.find(message => message.subject === subject);
      if (saved) {
        validateSeed(saved, mailbox, correlationId);
        retainedId = saved.id;
        break;
      }
      await sleep(2000, options.signal);
    }
  } finally {
    const cleanupSignal = AbortSignal.timeout(5000);
    let failed = false;
    const attempted = new Set<string>();
    const deleteKnown = async () => {
      for (const id of owned) {
        if (id === retainedId || attempted.has(id)) continue;
        attempted.add(id);
        try { await graph.request(`${user(mailbox)}/messages/${encodeURIComponent(id)}`, cleanupSignal, "DELETE"); }
        catch { failed = true; }
      }
    };
    await deleteKnown();
    try {
      const copies = await graph.json(`${user(mailbox)}/messages?${query}`, messagesSchema, cleanupSignal);
      for (const copy of copies.value) {
        if (ownedMessage(copy, mailbox, subject, seedMarker(correlationId))) owned.add(copy.id);
      }
      if (copies["@odata.nextLink"]) failed = true;
    } catch { failed = true; }
    await deleteKnown();
    cleanupFailed = failed;
    if (failed) options.telemetry.emit("exchange-self-reply-seed-cleanup-failed", { targetId: target.id, category: "cleanup-failure" });
  }
  if (cleanupFailed) throw new IntegrationError("cleanup-failure");
  options.telemetry.emit("exchange-self-reply-seed-ready", { targetId: target.id, created: true, durationMs: now() - started });
  return { messageId: retainedId, correlationId };
}
