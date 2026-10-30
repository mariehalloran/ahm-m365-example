import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { StepName, SyntheticResult } from "../../utils/src/contracts.js";
import type { GraphOperations } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";
import { baseResult, type ProbeContext, type ProbeHandler } from "../../utils/src/probes.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../../utils/src/steps.js";
import { authenticate, createDraft, mailMarker, sendMessage, type MailAttempt } from "./steps.js";
import { messageSchema, messageSelect, messagesSchema, ownedMessage, selfDraft, selfMessage } from "./mail-safety.js";
import { readReplySeed } from "./reply-seed.js";
import type { LiveProbeFor } from "../../utils/src/resolved-probes.js";

type ExtendedJourney = "exchange-attachment" | "exchange-reply" | "exchange-recurring-calendar";

const identified = z.object({ id: z.string().min(1) });
const event = identified.extend({
  subject: z.string(), transactionId: z.string().optional(), seriesMasterId: z.string().nullable().optional(),
  type: z.string().optional(),
  attendees: z.array(z.object({ emailAddress: z.object({ address: z.string() }) })),
  organizer: z.object({ emailAddress: z.object({ address: z.string() }) }).optional(),
});
const events = z.object({ value: z.array(event), "@odata.nextLink": z.string().optional() });
const user = (mailbox: string) => `/users/${encodeURIComponent(mailbox)}`;
const item = (mailbox: string, collection: string, id: string) => `${user(mailbox)}/${collection}/${encodeURIComponent(id)}`;
const quote = (value: string) => value.replaceAll("'", "''");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface Attempt {
  probe: LiveProbeFor<ExtendedJourney>;
  mailbox: string;
  context: ProbeContext;
  result: SyntheticResult;
  graph: GraphOperations;
  startedAt: number;
  now: () => number;
  subject: string;
  mutated: boolean;
  mail: MailAttempt;
  replyConversation?: string;
  replyMarker?: string;
  ownedEvents: Set<string>;
  reconcileEvent: boolean;
}

async function step<T>(a: Attempt, name: StepName, operation: () => Promise<T>): Promise<T> {
  return measureStep(a.result, name, operation, a.now);
}

async function poll<T>(a: Attempt, read: () => Promise<T | undefined>): Promise<T> {
  const { signal, config } = a.context;
  const deadline = a.startedAt + config.PROBE_TIMEOUT_MS;
  while (a.now() < deadline) {
    signal.throwIfAborted();
    const found = await read();
    if (found !== undefined) return found;
    await (a.context.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort })))(
      Math.min(config.POLL_INTERVAL_MS, Math.max(0, deadline - a.now())), signal,
    );
  }
  throw new IntegrationError("delivery-timeout");
}

function mailFilter(a: Attempt): string {
  return a.replyConversation
    ? `conversationId eq '${quote(a.replyConversation)}' and createdDateTime ge ${new Date(a.startedAt - 60000).toISOString()}`
    : `subject eq '${quote(a.subject)}'`;
}

function ownsMail(a: Attempt, message: z.infer<typeof messageSchema>): boolean {
  if (message.id === a.probe.replySeed?.messageId) return false;
  if (!a.replyConversation) return ownedMessage(message, a.mailbox, a.subject, mailMarker(a.mail));
  return message.conversationId === a.replyConversation && message.bodyPreview?.includes(a.replyMarker!) === true &&
    (message.isDraft === true ? selfDraft(message, a.mailbox) : selfMessage(message, a.mailbox));
}

async function receive(a: Attempt) {
  const query = new URLSearchParams({ "$filter": mailFilter(a), "$top": "100", "$select": messageSelect });
  return poll(a, async () => {
    const found = await a.graph.json(`${user(a.mailbox)}/mailFolders/inbox/messages?${query}`, messagesSchema, a.context.signal);
    const matching = found.value.filter(message => message.isDraft !== true && ownsMail(a, message));
    for (const message of matching) a.mail.ownedMessageIds.add(message.id);
    if (found["@odata.nextLink"]) throw new IntegrationError("read-failure");
    return matching[0];
  });
}

async function attachmentDelivery(a: Attempt): Promise<void> {
  const bytes = Buffer.from(`Synthetic attachment ${a.result.correlationId}\n`, "utf8");
  await step(a, "send-attachment", async () => {
    a.mutated = true;
    const draftId = await createDraft(a.graph, a.mail, a.context.signal, bytes.toString("base64"));
    await sendMessage(a.graph, a.mail, draftId, a.context.signal);
  });
  await step(a, "verify-attachment", async () => {
    const delivered = await receive(a);
    const attachments = await a.graph.json(`${item(a.mailbox, "messages", delivered.id)}/attachments`,
      z.object({ value: z.array(identified.extend({ name: z.string() })), "@odata.nextLink": z.string().optional() }), a.context.signal);
    if (attachments["@odata.nextLink"]) throw new IntegrationError("read-failure");
    const attachment = attachments.value.find(file => file.name === "synthetic.txt");
    if (!attachment) throw new IntegrationError("read-failure");
    const saved = await a.graph.json(`${item(a.mailbox, "messages", delivered.id)}/attachments/${encodeURIComponent(attachment.id)}`,
      z.object({ contentBytes: z.string() }), a.context.signal);
    const downloaded = Buffer.from(saved.contentBytes, "base64");
    if (downloaded.length !== bytes.length || hash(downloaded) !== hash(bytes)) throw new IntegrationError("read-failure");
  });
}

