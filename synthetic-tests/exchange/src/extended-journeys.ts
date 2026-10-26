import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Probe, StepName, SyntheticResult } from "../../utils/src/contracts.js";
import type { GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";
import { baseResult, type ProbeContext, type ProbeHandler } from "../../utils/src/probes.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../../utils/src/steps.js";
import { authenticate } from "./steps.js";

const identified = z.object({ id: z.string().min(1) });
const message = identified.extend({
  conversationId: z.string().optional(), subject: z.string().optional(), bodyPreview: z.string().optional(),
  internetMessageId: z.string().min(1).optional(),
  internetMessageHeaders: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  from: z.object({ emailAddress: z.object({ address: z.string() }) }).optional(),
});
const messages = z.object({ value: z.array(message), "@odata.nextLink": z.string().optional() });
const event = identified.extend({
  subject: z.string(), iCalUId: z.string().optional(), seriesMasterId: z.string().optional(),
  type: z.string().optional(),
  attendees: z.array(z.object({
    emailAddress: z.object({ address: z.string() }), status: z.object({ response: z.string() }),
  })).optional(),
});
const events = z.object({ value: z.array(event), "@odata.nextLink": z.string().optional() });
const user = (mailbox: string) => `/users/${encodeURIComponent(mailbox)}`;
const item = (mailbox: string, collection: string, id: string) => `${user(mailbox)}/${collection}/${encodeURIComponent(id)}`;
const quote = (value: string) => value.replaceAll("'", "''");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface Attempt {
  probe: Probe;
  context: ProbeContext;
  result: SyntheticResult;
  graph: GraphClient;
  startedAt: number;
  now: () => number;
  subject: string;
  mutated: boolean;
  mailboxes: Set<string>;
  mailSubjects: Set<string>;
  ownedMail: Map<string, Set<string>>;
  ownedEvents: Map<string, Set<string>>;
}

function own(owned: Map<string, Set<string>>, mailbox: string, id: string): void {
  let ids = owned.get(mailbox);
  if (!ids) owned.set(mailbox, ids = new Set());
  ids.add(id);
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

function participants(a: Attempt): { sender: string; recipient: string } {
  const sender = a.probe.mailbox;
  const recipient = a.probe.recipientMailbox;
  if (!sender || !recipient || sender.toLowerCase() === recipient.toLowerCase()) {
    throw new IntegrationError("configuration-failure");
  }
  a.mailboxes.add(sender);
  a.mailboxes.add(recipient);
  return { sender, recipient };
}

async function send(a: Attempt, sender: string, recipients: string[], attachment?: string): Promise<void> {
  a.mutated = true;
  a.mailboxes.add(sender);
  const draft = await a.graph.json(`${user(sender)}/messages`, identified, a.context.signal, "POST", {
    subject: a.subject,
    body: { contentType: "Text", content: `Synthetic ${a.result.correlationId}. Safe to delete.` },
    toRecipients: recipients.map(address => ({ emailAddress: { address } })),
    internetMessageHeaders: [{ name: "x-ahm-correlation-id", value: a.result.correlationId }],
    ...(attachment ? { attachments: [{
      "@odata.type": "#microsoft.graph.fileAttachment", name: "synthetic.txt", contentType: "text/plain", contentBytes: attachment,
    }] } : {}),
  }, false);
  own(a.ownedMail, sender, draft.id);
  await a.graph.request(`${item(sender, "messages", draft.id)}/send`, a.context.signal, "POST", undefined, false);
}

async function receive(a: Attempt, mailbox: string, subject = a.subject) {
  a.mailboxes.add(mailbox);
  const query = new URLSearchParams({
    "$filter": `subject eq '${quote(subject)}'`, "$top": "100",
    "$select": "id,subject,conversationId,internetMessageId,internetMessageHeaders,bodyPreview,from",
  });
  return poll(a, async () => {
    const found = await a.graph.json(`${user(mailbox)}/mailFolders/inbox/messages?${query}`, messages, a.context.signal);
    if (found["@odata.nextLink"]) throw new IntegrationError("read-failure");
    for (const message of found.value) own(a.ownedMail, mailbox, message.id);
    return found.value.find(message => message.subject === subject);
  });
}

async function attachmentReply(a: Attempt): Promise<void> {
  const { sender, recipient } = participants(a);
  const bytes = Buffer.from(`Synthetic attachment ${a.result.correlationId}\n`, "utf8");
  await step(a, "send-attachment", () => send(a, sender, [recipient], bytes.toString("base64")));
  const delivered = await step(a, "verify-attachment", async () => {
    const delivered = await receive(a, recipient);
    if (!delivered.conversationId || !delivered.internetMessageId) throw new IntegrationError("read-failure");
    const attachments = await a.graph.json(`${item(recipient, "messages", delivered.id)}/attachments`,
      z.object({ value: z.array(identified.extend({ name: z.string() })), "@odata.nextLink": z.string().optional() }), a.context.signal);
    if (attachments["@odata.nextLink"]) throw new IntegrationError("read-failure");
    const attachment = attachments.value.find(file => file.name === "synthetic.txt");
    if (!attachment) throw new IntegrationError("read-failure");
    const saved = await a.graph.json(`${item(recipient, "messages", delivered.id)}/attachments/${encodeURIComponent(attachment.id)}`,
      z.object({ contentBytes: z.string() }), a.context.signal);
    if (hash(Buffer.from(saved.contentBytes, "base64")) !== hash(bytes)) throw new IntegrationError("read-failure");
    return delivered;
  });
  const replySubject = await step(a, "reply-mail", async () => {
    const reply = await a.graph.json(`${item(recipient, "messages", delivered.id)}/createReply`, message, a.context.signal, "POST", {}, false);
    own(a.ownedMail, recipient, reply.id);
    if (!reply.subject?.includes(a.result.correlationId) || reply.conversationId !== delivered.conversationId) {
      throw new IntegrationError("read-failure");
    }
    a.mailSubjects.add(reply.subject);
    await a.graph.request(item(recipient, "messages", reply.id), a.context.signal, "PATCH", {
      body: { contentType: "Text", content: `Correlated reply ${a.result.correlationId}` },
    }, false);
    await a.graph.request(`${item(recipient, "messages", reply.id)}/send`, a.context.signal, "POST", undefined, false);
    return reply.subject;
  });
  await step(a, "confirm-reply-mail", async () => {
    const reply = await receive(a, sender, replySubject);
    // Conversation IDs are mailbox-local; transport Message-ID/In-Reply-To links A and B.
    const inReplyTo = reply.internetMessageHeaders?.filter(header => header.name.toLowerCase() === "in-reply-to") ?? [];
    const replyHeaderMatched = inReplyTo.length === 1 &&
      inReplyTo[0]!.value.trim() === delivered.internetMessageId!.trim() &&
      !!reply.internetMessageId && reply.internetMessageId !== delivered.internetMessageId;
    const senderMatched = reply.from?.emailAddress.address.toLowerCase() === recipient.toLowerCase();
    const bodyMarkerMatched = reply.bodyPreview?.includes(`Correlated reply ${a.result.correlationId}`) ?? false;
    if (!replyHeaderMatched || !senderMatched || !bodyMarkerMatched) {
      a.context.telemetry.emit("exchange-reply-validation-failed", {
        testId: a.probe.id, correlationId: a.result.correlationId, replyHeaderMatched, senderMatched, bodyMarkerMatched,
      });
      throw new IntegrationError("read-failure");
    }
  });
}

async function distribution(a: Attempt): Promise<void> {
  const group = a.probe.distributionList;
  if (!a.probe.mailbox || !group || new Set(group.expectedRecipients.map(value => value.toLowerCase())).size !== group.expectedRecipients.length) {
    throw new IntegrationError("configuration-failure");
  }
  for (const mailbox of group.expectedRecipients) a.mailboxes.add(mailbox);
  await step(a, "send-group-mail", () => send(a, a.probe.mailbox!, [group.address]));
  await step(a, "confirm-group-delivery", async () => {
    const deliveries = await Promise.allSettled(group.expectedRecipients.map(mailbox => receive(a, mailbox)));
    if (deliveries.some(result => result.status === "rejected")) throw new IntegrationError("delivery-timeout");
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

async function createEvent(a: Attempt, mailbox: string, body: unknown) {
  a.mutated = true;
  const created = await a.graph.json(`${user(mailbox)}/events`, event, a.context.signal, "POST", body, false);
  own(a.ownedEvents, mailbox, created.id);
  return created;
}

async function recurring(a: Attempt): Promise<void> {
  const mailbox = a.probe.mailbox;
  if (!mailbox) throw new IntegrationError("configuration-failure");
  const times = eventTimes(a);
  const master = await step(a, "create-event", () => createEvent(a, mailbox, {
    subject: a.subject, transactionId: a.result.correlationId, start: times.start, end: times.end,
    recurrence: { pattern: { type: "daily", interval: 1 }, range: { type: "numbered", startDate: times.date, numberOfOccurrences: 3, recurrenceTimeZone: "UTC" } },
  }));
  const instancesPath = `${item(mailbox, "events", master.id)}/instances?${times.window}`;
  const read = async (subject: string) => poll(a, async () => {
    const instances = await a.graph.json(instancesPath, events, a.context.signal);
    if (instances["@odata.nextLink"]) throw new IntegrationError("read-failure");
    return instances.value.find(value => value.seriesMasterId === master.id &&
      ["occurrence", "exception"].includes(value.type ?? "") && value.subject === subject);
  });
  await step(a, "read-occurrence", () => read(a.subject));
  const updated = `${a.subject} updated`;
  await step(a, "update-event", () => a.graph.request(item(mailbox, "events", master.id), a.context.signal, "PATCH", { subject: updated }, false));
  await step(a, "verify-event", async () => {
    const saved = await a.graph.json(item(mailbox, "events", master.id), event, a.context.signal);
    if (saved.subject !== updated) throw new IntegrationError("read-failure");
    await read(updated);
  });
  await step(a, "delete-event", async () => {
    await a.graph.request(item(mailbox, "events", master.id), a.context.signal, "DELETE");
    a.ownedEvents.get(mailbox)?.delete(master.id);
  });
}

async function meeting(a: Attempt): Promise<void> {
  const { sender, recipient } = participants(a);
  const times = eventTimes(a);
  const organizer = await step(a, "create-meeting", () => createEvent(a, sender, {
    subject: a.subject, transactionId: a.result.correlationId, start: times.start, end: times.end,
    attendees: [{ emailAddress: { address: recipient }, type: "required" }], responseRequested: true,
  }));
  if (!organizer.iCalUId) throw new IntegrationError("malformed-response");
  await step(a, "confirm-invitation", () => receive(a, recipient));
  const attendee = await step(a, "verify-attendee-calendar", () => poll(a, async () => {
    const found = await a.graph.json(`${user(recipient)}/calendarView?${times.window}`, events, a.context.signal);
    if (found["@odata.nextLink"]) throw new IntegrationError("read-failure");
    const saved = found.value.find(value => value.iCalUId === organizer.iCalUId && value.subject === a.subject);
    if (saved) own(a.ownedEvents, recipient, saved.id);
    return saved;
  }));
  await step(a, "accept-meeting", () => a.graph.request(`${item(recipient, "events", attendee.id)}/accept`,
    a.context.signal, "POST", { sendResponse: true, comment: `Synthetic ${a.result.correlationId}` }, false));
  await step(a, "confirm-acceptance", () => poll(a, async () => {
    const saved = await a.graph.json(item(sender, "events", organizer.id), event, a.context.signal);
    return saved.attendees?.find(value => value.emailAddress.address.toLowerCase() === recipient.toLowerCase() && value.status.response === "accepted");
  }));
  await step(a, "cancel-meeting", () => a.graph.request(`${item(sender, "events", organizer.id)}/cancel`,
    a.context.signal, "POST", { comment: `Synthetic cleanup ${a.result.correlationId}` }, false));
}

async function clean(a: Attempt, signal: AbortSignal): Promise<void> {
  const failures: unknown[] = [];
  // Only returned event IDs are deleted, never calendar search matches or unrelated events.
  for (const [mailbox, ids] of a.ownedEvents) for (const id of ids) {
    try { await a.graph.request(item(mailbox, "events", id), signal, "DELETE"); }
    catch (error) { failures.push(error); }
  }
  if (a.context.config.EXCHANGE_CLEANUP_ENABLED !== "false") {
    for (const mailbox of a.mailboxes) {
      for (const subject of new Set([a.subject, ...a.mailSubjects])) {
        try {
          const query = new URLSearchParams({ "$filter": `subject eq '${quote(subject)}'`, "$top": "100" });
          const copies = await a.graph.json(`${user(mailbox)}/messages?${query}`, messages, signal);
          if (copies["@odata.nextLink"]) throw new IntegrationError("cleanup-failure");
          for (const copy of copies.value) own(a.ownedMail, mailbox, copy.id);
        } catch (error) { failures.push(error); }
      }
    }
    for (const [mailbox, ids] of a.ownedMail) for (const id of ids) {
      try { await a.graph.request(item(mailbox, "messages", id), signal, "DELETE"); }
      catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw new IntegrationError("cleanup-failure");
}

function journey(calendar: boolean, operation: (attempt: Attempt) => Promise<void>): ProbeHandler {
  return async (probe, context) => {
    const now = context.now ?? Date.now;
    const startedAt = now();
    const result = baseResult(probe, startedAt);
    const a: Attempt = {
      probe, context, result, startedAt, now, graph: context.graph!,
      subject: `AHM synthetic ${result.correlationId}`, mutated: false,
      mailboxes: new Set(), mailSubjects: new Set(), ownedMail: new Map(), ownedEvents: new Map(),
    };
    try {
      await step(a, "authenticate", async () => {
        if (!probe.mailbox) throw new IntegrationError("configuration-failure");
        a.graph = await authenticate(context.graph, context.signal);
      });
      await operation(a);
      result.success = true;
      result.diagnosticContext.testStage = "complete";
    } catch (error) { journeyFailure(result, error, context.telemetry); }
    finally {
      await cleanupStep(result, a.mutated, signal => clean(a, signal), context.telemetry, now,
        calendar || context.config.EXCHANGE_CLEANUP_ENABLED !== "false");
    }
    return finishJourney(result, startedAt, now);
  };
}

export const exchangeAttachmentProbe = journey(false, attachmentReply);
export const exchangeDistributionProbe = journey(false, distribution);
export const exchangeRecurringProbe = journey(true, recurring);
export const exchangeMeetingProbe = journey(true, meeting);
