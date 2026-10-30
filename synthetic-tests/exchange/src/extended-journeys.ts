import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { StepName, SyntheticResult } from "../../utils/src/contracts.js";
import type { GraphOperations } from "../../utils/src/integrations/graph.js";
import { IntegrationError } from "../../utils/src/integrations/http.js";
import { baseResult, type ProbeContext, type ProbeHandler } from "../../utils/src/execution/probes.js";
import { cleanupStep, finishJourney, journeyFailure, measureStep } from "../../utils/src/execution/steps.js";
import { authenticate, createDraft, mailMarker, sendMessage, type MailAttempt } from "./steps.js";
import { messageSchema, messageSelect, messagesSchema, ownedMessage, selfDraft, selfMessage } from "./mail-safety.js";
import { readReplySeed } from "./reply-seed.js";
import type { LiveProbeFor } from "../../utils/src/configuration/resolved-probes.js";

type ExtendedJourney = "exchange-attachment" | "exchange-reply" | "exchange-recurring-calendar";

const identifiedSchema = z.object({
  id: z.string().min(1),
});

const calendarEventSchema = identifiedSchema.extend({
  subject: z.string(),
  transactionId: z.string().optional(),
  seriesMasterId: z.string().nullable().optional(),
  type: z.string().optional(),
  attendees: z.array(
    z.object({
      emailAddress: z.object({
        address: z.string(),
      }),
    }),
  ),
  organizer: z.object({
    emailAddress: z.object({
      address: z.string(),
    }),
  }).optional(),
});

const calendarEventsResponseSchema = z.object({
  value: z.array(calendarEventSchema),
  "@odata.nextLink": z.string().optional(),
});

const attachmentListResponseSchema = z.object({
  value: z.array(
    identifiedSchema.extend({
      name: z.string(),
    }),
  ),
  "@odata.nextLink": z.string().optional(),
});

const attachmentContentSchema = z.object({
  contentBytes: z.string(),
});

type CalendarEvent = z.infer<typeof calendarEventSchema>;
type MailMessage = z.infer<typeof messageSchema>;

interface ExtendedJourneyAttempt {
  probe: LiveProbeFor<ExtendedJourney>;
  mailbox: string;
  context: ProbeContext;
  result: SyntheticResult;
  graph: GraphOperations;
  startedAt: number;
  subject: string;
  mutated: boolean;
  mail: MailAttempt;
  replyConversation?: string;
  replyMarker?: string;
  ownedEvents: Set<string>;
  reconcileEvent: boolean;
}

/**
 * Formats the Graph API root path for a user mailbox.
 */
function userMailboxPath(mailbox: string): string {
  return `/users/${encodeURIComponent(mailbox)}`;
}

/**
 * Formats the Graph API path for a specific item inside a mailbox collection.
 */
function mailboxItemPath(mailbox: string, collection: string, itemId: string): string {
  return `${userMailboxPath(mailbox)}/${collection}/${encodeURIComponent(itemId)}`;
}

/**
 * Escapes single quotes in a string for safe embedding in an OData filter expression.
 */
function escapeODataString(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Computes the hexadecimal SHA-256 digest of a byte buffer.
 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Executes and records a named step within an extended Exchange journey attempt.
 */
async function runJourneyStep<T>(
  attempt: ExtendedJourneyAttempt,
  name: StepName,
  operation: () => Promise<T>,
): Promise<T> {
  return measureStep(attempt.result, name, operation);
}

/**
 * Polls an asynchronous read operation at the configured interval until a defined value
 * is returned or the probe timeout deadline is reached.
 */
async function pollUntilFound<T>(
  attempt: ExtendedJourneyAttempt,
  readOperation: () => Promise<T | undefined>,
): Promise<T> {
  const { signal, config } = attempt.context;
  const deadline = attempt.startedAt + config.PROBE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const found = await readOperation();
    if (found !== undefined) {
      return found;
    }
    const remainingMs = Math.max(0, deadline - Date.now());
    const waitMs = Math.min(config.POLL_INTERVAL_MS, remainingMs);
    await delay(waitMs, undefined, { signal });
  }

  throw new IntegrationError("delivery-timeout");
}

