import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { resultSchema, type Probe, type TestType } from "../../utils/src/contracts.js";
import type { GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";
import {
  exchangeAttachmentProbe, exchangeDistributionProbe, exchangeMeetingProbe, exchangeRecurringProbe,
} from "../src/extended-journeys.js";

const sender = "sender@example.invalid";
const recipient = "recipient@example.invalid";
const handlers = {
  "exchange-attachment-reply": exchangeAttachmentProbe, "exchange-distribution-list": exchangeDistributionProbe,
  "exchange-recurring-calendar": exchangeRecurringProbe, "exchange-meeting": exchangeMeetingProbe,
};

async function run(type: keyof typeof handlers, options: {
  missingSetup?: boolean; badHash?: boolean; badReply?: boolean; missingRecipient?: boolean;
  cleanup?: boolean; failStage?: string; createFails?: boolean;
  badReplySender?: boolean; badReplyBody?: boolean; missingReplyHeader?: boolean; duplicateReplyHeader?: boolean;
} = {}) {
  const probe: Probe = {
    id: "exchange-one", cohort: "exchange-global", type, mailbox: sender,
    ...(!options.missingSetup ? {
      recipientMailbox: recipient,
      distributionList: { address: "list@example.invalid", expectedRecipients: [sender, recipient] },
    } : {}),
  };
  let clock = Date.parse("2026-10-26T10:00:00Z");
  let subject = "";
  let updatedSubject = "";
  let attachment = "";
  let replySubject = "";
  let replyBody = "";
  let accepted = false;
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const signal = new AbortController();
  const graph = {
    authenticate: vi.fn(async () => {}),
    json: vi.fn(async <T>(path: string, schema: z.ZodType<T>, _signal: AbortSignal, method = "GET", body?: any): Promise<T> => {
      calls.push({ path, method, body });
      clock += 5;
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
        return schema.parse({ id: "organizer", subject, iCalUId: "owned-meeting" });
      }
      if (path.includes("/attachments/")) return schema.parse({ contentBytes: options.badHash ? Buffer.from("corruption").toString("base64") : attachment });
      if (path.endsWith("/attachments")) return schema.parse({ value: [{ id: "attachment", name: "synthetic.txt" }] });
      if (path.includes("/instances?")) return schema.parse({
        value: [{ id: "occurrence", subject: updatedSubject || subject, seriesMasterId: "organizer", type: "occurrence" }],
      });
      if (path.includes("/calendarView?")) return schema.parse({
        value: [{ id: "attendee", subject, iCalUId: "owned-meeting" }, { id: "unrelated", subject, iCalUId: "someone-else" }],
      });
      if (path.endsWith("/events/organizer")) return schema.parse({
        id: "organizer", subject: updatedSubject || subject,
        attendees: [{ emailAddress: { address: recipient }, status: { response: accepted ? "accepted" : "notResponded" } }],
      });
      if (path.includes("/messages?")) {
        const querySubject = new URLSearchParams(path.split("?")[1]).get("$filter") ?? "";
        if (!path.includes("/inbox/")) return schema.parse({ value: [] });
        if (options.missingRecipient && path.includes(encodeURIComponent(recipient))) return schema.parse({ value: [] });
        const reply = querySubject.includes("RE:");
        return schema.parse({
          value: [{
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
      if (path.endsWith("/reply-draft") && method === "PATCH") replyBody = body.body.content;
      if (path.endsWith("/events/organizer") && method === "PATCH") updatedSubject = body.subject;
      if (path.endsWith("/accept")) accepted = true;
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

describe("Exchange expanded completed journeys", () => {
  it.each(Object.keys(handlers) as (keyof typeof handlers)[])("completes %s in business-step order", async type => {
    const { result } = await run(type);
    expect(result.success).toBe(true);
    expect(result.steps.every(step => step.status === "succeeded")).toBe(true);
  });
  it("checks attachment hash and correlates B→A reply headers despite different mailbox-local conversation IDs", async () => {
    const { result, calls } = await run("exchange-attachment-reply");
    expect(result.success).toBe(true);
    const create = calls.find(call => call.method === "POST" && call.path.endsWith("/messages"));
    expect(create?.body).toMatchObject({ toRecipients: [{ emailAddress: { address: recipient } }] });
    expect(calls.some(call => call.path.includes(`${encodeURIComponent(recipient)}/messages/received/createReply`))).toBe(true);
    expect(calls.some(call => call.path.includes(`${encodeURIComponent(sender)}/mailFolders/inbox/messages`))).toBe(true);
    const readback = calls.find(call => call.path.includes(`${encodeURIComponent(sender)}/mailFolders/inbox/messages`))!;
    expect(new URLSearchParams(readback.path.split("?")[1]).get("$select")).toContain("internetMessageHeaders");
    expect((await run("exchange-attachment-reply", { badHash: true })).result).toMatchObject({ success: false, diagnosticCategory: "read-failure" });
    expect((await run("exchange-attachment-reply", { badReply: true })).result.success).toBe(false);
  });
  it.each(["badReply", "badReplySender", "badReplyBody", "missingReplyHeader", "duplicateReplyHeader"] as const)(
    "does not mask invalid received reply evidence: %s", async failure => {
      const { result } = await run("exchange-attachment-reply", { [failure]: true });
      expect(result).toMatchObject({ success: false, diagnosticCategory: "read-failure" });
      expect(result.steps.find(step => step.name === "reply-mail")?.status).toBe("succeeded");
      expect(result.steps.find(step => step.name === "confirm-reply-mail")?.status).toBe("failed");
    },
  );
  it("sends only to the explicit group and requires every expected recipient", async () => {
    const { calls } = await run("exchange-distribution-list");
    expect(calls.find(call => call.method === "POST" && call.path.endsWith("/messages"))?.body)
      .toMatchObject({ toRecipients: [{ emailAddress: { address: "list@example.invalid" } }] });
    const { result } = await run("exchange-distribution-list", { missingRecipient: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout" });
    expect(result.steps.find(step => step.name === "confirm-group-delivery")).toMatchObject({ status: "failed" });
  });
  it("creates real recurrence, reads occurrences, updates and verifies before deleting the owned series", async () => {
    const { calls } = await run("exchange-recurring-calendar", { cleanup: false });
    expect(calls.find(call => call.method === "POST" && call.path.endsWith("/events"))?.body)
      .toMatchObject({ recurrence: { pattern: { type: "daily" }, range: { numberOfOccurrences: 3 } } });
    expect(calls.filter(call => call.path.includes("/instances?"))).toHaveLength(2);
    expect(calls.filter(call => call.method === "DELETE")).toEqual([
      expect.objectContaining({ path: `/users/${encodeURIComponent(sender)}/events/organizer` }),
    ]);
  });
  it("verifies attendee calendar, accepts, observes organizer response, cancels, and cleans only owned IDs despite mail opt-out", async () => {
    const { result, calls } = await run("exchange-meeting", { cleanup: false });
    expect(result.success).toBe(true);
    expect(calls.filter(call => call.method === "POST").map(call => call.path.split("/").at(-1)))
      .toEqual(["events", "accept", "cancel"]);
    const deleted = calls.filter(call => call.method === "DELETE").map(call => call.path);
    expect(deleted).toEqual([
      `/users/${encodeURIComponent(sender)}/events/organizer`, `/users/${encodeURIComponent(recipient)}/events/attendee`,
    ]);
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
  it.each(["exchange-attachment-reply", "exchange-distribution-list", "exchange-meeting"] as const)(
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
});
