import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { graphNextPagePath, type GraphOperations } from "../../utils/src/integrations/graph.js";
import { IntegrationError } from "../../utils/src/integrations/http.js";
import { validateTeamsServiceUrl, type TeamsBotOperations } from "../../utils/src/integrations/teams.js";

const identifier = z.string().min(1).max(2048);
const messageSchema = z.object({
  id: identifier,
  deletedDateTime: z.string().nullable().optional(),
  body: z.object({ contentType: z.enum(["text", "html"]), content: z.string().max(65536) }),
  from: z.object({
    application: z.object({ id: identifier }).nullable().optional(),
  }).nullable().optional(),
});
const messagesSchema = z.object({
  value: z.array(messageSchema).max(50),
  // Graph's opaque continuation token grows with channel history (about 5.5 KB when first observed, over 8 KB
  // after a day of retained posts), so the bound only guards against absurd values; the page itself is capped.
  "@odata.nextLink": z.string().min(1).max(65536).optional(),
});

function nextPagePath(value: string, messagesPath: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new IntegrationError("read-failure"); }
  // Graph emits literal channel-ID ':'/'@' in next links. Normalize only those characters,
  // never path separators or dot segments, and send subsequent requests to our original path.
  const channelEncoding = (path: string) => path.replace(/%3a/gi, ":").replace(/%40/gi, "@");
  if (value !== `${url.origin}${url.pathname}${url.search}` ||
      channelEncoding(url.pathname) !== channelEncoding(`/v1.0${messagesPath}`)) {
    throw new IntegrationError("read-failure");
  }
  url.pathname = `/v1.0${messagesPath}`;
  const path = graphNextPagePath(url.href, messagesPath);
  const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  const keys = [...query.keys()];
  const top = query.get("$top");
  const skipToken = query.get("$skiptoken");
  if (new Set(keys).size !== keys.length || keys.some(key => key !== "$top" && key !== "$skiptoken") ||
      !skipToken ||
      (top !== null && (!/^[1-9]\d?$/.test(top) || Number(top) > 50))) {
    throw new IntegrationError("read-failure");
  }
  return path;
}

export function matchesMarker(body: { contentType: "text" | "html"; content: string }, marker: string): boolean {
  // Only harmless, attribute-free paragraph/line wrappers are normalized; no HTML is evaluated.
  const plain = body.contentType === "html"
    ? body.content.replace(/<\/?(?:p|div)\s*>|<br\s*\/?>/gi, "\n")
    : body.content;
  return plain.trim() === marker;
}

export async function findMessage(
  graph: GraphOperations, messagesPath: string, marker: string, applicationId: string,
  signal: AbortSignal, now: () => number, deadline: number,
): Promise<string | undefined> {
  let path = `${messagesPath}?$top=50`;
  const visited = new Set<string>();
  for (let page = 0; page < 5; page++) {
    signal.throwIfAborted();
    if (now() >= deadline || visited.has(path)) throw new IntegrationError("read-failure");
    visited.add(path);
    const messages = await graph.json(path, messagesSchema, signal);
    signal.throwIfAborted();
    if (now() > deadline) throw new IntegrationError("read-failure");
    const found = messages.value.find(message =>
      message.deletedDateTime == null &&
      message.from?.application?.id.toLowerCase() === applicationId.toLowerCase() &&
      matchesMarker(message.body, marker));
    if (found) return found.id;
    const next = messages["@odata.nextLink"] === undefined
      ? undefined : nextPagePath(messages["@odata.nextLink"], messagesPath);
    if (!next) return undefined;
    path = next;
  }
  return undefined;
}

export interface ChannelAttempt {
  serviceUrl: string;
  tenantId: string;
  teamId: string;
  channelId: string;
  marker: string;
  mutationAttempted: boolean;
  graphRootId?: string;
  created?: { conversationId: string; activityId: string };
}

export interface ChannelReplyAttempt extends ChannelAttempt {
  replyMarker: string;
  replyMutationAttempted: boolean;
  reply?: { activityId: string };
}

export function channelMessagesPath(attempt: ChannelAttempt): string {
  return `/teams/${encodeURIComponent(attempt.teamId)}/channels/${encodeURIComponent(attempt.channelId)}/messages`;
}