async function replyMail(a: Attempt): Promise<void> {
  let originalMessageId = "";
  let replySubject = "";
  await step(a, "reply-mail", async () => {
    const seed = await readReplySeed(a.graph, a.probe, a.context.signal);
    originalMessageId = seed.internetMessageId;
    a.replyConversation = seed.conversationId;
    a.replyMarker = `Correlated SELF-REPLY ${a.result.correlationId}`;
    a.mutated = true;
    // Stamp the marker atomically: a lost createReply response must still be discoverable without touching the seed.
    const reply = await a.graph.json(`${item(a.mailbox, "messages", seed.id)}/createReply`, messageSchema,
      a.context.signal, "POST", { comment: a.replyMarker }, false);
    if (reply.id === seed.id) throw new IntegrationError("read-failure");
    a.mail.ownedMessageIds.add(reply.id);
    if (!reply.isDraft || !reply.subject?.endsWith(seed.subject) || reply.conversationId !== seed.conversationId ||
        !selfDraft(reply, a.mailbox)) {
      throw new IntegrationError("configuration-failure", undefined, "self-reply-recipients-required");
    }
    replySubject = reply.subject;
    await a.graph.request(item(a.mailbox, "messages", reply.id), a.context.signal, "PATCH", {
      body: { contentType: "Text", content: a.replyMarker },
    }, false);
    await a.graph.request(`${item(a.mailbox, "messages", reply.id)}/send`, a.context.signal, "POST", undefined, false);
  });
  await step(a, "confirm-reply-mail", async () => {
    const reply = await receive(a);
    const inReplyTo = reply.internetMessageHeaders?.filter(header => header.name.toLowerCase() === "in-reply-to") ?? [];
    const replyHeaderMatched = inReplyTo.length === 1 &&
      inReplyTo[0]!.value.trim() === originalMessageId.trim() &&
      !!reply.internetMessageId && reply.internetMessageId !== originalMessageId;
    if (!replyHeaderMatched || reply.subject !== replySubject || !selfMessage(reply, a.mailbox)) {
      a.context.telemetry.emit("exchange-self-reply-validation-failed", {
        testId: a.probe.id, correlationId: a.result.correlationId, replyHeaderMatched,
      });
      throw new IntegrationError("read-failure");
    }
  });
}

function eventTimes(a: Attempt) {
  const start = new Date(a.now() + 86400000);
  start.setUTCHours(12, 0, 0, 0);
  const end = new Date(start.getTime() + 1800000);
  return {
    date: start.toISOString().slice(0, 10),
    start: { dateTime: start.toISOString().slice(0, -1), timeZone: "UTC" },
    end: { dateTime: end.toISOString().slice(0, -1), timeZone: "UTC" },
    window: new URLSearchParams({ startDateTime: start.toISOString(), endDateTime: new Date(start.getTime() + 3 * 86400000).toISOString() }),
  };
}

function privateEvent(saved: z.infer<typeof event>): boolean {
  return saved.attendees.length === 0;
}

async function recurring(a: Attempt): Promise<void> {
  const times = eventTimes(a);
  const master = await step(a, "create-event", async () => {
    a.mutated = true;
    a.reconcileEvent = true;
    const created = await a.graph.json(`${user(a.mailbox)}/events`, identified.passthrough(), a.context.signal, "POST", {
      subject: a.subject, transactionId: a.result.correlationId, start: times.start, end: times.end,
      attendees: [], responseRequested: false,
      recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "numbered", startDate: times.date, numberOfOccurrences: 3, recurrenceTimeZone: "UTC" } },
    }, false);
    a.ownedEvents.add(created.id);
    a.reconcileEvent = false;
    const parsed = event.safeParse(created);
    if (!parsed.success) throw new IntegrationError("malformed-response");
    if (!privateEvent(parsed.data)) throw new IntegrationError("read-failure");
    return parsed.data;
  });
  const instancesPath = `${item(a.mailbox, "events", master.id)}/instances?${times.window}`;
  const read = async (subject: string) => poll(a, async () => {
    const instances = await a.graph.json(instancesPath, events, a.context.signal);
    if (instances["@odata.nextLink"]) throw new IntegrationError("read-failure");
    const complete = instances.value.length === 3 && new Set(instances.value.map(value => value.id)).size === 3 &&
      instances.value.every(value => value.seriesMasterId === master.id && privateEvent(value) &&
        ["occurrence", "exception"].includes(value.type ?? "") && value.subject === subject);
    return complete ? instances.value : undefined;
  });
  await step(a, "read-occurrence", () => read(a.subject));
  const updated = `${a.subject} updated`;
  await step(a, "update-event", () => a.graph.request(item(a.mailbox, "events", master.id), a.context.signal, "PATCH", { subject: updated }, false));
  await step(a, "verify-event", async () => {
    const saved = await a.graph.json(item(a.mailbox, "events", master.id), event, a.context.signal);
    if (saved.subject !== updated || !privateEvent(saved)) throw new IntegrationError("read-failure");
    await read(updated);
  });
  await step(a, "delete-event", async () => {
    await a.graph.request(item(a.mailbox, "events", master.id), a.context.signal, "DELETE");
    await poll(a, async () => {
      try {
        await a.graph.json(item(a.mailbox, "events", master.id), event, a.context.signal);
        return undefined;
      } catch (error) {
        if (error instanceof IntegrationError && error.status === 404) return true;
        throw error;
      }
    });
    a.ownedEvents.delete(master.id);
  });
}

