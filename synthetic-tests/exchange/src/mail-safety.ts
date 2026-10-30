import { z } from "zod";

const addressSchema = z.object({
  emailAddress: z.object({
    address: z.string(),
  }),
});

export const messageSchema = z.object({
  id: z.string().min(1),
  subject: z.string().optional(),
  bodyPreview: z.string().optional(),
  isDraft: z.boolean().optional(),
  conversationId: z.string().optional(),
  internetMessageId: z.string().optional(),
  internetMessageHeaders: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
    }),
  ).optional(),
  from: addressSchema.nullish(),
  toRecipients: z.array(addressSchema).optional(),
  ccRecipients: z.array(addressSchema).optional(),
  bccRecipients: z.array(addressSchema).optional(),
  replyTo: z.array(addressSchema).optional(),
});

export const messagesSchema = z.object({
  value: z.array(messageSchema),
  "@odata.nextLink": z.string().optional(),
});

export const messageSelect =
  "id,subject,bodyPreview,isDraft,conversationId,internetMessageId,internetMessageHeaders,from,toRecipients,ccRecipients,bccRecipients,replyTo";

type Message = z.infer<typeof messageSchema>;
type RecipientAddress = z.infer<typeof addressSchema>;

/**
 * Checks whether a single Graph recipient entry matches the normalized mailbox address.
 */
function isRecipientForMailbox(recipient: RecipientAddress, normalizedMailbox: string): boolean {
  return recipient.emailAddress.address.toLowerCase() === normalizedMailbox;
}

/**
 * Verifies that a message has at least one `to` recipient and that every recipient
 * across `to`, `cc`, `bcc`, and `replyTo` resolves to the target mailbox.
 */
export function selfRecipients(message: Message, mailbox: string): boolean {
  const normalizedMailbox = mailbox.toLowerCase();
  const toRecipients = message.toRecipients ?? [];
  if (toRecipients.length === 0) {
    return false;
  }

  const allToMatch = toRecipients.every((recipient) =>
    isRecipientForMailbox(recipient, normalizedMailbox),
  );
  const allCcMatch = (message.ccRecipients ?? []).every((recipient) =>
    isRecipientForMailbox(recipient, normalizedMailbox),
  );
  const allBccMatch = (message.bccRecipients ?? []).every((recipient) =>
    isRecipientForMailbox(recipient, normalizedMailbox),
  );
  const allReplyToMatch = (message.replyTo ?? []).every((recipient) =>
    isRecipientForMailbox(recipient, normalizedMailbox),
  );

  return allToMatch && allCcMatch && allBccMatch && allReplyToMatch;
}

/**
 * Verifies that a delivered or sent message is addressed from and to the target mailbox only.
 */
export function selfMessage(message: Message, mailbox: string): boolean {
  const senderAddress = message.from?.emailAddress.address.toLowerCase();
  const isFromMailbox = senderAddress === mailbox.toLowerCase();
  return isFromMailbox && selfRecipients(message, mailbox);
}

/**
 * Verifies that a draft message targets only the mailbox itself and has either no sender
 * set yet or the mailbox itself as the sender.
 */
export function selfDraft(message: Message, mailbox: string): boolean {
  if (!selfRecipients(message, mailbox)) {
    return false;
  }
  if (!message.from) {
    return true;
  }
  return message.from.emailAddress.address.toLowerCase() === mailbox.toLowerCase();
}

/**
 * Determines whether a message belongs to the current synthetic attempt by checking
 * its subject, body correlation marker, and self-addressed sender/recipient fields.
 */
export function ownedMessage(
  message: Message,
  mailbox: string,
  subject: string,
  marker: string,
): boolean {
  const hasMatchingSubject = message.subject === subject;
  const hasMatchingMarker = message.bodyPreview?.includes(marker) === true;
  if (!hasMatchingSubject || !hasMatchingMarker) {
    return false;
  }

  if (message.isDraft === true) {
    return selfDraft(message, mailbox);
  }
  return selfMessage(message, mailbox);
}