export async function authenticate(
  graph: GraphOperations | undefined, bot: TeamsBotOperations | undefined, attempt: ChannelAttempt, signal: AbortSignal,
): Promise<{ graph: GraphOperations; bot: TeamsBotOperations }> {
  if (!graph || !bot || !attempt.tenantId || !attempt.teamId || !attempt.channelId) {
    throw new IntegrationError("collector-failure");
  }
  attempt.serviceUrl = validateTeamsServiceUrl(attempt.serviceUrl);
  signal.throwIfAborted();
  await graph.authenticate(signal);
  await bot.authenticate(signal);
  signal.throwIfAborted();
  return { graph, bot };
}

export async function postMessage(bot: TeamsBotOperations, attempt: ChannelAttempt, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  attempt.mutationAttempted = true;
  attempt.created = await bot.createChannelPost(
    attempt.serviceUrl, attempt.tenantId, attempt.teamId, attempt.channelId, attempt.marker, signal,
  );
}

export async function postReply(bot: TeamsBotOperations, attempt: ChannelReplyAttempt, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!attempt.created) throw new IntegrationError("send-failure");
  attempt.replyMutationAttempted = true;
  try {
    attempt.reply = await bot.replyToActivity(
      attempt.serviceUrl, attempt.created.conversationId, attempt.created.activityId, attempt.replyMarker, signal,
    );
  } catch (error) {
    // A network failure during this mutation is ambiguous (the reply may have been created); treat
    // it as an unconfirmed send, not a generic outage, consistent with the probe-level classification.
    if (error instanceof IntegrationError && error.category === "graph-unavailable") throw new IntegrationError("send-failure");
    throw error;
  }
}

export async function confirmPublication(
  graph: GraphOperations, applicationId: string, attempt: ChannelAttempt, signal: AbortSignal,
  deadline: number, pollIntervalMs: number, now: () => number = Date.now,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = (ms, abort) => delay(ms, undefined, { signal: abort }),
): Promise<void> {
  const messagesPath = channelMessagesPath(attempt);
  while (now() < deadline) {
    signal.throwIfAborted();
    const id = await findMessage(graph, messagesPath, attempt.marker, applicationId, signal, now, deadline);
    if (id !== undefined) { attempt.graphRootId = id; return; }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining), signal);
  }
  throw new IntegrationError("delivery-timeout");
}

export async function confirmReply(
  graph: GraphOperations, applicationId: string, attempt: ChannelReplyAttempt, signal: AbortSignal,
  deadline: number, pollIntervalMs: number, now: () => number = Date.now,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = (ms, abort) => delay(ms, undefined, { signal: abort }),
): Promise<void> {
  const messagesPath = channelMessagesPath(attempt);
  let graphRootId = attempt.graphRootId;
  while (now() < deadline) {
    signal.throwIfAborted();
    graphRootId ??= await findMessage(graph, messagesPath, attempt.marker, applicationId, signal, now, deadline);
    if (graphRootId !== undefined) {
      if (!identifier.safeParse(graphRootId).success || graphRootId.trim() !== graphRootId || graphRootId === "." || graphRootId === ".." ||
          /[\u0000-\u001f\u007f]/.test(graphRootId)) throw new IntegrationError("read-failure");
      const repliesPath = `${messagesPath}/${encodeURIComponent(graphRootId)}/replies`;
      if (await findMessage(graph, repliesPath, attempt.replyMarker, applicationId, signal, now, deadline) !== undefined) return;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining), signal);
  }
  throw new IntegrationError("delivery-timeout");
}

export async function cleanup(bot: TeamsBotOperations, attempt: ChannelAttempt, signal: AbortSignal): Promise<void> {
  // An ambiguous POST is never repeated or reconciled with unrelated Graph message IDs.
  if (!attempt.created) throw new IntegrationError("cleanup-failure");
  await bot.deleteMessage(attempt.serviceUrl, attempt.created.conversationId, attempt.created.activityId, signal);
}

export async function cleanupReply(bot: TeamsBotOperations, attempt: ChannelReplyAttempt, signal: AbortSignal): Promise<void> {
  if (!attempt.created) throw new IntegrationError("cleanup-failure");
  let failed = attempt.replyMutationAttempted && !attempt.reply;
  if (attempt.reply) {
    try {
      await bot.deleteMessage(attempt.serviceUrl, attempt.created.conversationId, attempt.reply.activityId, signal);
    } catch { failed = true; }
  }
  try { await cleanup(bot, attempt, signal); }
  catch { failed = true; }
  // Removing the root cannot prove that an ambiguous reply creation was cleaned up.
  if (failed) throw new IntegrationError("cleanup-failure");
}
