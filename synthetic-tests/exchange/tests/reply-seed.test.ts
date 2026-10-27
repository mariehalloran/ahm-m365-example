import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IntegrationError } from "../../utils/src/http.js";
import { provisionReplySeed, type ReplySeedGraph } from "../src/reply-seed.js";

const target = { id: "pair-one", mailbox: "sender@example.invalid", recipientMailbox: "recipient@example.invalid" };
const priorBinding = { messageId: "old-seed", correlationId: "11111111-1111-4111-8111-111111111111" };

function fixture(options: { existingStatus?: number; wrongSender?: boolean; neverDelivered?: boolean } = {}) {
  let clock = 0;
  let delivered: unknown;
  let inboxReads = 0;
  const calls: { path: string; method: string }[] = [];
  const telemetry = { emit: vi.fn() };
  const graph: ReplySeedGraph = {
    authenticate: vi.fn(async () => {}),
    json: async <T>(
      path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, _signal: AbortSignal,
      method = "GET", body?: unknown,
    ): Promise<T> => {
      clock += 5;
      calls.push({ path, method });
      if (path.includes("/messages/old-seed?")) {
        if (options.existingStatus) throw new IntegrationError("read-failure", options.existingStatus);
        return schema.parse({
          id: "old-seed", subject: `AHM reply seed ${priorBinding.correlationId}`, isDraft: false,
          conversationId: "received-thread", internetMessageId: "<original@example.invalid>",
          from: { emailAddress: { address: options.wrongSender ? target.recipientMailbox : target.mailbox } },
          internetMessageHeaders: [{ name: "x-ahm-reply-seed-id", value: priorBinding.correlationId }],
        });
      }
      if (method === "POST") {
        const draft = z.object({
          subject: z.string(), internetMessageHeaders: z.array(z.object({ name: z.string(), value: z.string() })),
        }).parse(body);
        delivered = {
          ...draft, id: "received-seed", isDraft: false,
          conversationId: "received-thread", internetMessageId: "<original@example.invalid>",
          from: { emailAddress: { address: target.mailbox } },
        };
        return schema.parse({ id: "sender-draft" });
      }
      if (path.includes("/inbox/messages?")) {
        return schema.parse({ value: ++inboxReads > 1 && !options.neverDelivered ? [delivered] : [] });
      }
      throw new Error(`Unexpected request ${path}`);
    },
    request: async (path, _signal, method = "GET") => {
      calls.push({ path, method });
      return new Response(null, { status: 202 });
    },
  };
  const context = {
    signal: new AbortController().signal, telemetry, now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
  };
  return { graph, calls, context, telemetry };
}

describe("retained received reply fixtures", () => {
  it("provisions real A-to-B mail and records the received immutable ID and visible setup time", async () => {
    const { graph, calls, context, telemetry } = fixture();
    const binding = await provisionReplySeed(graph, target, context);
    expect(binding.messageId).toBe("received-seed");
    expect(binding.correlationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(calls.filter(call => call.method === "POST")).toEqual([
      { path: "/users/sender%40example.invalid/messages", method: "POST" },
      { path: "/users/sender%40example.invalid/messages/sender-draft/send", method: "POST" },
    ]);
    expect(calls.filter(call => call.path.includes("/recipient%40example.invalid/mailFolders/inbox/"))).toHaveLength(2);
    expect(telemetry.emit).toHaveBeenCalledWith("exchange-reply-seed-ready", {
      targetId: target.id, created: true, durationMs: 2015,
    });
    expect(calls.some(call => call.method === "DELETE")).toBe(false);
  });

  it("validates and reuses an existing fixture without sending or waiting for starter mail", async () => {
    const { graph, calls, context, telemetry } = fixture();
    expect(await provisionReplySeed(graph, { ...target, replySeed: priorBinding }, context)).toEqual(priorBinding);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(telemetry.emit).toHaveBeenCalledWith("exchange-reply-seed-ready", expect.objectContaining({ created: false }));
  });

  it("explicitly reprovisions a deleted fixture rather than using unrelated Inbox mail", async () => {
    const { graph, calls, context, telemetry } = fixture({ existingStatus: 404 });
    const replacement = await provisionReplySeed(graph, { ...target, replySeed: priorBinding }, context);
    expect(replacement.messageId).toBe("received-seed");
    expect(replacement.correlationId).not.toBe(priorBinding.correlationId);
    expect(telemetry.emit).toHaveBeenCalledWith("exchange-reply-seed-missing", { targetId: target.id, action: "reprovision" });
    expect(calls.some(call => call.method === "DELETE")).toBe(false);
  });

  it.each([{ existingStatus: 403 }, { wrongSender: true }])("does not conceal denied or misbound fixture validation: %j", async options => {
    const { graph, calls, context } = fixture(options);
    await expect(provisionReplySeed(graph, { ...target, replySeed: priorBinding }, context)).rejects.toBeInstanceOf(IntegrationError);
    expect(calls.some(call => call.method !== "GET")).toBe(false);
  });

  it("propagates bounded setup cancellation without claiming a ready fixture", async () => {
    const { graph, context, telemetry } = fixture({ neverDelivered: true });
    const controller = new AbortController();
    await expect(provisionReplySeed(graph, target, {
      ...context, signal: controller.signal, sleep: async () => { controller.abort(); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(telemetry.emit.mock.calls.some(([event]) => event === "exchange-reply-seed-ready")).toBe(false);
  });
});
