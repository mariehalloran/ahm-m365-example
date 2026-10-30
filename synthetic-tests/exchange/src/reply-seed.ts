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
  signal: AbortSignal;
  telemetry: Telemetry;
  reprovision?: boolean;
}

const seedMessageSchema = messageSchema.extend({
  subject: z.string(),
  isDraft: z.boolean(),
  bodyPreview: z.string(),
  conversationId: z.string().min(1),
  internetMessageId: z.string().min(1),
  internetMessageHeaders: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
    }),
  ),
});

const inboxSeedMessagesSchema = z.object({
  value: z.array(seedMessageSchema),
  "@odata.nextLink": z.string().optional(),
});

const createdDraftSchema = z.object({
  id: z.string().min(1),
});

type SeedMessage = z.infer<typeof seedMessageSchema>;

/**
 * Formats the Graph API root path for a user mailbox.
 */
function userMailboxPath(mailbox: string): string {
  return `/users/${encodeURIComponent(mailbox)}`;
}

/**
 * Formats the subject line for a retained self-reply seed message.
 */
export function replySeedSubject(correlationId: string): string {
  return `AHM SELF-REPLY seed ${correlationId}`;
}

/**
 * Formats the body marker identifying a retained self-reply seed message.
 */
function seedMarker(correlationId: string): string {
  return `Retained self-addressed synthetic reply fixture ${correlationId}`;
}

/**
 * Checks whether a seed message contains exactly one internet header with the given name and value.
 */
function hasExpectedSeedHeader(
  message: SeedMessage,
  headerName: string,
  expectedValue: string,
): boolean {
  const matchingHeaders = message.internetMessageHeaders.filter(
    (header) => header.name.toLowerCase() === headerName,
  );
  return matchingHeaders.length === 1 && matchingHeaders[0]!.value === expectedValue;
}

/**
 * Validates that a fetched message matches all safety and correlation invariants
 * required of a retained self-reply seed fixture.
 */
function validateSeed(
  message: SeedMessage,
  mailbox: string,
  correlationId: string,
): SeedMessage {
  const hasExpectedSubject = message.subject === replySeedSubject(correlationId);
  const isSelfAddressed = selfMessage(message, mailbox);
  const hasExpectedBody = message.bodyPreview.includes(seedMarker(correlationId));
  const hasSeedIdHeader = hasExpectedSeedHeader(message, "x-ahm-reply-seed-id", correlationId);
  const hasSeedScopeHeader = hasExpectedSeedHeader(message, "x-ahm-reply-seed-scope", "self-v1");

  if (
    message.isDraft ||
    !hasExpectedSubject ||
    !isSelfAddressed ||
    !hasExpectedBody ||
    !hasSeedIdHeader ||
    !hasSeedScopeHeader
  ) {
    throw new IntegrationError(
      "configuration-failure",
      undefined,
      "self-reply-seed-incompatible-reprovision",
    );
  }

  return message;
}

/**
 * Reads and validates the pre-provisioned reply seed message from the target mailbox's inbox.
 */
export async function readReplySeed(
  graph: ReplySeedGraph,
  target: ReplyTarget,
  signal: AbortSignal,
): Promise<SeedMessage> {
  if (!target.mailbox || !target.replySeed) {
    throw new IntegrationError("configuration-failure", undefined, "self-reply-seed-required");
  }

  let saved: SeedMessage;
  try {
    // Folder-scoped lookup excludes the sent copy even though sender and recipient are the same user.
    const encodedMessageId = encodeURIComponent(target.replySeed.messageId);
    const seedPath = `${userMailboxPath(target.mailbox)}/mailFolders/inbox/messages/${encodedMessageId}?$select=${messageSelect}`;
    saved = await graph.json(seedPath, seedMessageSchema, signal);
  } catch (error) {
    if (error instanceof IntegrationError && error.status === 404) {
      throw new IntegrationError(
        "configuration-failure",
        404,
        "self-reply-seed-missing-or-paired-reprovision",
      );
    }
    throw error;
  }

  if (saved.id !== target.replySeed.messageId) {
    throw new IntegrationError("configuration-failure", undefined, "self-reply-seed-id-mismatch");
  }

  return validateSeed(saved, target.mailbox, target.replySeed.correlationId);
}

/**
 * Ensures the target mailbox has a valid retained self-reply seed message in its inbox,
 * reusing an existing valid fixture or provisioning a fresh one and cleaning up transient copies.
 */