/**
 * Builds the OData `$filter` clause used to locate synthetic messages for an attempt.
 */
function buildMailFilter(attempt: ExtendedJourneyAttempt): string {
  if (attempt.replyConversation) {
    const escapedConversationId = escapeODataString(attempt.replyConversation);
    const minimumCreatedTime = new Date(attempt.startedAt - 60000).toISOString();
    return `conversationId eq '${escapedConversationId}' and createdDateTime ge ${minimumCreatedTime}`;
  }
  return `subject eq '${escapeODataString(attempt.subject)}'`;
}

/**
 * Determines whether a candidate message in the mailbox was created by this extended journey attempt.
 */
function isAttemptOwnedMail(attempt: ExtendedJourneyAttempt, message: MailMessage): boolean {
  if (message.id === attempt.probe.replySeed?.messageId) {
    return false;
  }
  if (!attempt.replyConversation) {
    return ownedMessage(message, attempt.mailbox, attempt.subject, mailMarker(attempt.mail));
  }

  const hasMatchingConversation = message.conversationId === attempt.replyConversation;
  const hasReplyMarker = message.bodyPreview?.includes(attempt.replyMarker!) === true;
  if (!hasMatchingConversation || !hasReplyMarker) {
    return false;
  }

  if (message.isDraft === true) {
    return selfDraft(message, attempt.mailbox);
  }
  return selfMessage(message, attempt.mailbox);
}

/**
 * Polls the target mailbox inbox until a non-draft message belonging to the attempt arrives.
 */
async function waitForDeliveredMessage(attempt: ExtendedJourneyAttempt): Promise<MailMessage> {
  const query = new URLSearchParams({
    "$filter": buildMailFilter(attempt),
    "$top": "100",
    "$select": messageSelect,
  });

  return pollUntilFound(attempt, async () => {
    const inboxResponse = await attempt.graph.json(
      `${userMailboxPath(attempt.mailbox)}/mailFolders/inbox/messages?${query}`,
      messagesSchema,
      attempt.context.signal,
    );
    const matchingMessages = inboxResponse.value.filter(
      (message) => message.isDraft !== true && isAttemptOwnedMail(attempt, message),
    );
    for (const message of matchingMessages) {
      attempt.mail.ownedMessageIds.add(message.id);
    }
    if (inboxResponse["@odata.nextLink"]) {
      throw new IntegrationError("read-failure");
    }
    return matchingMessages[0];
  });
}

/**
 * Runs the attachment delivery journey by sending a self-addressed email with a text attachment
 * and verifying the delivered attachment's byte length and SHA-256 checksum.
 */
async function executeAttachmentJourney(attempt: ExtendedJourneyAttempt): Promise<void> {
  const attachmentBytes = Buffer.from(`Synthetic attachment ${attempt.result.correlationId}\n`, "utf8");

  await runJourneyStep(attempt, "send-attachment", async () => {
    attempt.mutated = true;
    const draftId = await createDraft(
      attempt.graph,
      attempt.mail,
      attempt.context.signal,
      attachmentBytes.toString("base64"),
    );
    await sendMessage(attempt.graph, attempt.mail, draftId, attempt.context.signal);
  });

  await runJourneyStep(attempt, "verify-attachment", async () => {
    const deliveredMessage = await waitForDeliveredMessage(attempt);
    const messagePath = mailboxItemPath(attempt.mailbox, "messages", deliveredMessage.id);
    const attachmentsResponse = await attempt.graph.json(
      `${messagePath}/attachments`,
      attachmentListResponseSchema,
      attempt.context.signal,
    );
    if (attachmentsResponse["@odata.nextLink"]) {
      throw new IntegrationError("read-failure");
    }

    const attachmentMeta = attachmentsResponse.value.find(
      (file) => file.name === "synthetic.txt",
    );
    if (!attachmentMeta) {
      throw new IntegrationError("read-failure");
    }

    const savedAttachment = await attempt.graph.json(
      `${messagePath}/attachments/${encodeURIComponent(attachmentMeta.id)}`,
      attachmentContentSchema,
      attempt.context.signal,
    );
    const downloadedBytes = Buffer.from(savedAttachment.contentBytes, "base64");
    const hasMatchingSize = downloadedBytes.length === attachmentBytes.length;
    const hasMatchingHash = sha256Hex(downloadedBytes) === sha256Hex(attachmentBytes);
    if (!hasMatchingSize || !hasMatchingHash) {
      throw new IntegrationError("read-failure");
    }
  });
}

