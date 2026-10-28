import { z } from "zod";

const address = z.object({ emailAddress: z.object({ address: z.string() }) });
export const messageSchema = z.object({
  id: z.string().min(1),
  subject: z.string().optional(),
  bodyPreview: z.string().optional(),
  isDraft: z.boolean().optional(),
  conversationId: z.string().optional(),
  internetMessageId: z.string().optional(),
  internetMessageHeaders: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  from: address.optional(),
  toRecipients: z.array(address).optional(),
  ccRecipients: z.array(address).optional(),
  bccRecipients: z.array(address).optional(),
  replyTo: z.array(address).optional(),
});
export const messagesSchema = z.object({ value: z.array(messageSchema), "@odata.nextLink": z.string().optional() });
export const messageSelect = "id,subject,bodyPreview,isDraft,conversationId,internetMessageId,internetMessageHeaders,from,toRecipients,ccRecipients,bccRecipients,replyTo";
type Message = z.infer<typeof messageSchema>;

export function selfRecipients(message: Message, mailbox: string): boolean {
  const self = (recipient: z.infer<typeof address>) => recipient.emailAddress.address.toLowerCase() === mailbox.toLowerCase();
  return !!message.toRecipients?.length && message.toRecipients.every(self) &&
    (message.ccRecipients ?? []).every(self) && (message.bccRecipients ?? []).every(self) &&
    (message.replyTo ?? []).every(self);
}

export function selfMessage(message: Message, mailbox: string): boolean {
  return message.from?.emailAddress.address.toLowerCase() === mailbox.toLowerCase() && selfRecipients(message, mailbox);
}

export function ownedMessage(message: Message, mailbox: string, subject: string, marker: string): boolean {
  return message.subject === subject && message.bodyPreview?.includes(marker) === true &&
    (message.isDraft === true ? selfRecipients(message, mailbox) : selfMessage(message, mailbox));
}
