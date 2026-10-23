import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { graphNextPagePath, type GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";
import { validateTeamsServiceUrl, type TeamsJourneyClient } from "../../utils/src/teams.js";

const identifier = z.string().min(1).max(2048);
const messageSchema = z.object({
  id: identifier,
  deletedDateTime: z.string().nullable().optional(),
  body: z.object({ contentType: z.enum(["text", "html"]), content: z.string().max(65536) }),
  from: z.object({
    application: z.object({ id: identifier }).nullable().optional(),
    user: z.object({ id: identifier }).nullable().optional(),
  }).nullable().optional(),
});
const messagesSchema = z.object({
  value: z.array(messageSchema).max(50),
  "@odata.nextLink": z.string().min(1).max(8192).optional(),
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
      !skipToken || skipToken.length > 4096 ||
      (top !== null && (!/^[1-9]\d?$/.test(top) || Number(top) > 50))) {
    throw new IntegrationError("read-failure");
  }
  return path;
}

function matchesMarker(body: { contentType: "text" | "html"; content: string }, marker: string): boolean {
  // Only harmless, attribute-free paragraph/line wrappers are normalized; no HTML is evaluated.
  const plain = body.contentType === "html"
    ? body.content.replace(/<\/?(?:p|div)\s*>|<br\s*\/?>/gi, "\n")
    : body.content;
  return plain.trim() === marker;
}

async function findMessage(
  graph: GraphClient, messagesPath: string, marker: string, applicationId: string,
  signal: AbortSignal, now: () => number, deadline: number, userDelegated = false, expectedId?: string,
): Promise<string | undefined> {
  // Delegated POSTs return Graph IDs; bot activity IDs require the existing collection lookup.
  if (userDelegated) {
    if (typeof expectedId !== "string" || !identifier.safeParse(expectedId).success || expectedId.trim() !== expectedId ||
        expectedId === "." || expectedId === ".." || /[\u0000-\u001f\u007f]/.test(expectedId)) {
      throw new IntegrationError("read-failure");
    }
    signal.throwIfAborted();
    if (now() >= deadline) throw new IntegrationError("read-failure");
    let message: z.infer<typeof messageSchema>;
    try {
      message = await graph.json(`${messagesPath}/${encodeURIComponent(expectedId)}`, messageSchema, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (now() > deadline) throw new IntegrationError("read-failure");
      if (error instanceof IntegrationError && error.status === 404) return undefined;
      throw error;
    }
    signal.throwIfAborted();
    if (now() > deadline) throw new IntegrationError("read-failure");
    return message.id === expectedId && message.deletedDateTime == null &&
      message.from?.user?.id.toLowerCase() === applicationId.toLowerCase() &&
      matchesMarker(message.body, marker) ? message.id : undefined;
  }
  let path = `${messagesPath}?$top=50`;
  const visited = new Set<string>();
  for (let page = 0; page < 5; page++) {
    signal.throwIfAborted();
    if (now() >= deadline || visited.has(path)) throw new IntegrationError("read-failure");
    visited.add(path);
    const messages = await graph.json(path, messagesSchema, signal);
    signal.throwIfAborted();
    if (now() > deadline) throw new IntegrationError("read-failure");
    const next = messages["@odata.nextLink"] === undefined
      ? undefined : nextPagePath(messages["@odata.nextLink"], messagesPath);
    const found = messages.value.find(message =>
      message.deletedDateTime == null &&
      message.from?.application?.id.toLowerCase() === applicationId.toLowerCase() &&
      matchesMarker(message.body, marker));
    if (found) return found.id;
    if (!next) return undefined;
    path = next;
  }
  throw new IntegrationError("read-failure");
}

export interface ChannelAttempt {
  serviceUrl: string;
  tenantId: string;
  teamId: string;
  channelId: string;
  marker: string;
  mutationAttempted: boolean;
  userDelegated?: boolean;
  created?: { conversationId: string; activityId: string };
}

export interface ChannelReplyAttempt extends ChannelAttempt {
  replyMarker: string;
  replyMutationAttempted: boolean;
  reply?: { activityId: string };
}

function channelMessagesPath(attempt: ChannelAttempt): string {
  return `/teams/${encodeURIComponent(attempt.teamId)}/channels/${encodeURIComponent(attempt.channelId)}/messages`;
}

export async function authenticate(
  graph: GraphClient | undefined, bot: TeamsJourneyClient | undefined, attempt: ChannelAttempt, signal: AbortSignal,
): Promise<{ graph: GraphClient; bot: TeamsJourneyClient }> {
  if (!graph || !bot || !attempt.tenantId || !attempt.teamId || !attempt.channelId) {
    throw new IntegrationError("collector-failure");
  }
  attempt.userDelegated = bot.userDelegated;
  if (!bot.userDelegated) attempt.serviceUrl = validateTeamsServiceUrl(attempt.serviceUrl);
  signal.throwIfAborted();
  await graph.authenticate(signal);
  await bot.authenticate(signal);
  signal.throwIfAborted();
  return { graph, bot };
}

export async function postMessage(bot: TeamsJourneyClient, attempt: ChannelAttempt, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  attempt.mutationAttempted = true;
  attempt.created = await bot.createChannelPost(
    attempt.serviceUrl, attempt.tenantId, attempt.teamId, attempt.channelId, attempt.marker, signal,
  );
}

export async function postReply(bot: TeamsJourneyClient, attempt: ChannelReplyAttempt, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!attempt.created) throw new IntegrationError("send-failure");
  attempt.replyMutationAttempted = true;
  attempt.reply = await bot.replyToActivity(
    attempt.serviceUrl, attempt.created.conversationId, attempt.created.activityId, attempt.replyMarker, signal,
  );
}

export async function confirmPublication(
  graph: GraphClient, applicationId: string, attempt: ChannelAttempt, signal: AbortSignal,
  deadline: number, pollIntervalMs: number, now: () => number = Date.now,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = (ms, abort) => delay(ms, undefined, { signal: abort }),
): Promise<void> {
  const messagesPath = channelMessagesPath(attempt);
  while (now() < deadline) {
    signal.throwIfAborted();
    if (await findMessage(graph, messagesPath, attempt.marker, applicationId, signal, now, deadline,
      attempt.userDelegated, attempt.userDelegated ? attempt.created?.activityId : undefined) !== undefined) return;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining), signal);
  }
  throw new IntegrationError("delivery-timeout");
}