/**
 * Runs the self-reply mail journey by creating a reply draft against the retained reply seed,
 * sending the reply to the same mailbox, and verifying threading headers on the delivered reply.
 */
async function executeReplyJourney(attempt: ExtendedJourneyAttempt): Promise<void> {
  let originalMessageId = "";
  let replySubject = "";

  await runJourneyStep(attempt, "reply-mail", async () => {
    const seed = await readReplySeed(attempt.graph, attempt.probe, attempt.context.signal);
    originalMessageId = seed.internetMessageId;
    attempt.replyConversation = seed.conversationId;
    attempt.replyMarker = `Correlated SELF-REPLY ${attempt.result.correlationId}`;
    attempt.mutated = true;

    // Stamp the marker atomically: a lost createReply response must still be discoverable without touching the seed.
    const replyDraft = await attempt.graph.json(
      `${mailboxItemPath(attempt.mailbox, "messages", seed.id)}/createReply`,
      messageSchema,
      attempt.context.signal,
      "POST",
      { comment: attempt.replyMarker },
      false,
    );
    if (replyDraft.id === seed.id) {
      throw new IntegrationError("read-failure");
    }
    attempt.mail.ownedMessageIds.add(replyDraft.id);

    const hasExpectedSubject = Boolean(replyDraft.subject?.endsWith(seed.subject));
    const hasMatchingConversation = replyDraft.conversationId === seed.conversationId;
    const isSelfReplyDraft = selfDraft(replyDraft, attempt.mailbox);
    if (!replyDraft.isDraft || !hasExpectedSubject || !hasMatchingConversation || !isSelfReplyDraft) {
      throw new IntegrationError("configuration-failure", undefined, "self-reply-recipients-required");
    }

    replySubject = replyDraft.subject!;
    const replyDraftPath = mailboxItemPath(attempt.mailbox, "messages", replyDraft.id);
    await attempt.graph.request(
      replyDraftPath,
      attempt.context.signal,
      "PATCH",
      {
        body: {
          contentType: "Text",
          content: attempt.replyMarker,
        },
      },
      false,
    );
    await attempt.graph.request(
      `${replyDraftPath}/send`,
      attempt.context.signal,
      "POST",
      undefined,
      false,
    );
  });

  await runJourneyStep(attempt, "confirm-reply-mail", async () => {
    const deliveredReply = await waitForDeliveredMessage(attempt);
    const inReplyToHeaders =
      deliveredReply.internetMessageHeaders?.filter(
        (header) => header.name.toLowerCase() === "in-reply-to",
      ) ?? [];

    const hasSingleInReplyTo = inReplyToHeaders.length === 1;
    const matchesSeedMessageId =
      hasSingleInReplyTo && inReplyToHeaders[0]!.value.trim() === originalMessageId.trim();
    const hasDistinctInternetMessageId =
      Boolean(deliveredReply.internetMessageId) &&
      deliveredReply.internetMessageId !== originalMessageId;
    const replyHeaderMatched = matchesSeedMessageId && hasDistinctInternetMessageId;

    const hasMatchingSubject = deliveredReply.subject === replySubject;
    const isSelfAddressedReply = selfMessage(deliveredReply, attempt.mailbox);

    if (!replyHeaderMatched || !hasMatchingSubject || !isSelfAddressedReply) {
      attempt.context.telemetry.emit("exchange-self-reply-validation-failed", {
        testId: attempt.probe.id,
        correlationId: attempt.result.correlationId,
        replyHeaderMatched,
      });
      throw new IntegrationError("read-failure");
    }
  });
}

