import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { graphBase, graphNextPagePath, type GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";
import { validateTeamsServiceUrl, type TeamsBotClient } from "../../utils/src/teams.js";

const identifier = z.string().min(1).max(2048);
const messagesSchema = z.object({
  value: z.array(z.object({
    id: identifier,
    deletedDateTime: z.string().nullable().optional(),
    body: z.object({ contentType: z.enum(["text", "html"]), content: z.string().max(65536) }),
    from: z.object({
      application: z.object({ id: identifier }).nullable().optional(),
    }).nullable().optional(),
  })).max(50),
  "@odata.nextLink": z.string().min(1).max(8192).optional(),
});

function nextPagePath(value: string, messagesPath: string): string {
  const path = graphNextPagePath(value, messagesPath);
  if (value !== `${graphBase}${path}`) throw new IntegrationError("read-failure");
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
  graph: GraphClient | undefined, bot: TeamsBotClient | undefined, attempt: ChannelAttempt, signal: AbortSignal,
): Promise<{ graph: GraphClient; bot: TeamsBotClient }> {
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

export async function postMessage(bot: TeamsBotClient, attempt: ChannelAttempt, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  attempt.mutationAttempted = true;
  attempt.created = await bot.createChannelPost(
    attempt.serviceUrl, attempt.tenantId, attempt.teamId, attempt.channelId, attempt.marker, signal,
  );
}

export async function postReply(bot: TeamsBotClient, attempt: ChannelReplyAttempt, signal: AbortSignal): Promise<void> {
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
    if (await findMessage(graph, messagesPath, attempt.marker, applicationId, signal, now, deadline) !== undefined) return;
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
    graphRootId ??= await findMessage(graph, messagesPath, attempt.marker, applicationId, signal, now, deadline);
    if (graphRootId !== undefined) {
      if (graphRootId.trim() !== graphRootId || graphRootId === "." || graphRootId === ".." ||
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

export async function cleanup(bot: TeamsBotClient, attempt: ChannelAttempt, signal: AbortSignal): Promise<void> {
  // An ambiguous POST is never repeated or reconciled with unrelated Graph message IDs.
  if (!attempt.created) throw new IntegrationError("cleanup-failure");
  await bot.deleteMessage(attempt.serviceUrl, attempt.created.conversationId, attempt.created.activityId, signal);
}

export async function cleanupReply(bot: TeamsBotClient, attempt: ChannelReplyAttempt, signal: AbortSignal): Promise<void> {
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
