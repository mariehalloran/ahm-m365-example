import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { resultSchema, type Probe, type TestType } from "../../utils/src/contracts.js";
import type { GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";
import {
  exchangeAttachmentProbe, exchangeDistributionProbe, exchangeMeetingProbe, exchangeRecurringProbe, exchangeReplyProbe,
} from "../src/extended-journeys.js";
import { replySeedSubject } from "../src/reply-seed.js";

const sender = "sender@example.invalid";
const recipient = "recipient@example.invalid";
const handlers = {
  "exchange-attachment": exchangeAttachmentProbe, "exchange-reply": exchangeReplyProbe,
  "exchange-distribution-list": exchangeDistributionProbe,
  "exchange-recurring-calendar": exchangeRecurringProbe, "exchange-meeting": exchangeMeetingProbe,
};

async function run(type: keyof typeof handlers, options: {
  missingSetup?: boolean; badHash?: boolean; badReply?: boolean; missingRecipient?: boolean;
  cleanup?: boolean; failStage?: string; createFails?: boolean;
  badReplySender?: boolean; badReplyBody?: boolean; missingReplyHeader?: boolean; duplicateReplyHeader?: boolean;
  occurrenceCount?: number; duplicateOccurrence?: boolean; staleOccurrenceUpdate?: boolean;
  seriesDeletionPending?: boolean; seriesDeletionReadDenied?: boolean;
  cancellationPending?: boolean; cancelledEventMissing?: boolean; cancellationReadDenied?: boolean;
  cancellationReadAborted?: boolean; attendeeCleanupStatus?: number;
  malformedCreatedEvent?: boolean;
  attendeeOnSecondPage?: boolean; calendarNextLink?: string; calendarPaginationLoop?: boolean;
  recipientReadFailure?: { category: "permission-failure" | "graph-throttling" | "read-failure"; status: number };
  unrelatedMail?: boolean;
  missingSeed?: boolean; otherReply?: boolean; invalidSeedSender?: boolean;
} = {}) {
  const probe: Probe = {
    id: "exchange-one", cohort: "exchange-global", type, mailbox: sender,
    ...(!options.missingSetup ? {
      recipientMailbox: recipient,
      ...(type === "exchange-reply" && !options.missingSeed ? {
        replySeed: { messageId: "reply-seed", correlationId: "11111111-1111-4111-8111-111111111111" },
      } : {}),
      distributionList: { address: "list@example.invalid", expectedRecipients: [sender, recipient] },
    } : {}),
  };
  let clock = Date.parse("2026-10-26T10:00:00Z");
  let subject = type === "exchange-reply" ? replySeedSubject("11111111-1111-4111-8111-111111111111") : "";
  let updatedSubject = "";
  let attachment = "";
  let replySubject = "";
  let replyBody = "";
  let accepted = false;
  let cancelled = false;
  let seriesDeleted = false;
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const signal = new AbortController();
  const graph = {
    authenticate: vi.fn(async () => {}),
    json: vi.fn(async <T>(path: string, schema: z.ZodType<T>, _signal: AbortSignal, method = "GET", body?: any): Promise<T> => {
      calls.push({ path, method, body });
      clock += 5;
      if (path.includes("/messages/reply-seed?")) return schema.parse({
        id: "reply-seed", subject, isDraft: false, conversationId: "recipient-conversation",
        internetMessageId: "<original@example.invalid>",
        from: { emailAddress: { address: options.invalidSeedSender ? recipient : sender } },
        internetMessageHeaders: [{ name: "x-ahm-reply-seed-id", value: probe.replySeed!.correlationId }],
      });
      if (method === "POST" && path.endsWith("/messages")) {
        subject = body.subject;
        attachment = body.attachments?.[0]?.contentBytes ?? "";
        return schema.parse({ id: "draft" });
      }
      if (method === "POST" && path.endsWith("/createReply")) {
        replySubject = `RE: ${subject}`;
        return schema.parse({ id: "reply-draft", subject: replySubject, conversationId: "recipient-conversation" });
      }
      if (method === "POST" && path.endsWith("/events")) {
        subject = body.subject;
        if (options.createFails) throw new IntegrationError("graph-unavailable");
        return schema.parse({ id: "organizer", subject: options.malformedCreatedEvent ? null : subject,
          iCalUId: "owned-meeting", seriesMasterId: null });
      }
      if (path.includes("/attachments/")) return schema.parse({ contentBytes: options.badHash ? Buffer.from("corruption").toString("base64") : attachment });
      if (path.endsWith("/attachments")) return schema.parse({ value: [{ id: "attachment", name: "synthetic.txt" }] });
      if (path.includes("/instances?")) return schema.parse({
        value: Array.from({ length: options.occurrenceCount ?? 3 }, (_, index) => ({
          id: options.duplicateOccurrence ? "occurrence" : `occurrence-${index}`,
          subject: updatedSubject && !(options.staleOccurrenceUpdate && index === 2) ? updatedSubject : subject,
          seriesMasterId: "organizer", type: "occurrence",
        })),
      });
      if (path.includes("/calendarView?")) {
        const nextPage = new URLSearchParams(path.split("?")[1]).has("$skiptoken");
        const hasAttendee = !options.calendarPaginationLoop && (!options.attendeeOnSecondPage || nextPage);
        return schema.parse({
          value: [
            ...(hasAttendee ? [{ id: "attendee", subject, iCalUId: "owned-meeting" }] : []),
            { id: "unrelated", subject, iCalUId: "someone-else" },
          ],
          ...(!hasAttendee || options.calendarNextLink ? {
            "@odata.nextLink": options.calendarNextLink ??
              `https://graph.microsoft.com/v1.0/users/${recipient}/calendarView?$skiptoken=next-page`,
          } : {}),
        });
      }
      if (path.endsWith("/events/organizer")) {
        if (seriesDeleted && options.seriesDeletionReadDenied) throw new IntegrationError("permission-failure", 403);
        if (seriesDeleted && !options.seriesDeletionPending) throw new IntegrationError("read-failure", 404);
        return schema.parse({
          id: "organizer", subject: updatedSubject || subject,
          attendees: [{ emailAddress: { address: recipient }, status: { response: accepted ? "accepted" : "notResponded" } }],
        });
      }
      if (path.endsWith("/events/attendee")) {
        if (cancelled && options.cancellationReadAborted) {
          signal.abort(new DOMException("Execution deadline", "AbortError"));
          throw signal.signal.reason;
        }
        if (options.cancellationReadDenied) throw new IntegrationError("permission-failure", 403);
        if (cancelled && options.cancelledEventMissing) throw new IntegrationError("read-failure", 404);
        return schema.parse({ id: "attendee", subject, iCalUId: "owned-meeting",
          isCancelled: cancelled && !options.cancellationPending });
      }
      if (path.includes("/messages?")) {
        const querySubject = new URLSearchParams(path.split("?")[1]).get("$filter") ?? "";
        if (!path.includes("/inbox/")) return schema.parse({
          value: options.unrelatedMail || options.otherReply ? [
            { id: "unrelated-mail-copy", subject: "Not owned by this attempt" },
            { id: "reply-seed", subject, bodyPreview: "Retained synthetic reply fixture" },
            { id: "another-attempt-reply", subject: replySubject, bodyPreview: "Correlated reply another-attempt" },
            { id: querySubject.includes("RE:") ? "reply-owned-copy" : "original-owned-copy",
              subject: querySubject.includes("RE:") ? replySubject : subject, bodyPreview: replyBody },
          ] : [],
        });
        if (options.recipientReadFailure && path.includes(encodeURIComponent(recipient))) {
          throw new IntegrationError(options.recipientReadFailure.category, options.recipientReadFailure.status);
        }
        if (options.missingRecipient && path.includes(encodeURIComponent(recipient))) return schema.parse({ value: [] });
        const reply = querySubject.includes("RE:");
        return schema.parse({
          value: [
            ...(options.otherReply ? [{
              id: "another-attempt-reply", subject: replySubject, bodyPreview: "Correlated reply another-attempt",
            }] : []),
            ...(options.unrelatedMail ? [{ id: "unrelated-inbox-mail", subject: "Not owned by this attempt" }] : []), {
            id: reply ? "received-reply" : "received", subject: reply ? replySubject : subject,
            conversationId: reply ? "sender-conversation" : "recipient-conversation",
            internetMessageId: reply ? "<reply@example.invalid>" : "<original@example.invalid>",
            internetMessageHeaders: reply && !options.missingReplyHeader ? [
              { name: "In-Reply-To", value: options.badReply ? "<unrelated@example.invalid>" : "<original@example.invalid>" },
              ...(options.duplicateReplyHeader ? [{ name: "in-reply-to", value: "<original@example.invalid>" }] : []),
            ] : [],
            bodyPreview: options.badReplyBody ? "Uncorrelated text" : replyBody,
            from: { emailAddress: { address: options.badReplySender ? sender : recipient } },
          }],
        });
      }
      throw new Error(`Unexpected read ${method} ${path}`);
    }),
    request: vi.fn(async (path: string, _signal: AbortSignal, method = "GET", body?: any) => {
      calls.push({ path, method, body });
      clock += 5;
      if (options.failStage && path.endsWith(options.failStage)) throw new IntegrationError("permission-failure", 403);
      if (method === "DELETE" && cancelled && path.endsWith("/events/organizer")) {
        throw new IntegrationError("graph-unavailable", 400);
      }
      if (method === "DELETE" && type === "exchange-recurring-calendar" && path.endsWith("/events/organizer")) seriesDeleted = true;
      if (method === "DELETE" && path.endsWith("/events/attendee")) {
        if (options.attendeeCleanupStatus) throw new IntegrationError("graph-unavailable", options.attendeeCleanupStatus);
        if (cancelled && options.cancelledEventMissing) return new Response(null, { status: 404 });
      }
      if (path.endsWith("/reply-draft") && method === "PATCH") replyBody = body.body.content;
      if (path.endsWith("/events/organizer") && method === "PATCH") updatedSubject = body.subject;
      if (path.endsWith("/accept")) accepted = true;
      if (path.endsWith("/cancel")) cancelled = true;
      return new Response(null, { status: 204 });
    }),
  } as unknown as GraphClient;
  const result = await handlers[type](probe, {
    config: { PROBE_TIMEOUT_MS: 1000, POLL_INTERVAL_MS: 100, SYNTHETIC_SCENARIO: "healthy", EXCHANGE_CLEANUP_ENABLED: options.cleanup === false ? "false" : "true" },
    signal: signal.signal, graph, telemetry: { emit() {} }, now: () => clock,
    sleep: async ms => { clock += ms; },
  });
  expect(resultSchema.safeParse(result).success).toBe(true);
  return { result, calls, graph };
}

describe("Exchange consolidated attachment, distribution and calendar journeys", () => {
  it.each(Object.keys(handlers) as (keyof typeof handlers)[])("completes %s in business-step order", async type => {
    const { result } = await run(type);
    expect(result.success).toBe(true);
    expect(result.steps.every(step => step.status === "succeeded")).toBe(true);
  });
  it("verifies attachment delivery without creating a reply", async () => {
    const { result, calls } = await run("exchange-attachment");
    expect(result.success).toBe(true);
    const create = calls.find(call => call.method === "POST" && call.path.endsWith("/messages"));
    expect(create?.body).toMatchObject({ toRecipients: [{ emailAddress: { address: recipient } }] });
    expect(calls.some(call => call.path.endsWith("/createReply"))).toBe(false);
    expect(result.steps.map(step => step.name)).toEqual(["authenticate", "send-attachment", "verify-attachment", "cleanup"]);
    expect((await run("exchange-attachment", { badHash: true })).result).toMatchObject({ success: false, diagnosticCategory: "read-failure" });
  });
  it("replies to the retained received message without sending or waiting for a new starter mail", async () => {
    const { result, calls } = await run("exchange-reply");
    expect(result.success).toBe(true);
    expect(calls.some(call => call.method === "POST" && call.path.endsWith("/messages"))).toBe(false);
    expect(calls.some(call => call.path.includes(`${encodeURIComponent(recipient)}/mailFolders/inbox/messages`))).toBe(false);
    expect(calls.some(call => call.path.includes(`${encodeURIComponent(recipient)}/messages/reply-seed/createReply`))).toBe(true);
    const readback = calls.find(call => call.path.includes(`${encodeURIComponent(sender)}/mailFolders/inbox/messages`))!;
    expect(new URLSearchParams(readback.path.split("?")[1]).get("$select")).toContain("internetMessageHeaders");
    expect(new URLSearchParams(readback.path.split("?")[1]).get("$filter")).toContain("receivedDateTime ge");
    expect(calls.some(call => call.method === "DELETE" && call.path.endsWith("/reply-seed"))).toBe(false);
  });
  it.each(["badReply", "badReplySender", "missingReplyHeader", "duplicateReplyHeader"] as const)(
    "does not mask invalid received reply evidence: %s", async failure => {
      const { result } = await run("exchange-reply", { [failure]: true });
      expect(result).toMatchObject({ success: false, diagnosticCategory: "read-failure" });
      expect(result.steps.find(step => step.name === "reply-mail")?.status).toBe("succeeded");
      expect(result.steps.find(step => step.name === "confirm-reply-mail")?.status).toBe("failed");
    },
  );
  it("ignores another attempt's reply and never deletes it or the retained seed during cleanup", async () => {
    const { result, calls } = await run("exchange-reply", { otherReply: true });
    expect(result.success).toBe(true);
    const deleted = calls.filter(call => call.method === "DELETE").map(call => call.path);
    expect(deleted.some(path => path.endsWith("/reply-owned-copy"))).toBe(true);
    expect(deleted.some(path => path.endsWith("/reply-seed") || path.endsWith("/another-attempt-reply"))).toBe(false);
  });
  it("does not claim an unmarked reply as this attempt's delivery", async () => {
    const { result, calls } = await run("exchange-reply", { badReplyBody: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout" });
    expect(calls.some(call => call.method === "DELETE" && call.path.endsWith("/received-reply"))).toBe(false);
  });
  it.each(["missingSeed", "invalidSeedSender"] as const)("fails unsafe fixture setup before creating a reply: %s", async failure => {
    const { result, calls } = await run("exchange-reply", { [failure]: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "configuration-failure" });
    expect(calls.some(call => call.method === "POST")).toBe(false);
  });
  it("sends only to the explicit group and requires every expected recipient", async () => {
    const { calls } = await run("exchange-distribution-list");
    expect(calls.find(call => call.method === "POST" && call.path.endsWith("/messages"))?.body)
      .toMatchObject({ toRecipients: [{ emailAddress: { address: "list@example.invalid" } }] });
    const { result } = await run("exchange-distribution-list", { missingRecipient: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout" });
    expect(result.steps.find(step => step.name === "confirm-group-delivery")).toMatchObject({ status: "failed" });
  });
  it.each([
    { category: "permission-failure", status: 403 },
    { category: "graph-throttling", status: 429 },
    { category: "read-failure", status: 503 },
  ] as const)("preserves recipient API evidence instead of inventing a delivery timeout ($status)", async recipientReadFailure => {
    const { result, calls } = await run("exchange-distribution-list", { recipientReadFailure });
    expect(result).toMatchObject({
      success: false, diagnosticCategory: recipientReadFailure.category,
      diagnosticContext: { httpStatus: recipientReadFailure.status, cleanupSucceeded: true },
    });
    expect(calls.filter(call => call.path.includes("/mailFolders/inbox/messages"))).toHaveLength(2);
    expect(calls.some(call => call.method === "DELETE" && call.path.endsWith("/received"))).toBe(true);
  });
  it.each(["exchange-attachment", "exchange-distribution-list"] as const)(
    "never claims unrelated Inbox or cleanup-discovery records for %s", async type => {
      const { result, calls } = await run(type, { unrelatedMail: true });
      expect(result.success).toBe(true);
      expect(calls.some(call => call.method === "DELETE" && call.path.includes("unrelated"))).toBe(false);
      expect(calls.some(call => call.method === "DELETE" && call.path.endsWith("/original-owned-copy"))).toBe(true);
    },
  );
  it("creates real recurrence, reads occurrences, updates and verifies before deleting the owned series", async () => {
    const { calls } = await run("exchange-recurring-calendar", { cleanup: false });
    expect(calls.find(call => call.method === "POST" && call.path.endsWith("/events"))?.body)
      .toMatchObject({ recurrence: { pattern: { type: "daily" }, range: { numberOfOccurrences: 3 } } });
    expect(calls.filter(call => call.path.includes("/instances?"))).toHaveLength(2);
    expect(calls.filter(call => call.method === "DELETE")).toEqual([
      expect.objectContaining({ path: `/users/${encodeURIComponent(sender)}/events/organizer` }),
    ]);
    const deletionIndex = calls.findIndex(call => call.method === "DELETE");
    expect(calls[deletionIndex + 1]).toMatchObject({
      method: "GET", path: `/users/${encodeURIComponent(sender)}/events/organizer`,
    });
  });
  it("requires observed recurring-series removal and retains cleanup ownership if deletion does not become visible", async () => {
    const { result, calls } = await run("exchange-recurring-calendar", { seriesDeletionPending: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout" });
    expect(result.steps.find(step => step.name === "delete-event")?.status).toBe("failed");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(calls.filter(call => call.method === "DELETE" && call.path.endsWith("/events/organizer"))).toHaveLength(2);
  });
  it("does not confuse denied recurring-series readback with deletion", async () => {
    const { result } = await run("exchange-recurring-calendar", { seriesDeletionReadDenied: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "permission-failure" });
    expect(result.steps.find(step => step.name === "delete-event")?.status).toBe("failed");
  });
  it.each([0, 1, 2, 4])("rejects an incomplete or unexpected recurrence containing %s occurrences", async occurrenceCount => {
    const { result, calls } = await run("exchange-recurring-calendar", { occurrenceCount });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout" });
    expect(result.steps.find(step => step.name === "read-occurrence")?.status).toBe("failed");
    expect(calls.some(call => call.method === "DELETE" && call.path.endsWith("/events/organizer"))).toBe(true);
  });
  it("rejects duplicate occurrence IDs instead of counting the same occurrence three times", async () => {
    const { result } = await run("exchange-recurring-calendar", { duplicateOccurrence: true });
    expect(result.success).toBe(false);
    expect(result.steps.find(step => step.name === "read-occurrence")?.status).toBe("failed");
  });
  it("requires the series update to reach every occurrence", async () => {
    const { result } = await run("exchange-recurring-calendar", { staleOccurrenceUpdate: true });
    expect(result.success).toBe(false);
    expect(result.steps.find(step => step.name === "read-occurrence")?.status).toBe("succeeded");
    expect(result.steps.find(step => step.name === "verify-event")?.status).toBe("failed");
  });
  it("verifies attendee calendar, accepts, observes organizer response, cancels, and cleans only owned IDs despite mail opt-out", async () => {
    const { result, calls } = await run("exchange-meeting", { cleanup: false });
    expect(result.success).toBe(true);
    expect(calls.filter(call => call.method === "POST").map(call => call.path.split("/").at(-1)))
      .toEqual(["events", "accept", "cancel"]);
    const deleted = calls.filter(call => call.method === "DELETE").map(call => call.path);
    expect(deleted).toEqual([`/users/${encodeURIComponent(recipient)}/events/attendee`]);
    expect(deleted.join()).not.toContain("unrelated");
    expect(deleted.join()).not.toContain("/messages/");
  });
  it("skips dependent business steps after rejection but still performs mandatory owned calendar cleanup", async () => {
    const { result, calls } = await run("exchange-meeting", { failStage: "/accept", cleanup: false });
    expect(result.success).toBe(false);
    expect(result.steps.find(step => step.name === "accept-meeting")).toMatchObject({ status: "failed", diagnosticCategory: "permission-failure" });
    expect(result.steps.find(step => step.name === "confirm-acceptance")).toMatchObject({ status: "skipped", reason: "prerequisite-failed" });
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
  });
  it("keeps both owned events eligible for cleanup when cancellation is rejected", async () => {
    const { result, calls } = await run("exchange-meeting", { failStage: "/cancel", cleanup: false });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "permission-failure" });
    expect(result.steps.find(step => step.name === "cancel-meeting")?.status).toBe("failed");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(calls.filter(call => call.method === "DELETE").map(call => call.path)).toEqual([
      `/users/${encodeURIComponent(sender)}/events/organizer`, `/users/${encodeURIComponent(recipient)}/events/attendee`,
    ]);
  });
  it("does not treat cancellation acceptance as proof that the attendee calendar changed", async () => {
    const { result, calls } = await run("exchange-meeting", { cancellationPending: true, cleanup: false });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout" });
    expect(result.steps.find(step => step.name === "confirm-acceptance")?.status).toBe("succeeded");
    expect(result.steps.find(step => step.name === "cancel-meeting")?.status).toBe("failed");
    expect(calls.filter(call => call.method === "DELETE").map(call => call.path))
      .toEqual([`/users/${encodeURIComponent(recipient)}/events/attendee`]);
  });
  it.each([400, 403, 503])("preserves actual attendee cleanup failure (%s) after successful cancellation", async attendeeCleanupStatus => {
    const { result } = await run("exchange-meeting", { cleanup: false, attendeeCleanupStatus });
    expect(result).toMatchObject({
      success: false, diagnosticCategory: "cleanup-failure",
      diagnosticContext: { cleanupSucceeded: false },
    });
    expect(result.steps.find(step => step.name === "cancel-meeting")?.status).toBe("succeeded");
    expect(result.steps.find(step => step.name === "cleanup")?.status).toBe("failed");
  });
  it("cleans the remaining attendee event with an independent signal after the execution deadline", async () => {
    const { result, graph } = await run("exchange-meeting", { cleanup: false, cancellationReadAborted: true });
    expect(result).toMatchObject({
      success: false, diagnosticCategory: "cancelled",
      diagnosticContext: { cleanupSucceeded: true },
    });
    const executionSignal = vi.mocked(graph.json).mock.calls[0]![2];
    expect(executionSignal.aborted).toBe(true);
    const deletions = vi.mocked(graph.request).mock.calls.filter(call => call[2] === "DELETE");
    expect(deletions).toHaveLength(1);
    expect(deletions[0]![1]).not.toBe(executionSignal);
    expect(deletions[0]![1].aborted).toBe(false);
  });
  it("finds the owned attendee event on a later calendar page with Graph's literal @ encoding", async () => {
    const { result, calls } = await run("exchange-meeting", { attendeeOnSecondPage: true });
    expect(result.success).toBe(true);
    expect(calls.filter(call => call.path.includes("/calendarView?"))).toHaveLength(2);
    expect(calls.find(call => call.path.includes("$skiptoken"))?.path)
      .toBe(`/users/${encodeURIComponent(recipient)}/calendarView?$skiptoken=next-page`);
    expect(calls.filter(call => call.method === "DELETE").map(call => call.path).join()).not.toContain("unrelated");
  });
  it("accepts matching current-page evidence without inspecting unused continuation metadata", async () => {
    const { result, calls } = await run("exchange-meeting", { calendarNextLink: "https://untrusted.invalid/calendarView" });
    expect(result.success).toBe(true);
    expect(calls.filter(call => call.path.includes("/calendarView?"))).toHaveLength(1);
  });
  it.each([
    "https://untrusted.invalid/v1.0/users/recipient@example.invalid/calendarView?$skiptoken=x",
    "http://graph.microsoft.com/v1.0/users/recipient@example.invalid/calendarView?$skiptoken=x",
    "https://graph.microsoft.com/v1.0/users/other@example.invalid/calendarView?$skiptoken=x",
    "https://graph.microsoft.com/v1.0/users/recipient@example.invalid/events?$skiptoken=x",
    "https://graph.microsoft.com/v1.0/users/recipient@example.invalid/../calendarView?$skiptoken=x",
    "https://graph.microsoft.com/v1.0/users/recipient@example.invalid/calendarView?$skiptoken=x#fragment",
  ])("rejects an unsafe or out-of-scope calendar continuation: %s", async calendarNextLink => {
    const { result, calls } = await run("exchange-meeting", { attendeeOnSecondPage: true, calendarNextLink });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "read-failure" });
    expect(calls.filter(call => call.path.includes("/calendarView?"))).toHaveLength(1);
    expect(calls.some(call => call.method === "POST" && call.path.endsWith("/accept"))).toBe(false);
  });
  it("rejects repeated calendar pages without accepting an unrelated event", async () => {
    const { result, calls } = await run("exchange-meeting", { calendarPaginationLoop: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "read-failure" });
    expect(calls.filter(call => call.path.includes("/calendarView?"))).toHaveLength(2);
    expect(calls.filter(call => call.method === "DELETE" && call.path.includes("/events/"))).toEqual([
      expect.objectContaining({ path: `/users/${encodeURIComponent(sender)}/events/organizer` }),
    ]);
  });
  it("accepts an observed removed attendee event as completed cancellation", async () => {
    const { result } = await run("exchange-meeting", { cancelledEventMissing: true });
    expect(result.success).toBe(true);
  });
  it("does not confuse denied attendee readback with a cancelled event", async () => {
    const { result } = await run("exchange-meeting", { cancellationReadDenied: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "permission-failure" });
    expect(result.steps.find(step => step.name === "cancel-meeting")?.status).toBe("failed");
  });
  it.each(["exchange-attachment", "exchange-reply", "exchange-distribution-list", "exchange-meeting"] as const)(
    "fails missing selected live setup for %s instead of inventing A→A participants", async type => {
      const { result, calls } = await run(type, { missingSetup: true });
      expect(result).toMatchObject({ success: false, diagnosticCategory: "configuration-failure" });
      expect(calls).toHaveLength(0);
      expect(result.steps.filter(step => !["authenticate", "cleanup"].includes(step.name)).every(step => step.status === "skipped")).toBe(true);
    },
  );
  it("never deletes an event without an owned returned ID after ambiguous creation", async () => {
    const { result, calls } = await run("exchange-recurring-calendar", { createFails: true });
    expect(result.success).toBe(false);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(0);
  });
  it("retains ownership for cleanup when a successful create returns invalid event fields", async () => {
    const { result, calls } = await run("exchange-recurring-calendar", { malformedCreatedEvent: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "malformed-response" });
    expect(calls.filter(call => call.method === "DELETE")).toEqual([
      expect.objectContaining({ path: `/users/${encodeURIComponent(sender)}/events/organizer` }),
    ]);
  });
});