/**
 * Calculates the UTC start/end timestamps and recurrence window for a 3-day daily recurring calendar event.
 */
function buildRecurringEventSchedule() {
  const start = new Date(Date.now() + 86400000);
  start.setUTCHours(12, 0, 0, 0);
  const end = new Date(start.getTime() + 1800000);
  const windowEnd = new Date(start.getTime() + 3 * 86400000);

  return {
    date: start.toISOString().slice(0, 10),
    start: {
      dateTime: start.toISOString().slice(0, -1),
      timeZone: "UTC",
    },
    end: {
      dateTime: end.toISOString().slice(0, -1),
      timeZone: "UTC",
    },
    window: new URLSearchParams({
      startDateTime: start.toISOString(),
      endDateTime: windowEnd.toISOString(),
    }),
  };
}

/**
 * Verifies that a calendar event has no external or internal attendees (private appointment only).
 */
function isPrivateCalendarEvent(savedEvent: CalendarEvent): boolean {
  return savedEvent.attendees.length === 0;
}

/**
 * Verifies that a list of expanded calendar instances contains all three expected occurrences
 * for the series master with the expected subject and no attendees.
 */
function areRecurringInstancesComplete(
  instances: CalendarEvent[],
  seriesMasterId: string,
  expectedSubject: string,
): boolean {
  if (instances.length !== 3) {
    return false;
  }
  const uniqueIds = new Set(instances.map((instance) => instance.id));
  if (uniqueIds.size !== 3) {
    return false;
  }
  return instances.every((instance) => {
    const isExpectedType =
      instance.type === "occurrence" || instance.type === "exception";
    return (
      instance.seriesMasterId === seriesMasterId &&
      isPrivateCalendarEvent(instance) &&
      isExpectedType &&
      instance.subject === expectedSubject
    );
  });
}

/**
 * Runs the private recurring calendar journey by creating a 3-occurrence daily series,
 * verifying instance expansion, updating the series subject, verifying propagation, and deleting the series.
 */