export async function confirmReply(
  graph: GraphClient, applicationId: string, attempt: ChannelReplyAttempt, signal: AbortSignal,
  deadline: number, pollIntervalMs: number, now: () => number = Date.now,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = (ms, abort) => delay(ms, undefined, { signal: abort }),
): Promise<void> {
  const messagesPath = channelMessagesPath(attempt);
  let graphRootId: string | undefined;
  while (now() < deadline) {
    signal.throwIfAborted();
    graphRootId ??= await findMessage(graph, messagesPath, attempt.marker, applicationId, signal, now, deadline,
      attempt.userDelegated, attempt.userDelegated ? attempt.created?.activityId : undefined);
    if (graphRootId !== undefined) {
      if (graphRootId.trim() !== graphRootId || graphRootId === "." || graphRootId === ".." ||
          /[\u0000-\u001f\u007f]/.test(graphRootId)) throw new IntegrationError("read-failure");
      const repliesPath = `${messagesPath}/${encodeURIComponent(graphRootId)}/replies`;
      if (await findMessage(graph, repliesPath, attempt.replyMarker, applicationId, signal, now, deadline,
        attempt.userDelegated, attempt.userDelegated ? attempt.reply?.activityId : undefined) !== undefined) return;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining), signal);
  }
  throw new IntegrationError("delivery-timeout");
}

export async function cleanup(bot: TeamsJourneyClient, attempt: ChannelAttempt, signal: AbortSignal): Promise<void> {
  // An ambiguous POST is never repeated or reconciled with unrelated Graph message IDs.
  if (!attempt.created) throw new IntegrationError("cleanup-failure");
  await bot.deleteMessage(attempt.serviceUrl, attempt.created.conversationId, attempt.created.activityId, signal);
}

export async function cleanupReply(bot: TeamsJourneyClient, attempt: ChannelReplyAttempt, signal: AbortSignal): Promise<void> {
  if (!attempt.created) throw new IntegrationError("cleanup-failure");
  let failed = attempt.replyMutationAttempted && !attempt.reply;
  if (attempt.reply) {
    try {
      if (bot.userDelegated) {
        await bot.deleteReply(attempt.created.conversationId, attempt.created.activityId, attempt.reply.activityId, signal);
      } else {
        await bot.deleteMessage(attempt.serviceUrl, attempt.created.conversationId, attempt.reply.activityId, signal);
      }
    } catch { failed = true; }
  }
  try { await cleanup(bot, attempt, signal); }
  catch { failed = true; }
  // Removing the root cannot prove that an ambiguous reply creation was cleaned up.
  if (failed) throw new IntegrationError("cleanup-failure");
}
