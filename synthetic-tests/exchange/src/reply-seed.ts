import { z } from "zod";
import type { Probe } from "../../utils/src/contracts.js";
import type { GraphOperations } from "../../utils/src/integrations/graph.js";
import { IntegrationError } from "../../utils/src/integrations/http.js";
import { messageSchema, messageSelect, selfMessage } from "./mail-safety.js";

const seedMessageSchema = messageSchema.extend({
  subject: z.string(), isDraft: z.boolean(), bodyPreview: z.string(),
  conversationId: z.string().min(1), internetMessageId: z.string().min(1),
  internetMessageHeaders: z.array(z.object({ name: z.string(), value: z.string() })),
});

/** Reads and verifies the retained received self-addressed fixture; provisioning is exclusively PowerShell setup. */
export async function readReplySeed(
  graph: GraphOperations, target: Pick<Probe, "mailbox" | "replySeed">, signal: AbortSignal,
) {
  if (!target.mailbox || !target.replySeed) throw new IntegrationError("configuration-failure", undefined, "self-reply-seed-required");
  let message: z.infer<typeof seedMessageSchema>;
  try {
    message = await graph.json(
      `/users/${encodeURIComponent(target.mailbox)}/mailFolders/inbox/messages/${encodeURIComponent(target.replySeed.messageId)}?$select=${messageSelect}`,
      seedMessageSchema, signal,
    );
  } catch (error) {
    if (error instanceof IntegrationError && error.status === 404) {
      throw new IntegrationError("configuration-failure", 404, "self-reply-seed-missing-or-paired-reprovision");
    }
    throw error;
  }
  const correlation = target.replySeed.correlationId;
  const headers = message.internetMessageHeaders.filter(header => header.name.toLowerCase() === "x-ahm-reply-seed-id");
  const scopes = message.internetMessageHeaders.filter(header => header.name.toLowerCase() === "x-ahm-reply-seed-scope");
  if (message.id !== target.replySeed.messageId || message.isDraft || !selfMessage(message, target.mailbox) ||
      message.subject !== `AHM SELF-REPLY seed ${correlation}` ||
      !message.bodyPreview.includes(`Retained self-addressed synthetic reply fixture ${correlation}`) ||
      headers.length !== 1 || headers[0]!.value !== correlation || scopes.length !== 1 || scopes[0]!.value !== "self-v1") {
    throw new IntegrationError("configuration-failure", undefined, "self-reply-seed-incompatible-reprovision");
  }
  return message;
}