async function executeRecurringCalendarJourney(attempt: ExtendedJourneyAttempt): Promise<void> {
  const schedule = buildRecurringEventSchedule();

  const masterEvent = await runJourneyStep(attempt, "create-event", async () => {
    attempt.mutated = true;
    attempt.reconcileEvent = true;

    const createEventPayload = {
      subject: attempt.subject,
      transactionId: attempt.result.correlationId,
      start: schedule.start,
      end: schedule.end,
      attendees: [],
      responseRequested: false,
      recurrence: {
        pattern: {
          type: "daily",
          interval: 1,
        },
        range: {
          type: "numbered",
          startDate: schedule.date,
          numberOfOccurrences: 3,
          recurrenceTimeZone: "UTC",
        },
      },
    };

    const created = await attempt.graph.json(
      `${userMailboxPath(attempt.mailbox)}/events`,
      identifiedSchema.passthrough(),
      attempt.context.signal,
      "POST",
      createEventPayload,
      false,
    );
    attempt.ownedEvents.add(created.id);
    attempt.reconcileEvent = false;

    const parsed = calendarEventSchema.safeParse(created);
    if (!parsed.success) {
      throw new IntegrationError("malformed-response");
    }
    if (!isPrivateCalendarEvent(parsed.data)) {
      throw new IntegrationError("read-failure");
    }
    return parsed.data;
  });

  const masterEventPath = mailboxItemPath(attempt.mailbox, "events", masterEvent.id);
  const instancesPath = `${masterEventPath}/instances?${schedule.window}`;

  /**
   * Polls the recurring series instances endpoint until all three occurrences reflect the expected subject.
   */
  async function waitForOccurrencesWithSubject(expectedSubject: string): Promise<CalendarEvent[]> {
    return pollUntilFound(attempt, async () => {
      const instancesResponse = await attempt.graph.json(
        instancesPath,
        calendarEventsResponseSchema,
        attempt.context.signal,
      );
      if (instancesResponse["@odata.nextLink"]) {
        throw new IntegrationError("read-failure");
      }
      if (areRecurringInstancesComplete(instancesResponse.value, masterEvent.id, expectedSubject)) {
        return instancesResponse.value;
      }
      return undefined;
    });
  }

  await runJourneyStep(attempt, "read-occurrence", () =>
    waitForOccurrencesWithSubject(attempt.subject),
  );

  const updatedSubject = `${attempt.subject} updated`;
  await runJourneyStep(attempt, "update-event", () =>
    attempt.graph.request(
      masterEventPath,
      attempt.context.signal,
      "PATCH",
      { subject: updatedSubject },
      false,
    ),
  );

  await runJourneyStep(attempt, "verify-event", async () => {
    const savedMaster = await attempt.graph.json(
      masterEventPath,
      calendarEventSchema,
      attempt.context.signal,
    );
    if (savedMaster.subject !== updatedSubject || !isPrivateCalendarEvent(savedMaster)) {
      throw new IntegrationError("read-failure");
    }
    await waitForOccurrencesWithSubject(updatedSubject);
  });

  await runJourneyStep(attempt, "delete-event", async () => {
    await attempt.graph.request(masterEventPath, attempt.context.signal, "DELETE");
    await pollUntilFound(attempt, async () => {
      try {
        await attempt.graph.json(masterEventPath, calendarEventSchema, attempt.context.signal);
        return undefined;
      } catch (error) {
        if (error instanceof IntegrationError && error.status === 404) {
          return true;
        }
        throw error;
      }
    });
    attempt.ownedEvents.delete(masterEvent.id);
  });
}

/**
 * Cleans up any calendar events or mail messages created during an extended Exchange journey attempt.
 */
