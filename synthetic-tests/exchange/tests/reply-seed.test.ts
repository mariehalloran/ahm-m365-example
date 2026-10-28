import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readBindings } from "../../utils/src/bindings.js";
import { IntegrationError } from "../../utils/src/http.js";
import { readProjectDocument, selectTenant } from "../../utils/src/project-config.js";
import { documentFixture } from "../../utils/tests/fixtures.js";
import { main, provisionReplySeeds } from "../src/mail-test-command.js";
import { provisionReplySeed, type ReplySeedGraph } from "../src/reply-seed.js";

const target = { id: "pair-one", mailbox: "sender@example.invalid", recipientMailbox: "recipient@example.invalid" };
const second = { id: "pair-two", mailbox: "second@example.invalid", recipientMailbox: "recipient@example.invalid" };
const priorBinding = { messageId: "old-seed", correlationId: "11111111-1111-4111-8111-111111111111" };
const priorLines = [
  `CONTOSO__PAIR_ONE__REPLY_SEED_MESSAGE_ID=${priorBinding.messageId}`,
  `CONTOSO__PAIR_ONE__REPLY_SEED_CORRELATION_ID=${priorBinding.correlationId}`,
];

function fixture(options: { existingStatus?: number; wrongSender?: boolean; neverDelivered?: boolean; deniedSender?: string } = {}) {
  let clock = 0;
  let delivered: unknown;
  let deliveries = 0;
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
        if (options.deniedSender && path.startsWith(`/users/${encodeURIComponent(options.deniedSender)}/`)) {
          throw new IntegrationError("permission-failure", 403);
        }
        const draft = z.object({
          subject: z.string(), internetMessageHeaders: z.array(z.object({ name: z.string(), value: z.string() })),
        }).parse(body);
        delivered = {
          ...draft, id: ++deliveries === 1 ? "received-seed" : `received-seed-${deliveries}`, isDraft: false,
          conversationId: "received-thread", internetMessageId: "<original@example.invalid>",
          from: { emailAddress: { address: decodeURIComponent(path.split("/")[2]!) } },
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

describe("reply seed bindings in the .env next to the config", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function workspace(targets: (typeof target)[], env?: string) {
    const document = documentFixture();
    document.tenants[0]!.services.exchange.targets = targets;
    document.groups = [];
    const directory = await mkdtemp(join(tmpdir(), "ahm-reply-seed-"));
    directories.push(directory);
    const file = join(directory, "monitoring.config.json");
    const envFile = join(directory, ".env");
    await writeFile(file, JSON.stringify(document));
    if (env !== undefined) await writeFile(envFile, env);
    return { directory, file, envFile, project: selectTenant(await readProjectDocument(file)) };
  }
  const listing = async (directory: string) => (await readdir(directory)).sort();
  const existing = `# my notes\n${priorLines.join("\n")}\nOTHER=1\n`;

  it("saves each provisioned seed to a new .env and never rewrites the config", async () => {
    const { directory, file, project } = await workspace([target, second]);
    const configText = await readFile(file, "utf8");
    const f = fixture();
    expect(await provisionReplySeeds(project, file, f.graph, f.context)).toEqual(new Set());
    const first = project.services.exchange.targets[0]!.replySeed!;
    const other = project.services.exchange.targets[1]!.replySeed!;
    expect([first.messageId, other.messageId]).toEqual(["received-seed", "received-seed-2"]);
    expect(await readBindings(file)).toEqual({
      CONTOSO__PAIR_ONE__REPLY_SEED_MESSAGE_ID: "received-seed", CONTOSO__PAIR_ONE__REPLY_SEED_CORRELATION_ID: first.correlationId,
      CONTOSO__PAIR_TWO__REPLY_SEED_MESSAGE_ID: "received-seed-2", CONTOSO__PAIR_TWO__REPLY_SEED_CORRELATION_ID: other.correlationId,
    });
    const reloaded = selectTenant(await readProjectDocument(file)).services.exchange.targets;
    expect(reloaded.map(item => item.replySeed)).toEqual([first, other]);
    expect(await readFile(file, "utf8")).toBe(configText);
    expect(await listing(directory)).toEqual([".env", "monitoring.config.json"]);
  });

  it("reuses the seeds a partial .env holds, provisions the rest and keeps every other line", async () => {
    const { file, envFile, project } = await workspace([target, second], existing);
    const f = fixture();
    expect(await provisionReplySeeds(project, file, f.graph, f.context)).toEqual(new Set());
    expect(project.services.exchange.targets[0]!.replySeed).toEqual(priorBinding);
    expect(f.calls.filter(call => call.method === "POST").map(call => call.path)).toEqual([
      "/users/second%40example.invalid/messages", "/users/second%40example.invalid/messages/sender-draft/send",
    ]);
    const added = project.services.exchange.targets[1]!.replySeed!;
    expect(await readFile(envFile, "utf8")).toBe(
      `${existing}CONTOSO__PAIR_TWO__REPLY_SEED_MESSAGE_ID=received-seed\nCONTOSO__PAIR_TWO__REPLY_SEED_CORRELATION_ID=${added.correlationId}\n`,
    );
  });

  it("does not rewrite a .env whose seeds are all still valid", async () => {
    const { file, envFile, project } = await workspace([target], existing);
    const before = await stat(envFile);
    const f = fixture();
    expect(await provisionReplySeeds(project, file, f.graph, f.context)).toEqual(new Set());
    expect(f.calls.map(call => call.method)).toEqual(["GET"]);
    expect(await readFile(envFile, "utf8")).toBe(existing);
    expect((await stat(envFile)).mtimeMs).toBe(before.mtimeMs);
  });

  it("re-provisions a seed that no longer exists and replaces its keys in place", async () => {
    const { file, envFile, project } = await workspace([target], existing);
    const f = fixture({ existingStatus: 404 });
    expect(await provisionReplySeeds(project, file, f.graph, f.context)).toEqual(new Set());
    const replacement = project.services.exchange.targets[0]!.replySeed!;
    expect(replacement.correlationId).not.toBe(priorBinding.correlationId);
    expect(await readFile(envFile, "utf8")).toBe(
      `# my notes\nCONTOSO__PAIR_ONE__REPLY_SEED_MESSAGE_ID=received-seed\nCONTOSO__PAIR_ONE__REPLY_SEED_CORRELATION_ID=${replacement.correlationId}\nOTHER=1\n`,
    );
  });

  it("reports a target whose setup failed and still saves the others", async () => {
    const denied = { id: "pair-denied", mailbox: "denied@example.invalid", recipientMailbox: "recipient@example.invalid" };
    const { file, project } = await workspace([denied, target]);
    const f = fixture({ deniedSender: denied.mailbox });
    expect(await provisionReplySeeds(project, file, f.graph, f.context)).toEqual(new Set(["pair-denied"]));
    expect(f.telemetry.emit).toHaveBeenCalledWith("exchange-reply-seed-setup-failed", {
      targetId: "pair-denied", category: "permission-failure", httpStatus: 403,
    });
    expect(Object.keys(await readBindings(file)).sort()).toEqual([
      "CONTOSO__PAIR_ONE__REPLY_SEED_CORRELATION_ID", "CONTOSO__PAIR_ONE__REPLY_SEED_MESSAGE_ID",
    ]);
    expect(project.services.exchange.targets[0]!.replySeed).toBeUndefined();
  });

  it("treats a seed that cannot be saved as a failed setup", async () => {
    const { file, envFile, project } = await workspace([target]);
    await mkdir(envFile);
    const f = fixture();
    expect(await provisionReplySeeds(project, file, f.graph, f.context)).toEqual(new Set(["pair-one"]));
    expect(f.telemetry.emit).toHaveBeenCalledWith("exchange-reply-seed-setup-failed", {
      targetId: "pair-one", category: "collector-failure",
    });
  });

  it("plans without writing a .env or changing the config", async () => {
    const { directory, file } = await workspace([target, second]);
    const configText = await readFile(file, "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(["--config", file]);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ event: "exchange-reply-seed-setup-plan", targetCount: 2, cloudChanges: false }),
    );
    expect(await listing(directory)).toEqual(["monitoring.config.json"]);
    expect(await readFile(file, "utf8")).toBe(configText);
  });
});