export async function provisionReplySeed(
  graph: ReplySeedGraph,
  target: ReplyTarget,
  options: ReplySeedOptions,
): Promise<{ messageId: string; correlationId: string }> {
  const mailbox = target.mailbox;
  if (!mailbox) {
    throw new IntegrationError("configuration-failure");
  }
  const mailboxAddress: string = mailbox;

  const startedAt = Date.now();
  await graph.authenticate(options.signal);

  if (target.replySeed) {
    try {
      await readReplySeed(graph, target, options.signal);
      options.telemetry.emit("exchange-self-reply-seed-ready", {
        targetId: target.id,
        created: false,
        durationMs: Date.now() - startedAt,
      });
      return target.replySeed;
    } catch (error) {
      const isMissingSeed = error instanceof IntegrationError && error.status === 404;
      const isReprovisionableConfigFailure =
        error instanceof IntegrationError &&
        Boolean(options.reprovision) &&
        error.category === "configuration-failure";

      if (!isMissingSeed && !isReprovisionableConfigFailure) {
        throw error;
      }

      let reprovisionReason = "incompatible-fixture";
      if (isMissingSeed) {
        reprovisionReason = "missing-or-paired-binding";
      }

      options.telemetry.emit("exchange-self-reply-seed-reprovisioning", {
        targetId: target.id,
        action: "create-self-fixture-without-deleting-prior-seed",
        reason: reprovisionReason,
      });
    }
  }

  const correlationId = randomUUID();
  const subject = replySeedSubject(correlationId);
  const query = new URLSearchParams({
    "$filter": `subject eq '${subject}'`,
    "$select": messageSelect,
    "$top": "100",
  });
  const ownedMessageIds = new Set<string>();
  let retainedId: string | undefined;
  let cleanupFailed = false;

  try {
    const draftPayload = {
      subject,
      body: {
        contentType: "Text",
        content: `${seedMarker(correlationId)}.`,
      },
      toRecipients: [
        {
          emailAddress: {
            address: mailboxAddress,
          },
        },
      ],
      internetMessageHeaders: [
        {
          name: "x-ahm-reply-seed-id",
          value: correlationId,
        },
        {
          name: "x-ahm-reply-seed-scope",
          value: "self-v1",
        },
      ],
    };

    const draft = await graph.json(
      `${userMailboxPath(mailboxAddress)}/messages`,
      createdDraftSchema,
      options.signal,
      "POST",
      draftPayload,
      false,
    );
    ownedMessageIds.add(draft.id);

    await graph.request(
      `${userMailboxPath(mailboxAddress)}/messages/${encodeURIComponent(draft.id)}/send`,
      options.signal,
      "POST",
      undefined,
      false,
    );

    while (true) {
      options.signal.throwIfAborted();
      const inbox = await graph.json(
        `${userMailboxPath(mailboxAddress)}/mailFolders/inbox/messages?${query}`,
        inboxSeedMessagesSchema,
        options.signal,
      );
      if (inbox["@odata.nextLink"]) {
        throw new IntegrationError("read-failure");
      }

      const saved = inbox.value.find((message) => message.subject === subject);
      if (saved) {
        validateSeed(saved, mailbox, correlationId);
        retainedId = saved.id;
        break;
      }

      await delay(2000, undefined, { signal: options.signal });
    }
  } finally {
    const cleanupSignal = AbortSignal.timeout(5000);
    let failed = false;
    const attemptedMessageIds = new Set<string>();

    /**
     * Deletes any non-retained seed copies that have already been identified.
     */
    async function deleteKnownSeedCopies(): Promise<void> {
      for (const messageId of ownedMessageIds) {
        if (messageId === retainedId || attemptedMessageIds.has(messageId)) {
          continue;
        }
        attemptedMessageIds.add(messageId);
        try {
          await graph.request(
            `${userMailboxPath(mailboxAddress)}/messages/${encodeURIComponent(messageId)}`,
            cleanupSignal,
            "DELETE",
          );
        } catch {
          failed = true;
        }
      }
    }

    await deleteKnownSeedCopies();

    try {
      const copies = await graph.json(
        `${userMailboxPath(mailboxAddress)}/messages?${query}`,
        messagesSchema,
        cleanupSignal,
      );
      for (const copy of copies.value) {
        if (ownedMessage(copy, mailboxAddress, subject, seedMarker(correlationId))) {
          ownedMessageIds.add(copy.id);
        }
      }
      if (copies["@odata.nextLink"]) {
        failed = true;
      }
    } catch {
      failed = true;
    }

    await deleteKnownSeedCopies();
    cleanupFailed = failed;

    if (failed) {
      options.telemetry.emit("exchange-self-reply-seed-cleanup-failed", {
        targetId: target.id,
        category: "cleanup-failure",
      });
    }
  }

  if (cleanupFailed) {
    throw new IntegrationError("cleanup-failure");
  }

  options.telemetry.emit("exchange-self-reply-seed-ready", {
    targetId: target.id,
    created: true,
    durationMs: Date.now() - startedAt,
  });
  return {
    messageId: retainedId,
    correlationId,
  };
}