async function cleanupExtendedJourney(
  attempt: ExtendedJourneyAttempt,
  signal: AbortSignal,
): Promise<void> {
  const failures: unknown[] = [];

  if (attempt.reconcileEvent) {
    try {
      const query = new URLSearchParams({
        "$filter": `subject eq '${escapeODataString(attempt.subject)}'`,
        "$select": "id,subject,transactionId,attendees,organizer",
        "$top": "100",
      });
      const matchingEvents = await attempt.graph.json(
        `${userMailboxPath(attempt.mailbox)}/events?${query}`,
        calendarEventsResponseSchema,
        signal,
      );
      for (const savedEvent of matchingEvents.value) {
        const organizerAddress = savedEvent.organizer?.emailAddress.address.toLowerCase();
        const isOwnedCalendarEvent =
          savedEvent.subject === attempt.subject &&
          savedEvent.transactionId === attempt.result.correlationId &&
          isPrivateCalendarEvent(savedEvent) &&
          organizerAddress === attempt.mailbox.toLowerCase();

        if (isOwnedCalendarEvent) {
          attempt.ownedEvents.add(savedEvent.id);
        }
      }
      if (matchingEvents["@odata.nextLink"]) {
        throw new IntegrationError("cleanup-failure");
      }
    } catch (error) {
      failures.push(error);
    }
  }

  for (const eventId of attempt.ownedEvents) {
    try {
      await attempt.graph.request(
        mailboxItemPath(attempt.mailbox, "events", eventId),
        signal,
        "DELETE",
      );
    } catch (error) {
      failures.push(error);
    }
  }

  const mailCleanupEnabled =
    attempt.context.config.EXCHANGE_CLEANUP_ENABLED !== "false" &&
    attempt.probe.type !== "exchange-recurring-calendar";

  if (mailCleanupEnabled) {
    const attemptedMessageIds = new Set<string>();

    /**
     * Deletes any owned mail messages that have not yet been attempted and are not the retained reply seed.
     */
    async function deleteKnownMessages(): Promise<void> {
      for (const messageId of attempt.mail.ownedMessageIds) {
        if (messageId === attempt.probe.replySeed?.messageId || attemptedMessageIds.has(messageId)) {
          continue;
        }
        attemptedMessageIds.add(messageId);
        try {
          await attempt.graph.request(
            mailboxItemPath(attempt.mailbox, "messages", messageId),
            signal,
            "DELETE",
          );
        } catch (error) {
          failures.push(error);
        }
      }
    }

    await deleteKnownMessages();

    try {
      const query = new URLSearchParams({
        "$filter": buildMailFilter(attempt),
        "$top": "100",
        "$select": messageSelect,
      });
      const messageCopies = await attempt.graph.json(
        `${userMailboxPath(attempt.mailbox)}/messages?${query}`,
        messagesSchema,
        signal,
      );
      for (const copy of messageCopies.value) {
        if (isAttemptOwnedMail(attempt, copy)) {
          attempt.mail.ownedMessageIds.add(copy.id);
        }
      }
      if (messageCopies["@odata.nextLink"]) {
        throw new IntegrationError("cleanup-failure");
      }
    } catch (error) {
      failures.push(error);
    }

    await deleteKnownMessages();
  }

  if (failures.length > 0) {
    throw new IntegrationError("cleanup-failure");
  }
}

/**
 * Creates a ProbeHandler for one of the extended Exchange journeys, wrapping authentication,
 * journey execution, failure reporting, and bounded cleanup.
 */
function createExtendedJourneyProbe(
  isCalendarJourney: boolean,
  operation: (attempt: ExtendedJourneyAttempt) => Promise<void>,
): ProbeHandler<ExtendedJourney> {
  return async (probe, context) => {
    const startedAt = Date.now();
    const result = baseResult(probe, startedAt);
    const mailbox = probe.mailbox;
    const attempt: ExtendedJourneyAttempt = {
      probe,
      mailbox,
      context,
      result,
      startedAt,
      graph: context.graph!,
      subject: `AHM synthetic ${result.correlationId}`,
      mutated: false,
      mail: {
        mailbox,
        correlationId: result.correlationId,
        ownedMessageIds: new Set(),
        mutationAttempted: false,
      },
      ownedEvents: new Set(),
      reconcileEvent: false,
    };

    try {
      await runJourneyStep(attempt, "authenticate", async () => {
        attempt.graph = await authenticate(context.graph, context.signal);
      });
      await operation(attempt);
      result.success = true;
      result.diagnosticContext.testStage = "complete";
    } catch (error) {
      journeyFailure(result, error, context.telemetry);
    } finally {
      context.executionComplete?.();
      const cleanupEnabled =
        isCalendarJourney || context.config.EXCHANGE_CLEANUP_ENABLED !== "false";
      await cleanupStep(
        result,
        attempt.mutated,
        (signal) => cleanupExtendedJourney(attempt, signal),
        context.telemetry,
        Date.now,
        cleanupEnabled,
      );
    }

    return finishJourney(result, startedAt);
  };
}

export const exchangeAttachmentProbe = createExtendedJourneyProbe(false, executeAttachmentJourney);
export const exchangeReplyProbe = createExtendedJourneyProbe(false, executeReplyJourney);
export const exchangeRecurringProbe = createExtendedJourneyProbe(true, executeRecurringCalendarJourney);