async function clean(a: Attempt, signal: AbortSignal): Promise<void> {
  const failures: unknown[] = [];
  if (a.reconcileEvent) {
    try {
      const query = new URLSearchParams({ "$filter": `subject eq '${quote(a.subject)}'`, "$select": "id,subject,transactionId,attendees,organizer", "$top": "100" });
      const copies = await a.graph.json(`${user(a.mailbox)}/events?${query}`, events, signal);
      for (const saved of copies.value) {
        if (saved.subject === a.subject && saved.transactionId === a.result.correlationId && privateEvent(saved) &&
            saved.organizer?.emailAddress.address.toLowerCase() === a.mailbox.toLowerCase()) a.ownedEvents.add(saved.id);
      }
      if (copies["@odata.nextLink"]) throw new IntegrationError("cleanup-failure");
    } catch (error) { failures.push(error); }
  }
  for (const id of a.ownedEvents) {
    try { await a.graph.request(item(a.mailbox, "events", id), signal, "DELETE"); }
    catch (error) { failures.push(error); }
  }
  if (a.context.config.EXCHANGE_CLEANUP_ENABLED !== "false" && a.probe.type !== "exchange-recurring-calendar") {
    const attempted = new Set<string>();
    const deleteKnown = async () => {
      for (const id of a.mail.ownedMessageIds) {
        if (id === a.probe.replySeed?.messageId || attempted.has(id)) continue;
        attempted.add(id);
        try { await a.graph.request(item(a.mailbox, "messages", id), signal, "DELETE"); }
        catch (error) { failures.push(error); }
      }
    };
    await deleteKnown();
    try {
      const query = new URLSearchParams({ "$filter": mailFilter(a), "$top": "100", "$select": messageSelect });
      const copies = await a.graph.json(`${user(a.mailbox)}/messages?${query}`, messagesSchema, signal);
      for (const copy of copies.value) if (ownsMail(a, copy)) a.mail.ownedMessageIds.add(copy.id);
      if (copies["@odata.nextLink"]) throw new IntegrationError("cleanup-failure");
    } catch (error) { failures.push(error); }
    await deleteKnown();
  }
  if (failures.length) throw new IntegrationError("cleanup-failure");
}

function journey(calendar: boolean, operation: (attempt: Attempt) => Promise<void>): ProbeHandler<ExtendedJourney> {
  return async (probe, context) => {
    const now = context.now ?? Date.now;
    const startedAt = now();
    const result = baseResult(probe, startedAt);
    const mailbox = probe.mailbox;
    const a: Attempt = {
      probe, mailbox, context, result, startedAt, now, graph: context.graph!,
      subject: `AHM synthetic ${result.correlationId}`, mutated: false,
      mail: { mailbox, correlationId: result.correlationId, ownedMessageIds: new Set(), mutationAttempted: false },
      ownedEvents: new Set(), reconcileEvent: false,
    };
    try {
      await step(a, "authenticate", async () => {
        a.graph = await authenticate(context.graph, context.signal);
      });
      await operation(a);
      result.success = true;
      result.diagnosticContext.testStage = "complete";
    } catch (error) { journeyFailure(result, error, context.telemetry); }
    finally {
      context.executionComplete?.();
      await cleanupStep(result, a.mutated, signal => clean(a, signal), context.telemetry, now,
        calendar || context.config.EXCHANGE_CLEANUP_ENABLED !== "false");
    }
    return finishJourney(result, startedAt, now);
  };
}

export const exchangeAttachmentProbe = journey(false, attachmentDelivery);
export const exchangeReplyProbe = journey(false, replyMail);
export const exchangeRecurringProbe = journey(true, recurring);
