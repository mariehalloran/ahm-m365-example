import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";
import { playPromptOperationSchema, type TeamsCallOperations } from "../../utils/src/teams-call-operations.js";
import { testToneResourceId } from "../../utils/src/teams-call-media.js";

export const callIdSchema = z.string().min(1).max(2048).refine(id =>
  id.trim() === id && id !== "." && id !== ".." && !/[\u0000-\u001f\u007f]/.test(id));
const callSchema = z.object({
  id: callIdSchema, state: z.string().min(1).max(64), resultInfo: z.unknown().optional(),
  callChainId: z.string().uuid().nullish(),
});
const resultInfoSchema = z.object({
  code: z.number().int().min(-2147483648).max(2147483647).optional(),
  subcode: z.number().int().min(-2147483648).max(2147483647).optional(),
});
const callStates = ["incoming", "establishing", "ringing", "established", "hold", "transferring",
  "transferAccepted", "redirecting", "terminating", "terminated", "unknownFutureValue"];
const pause = async (ms: number, signal: AbortSignal): Promise<void> => { await delay(ms, undefined, { signal }); };
type StateObserver = (state: string, resultCode?: number, resultSubcode?: number, callChainId?: string) => void;

function callPath(id: string): string {
  if (!callIdSchema.safeParse(id).success) throw new IntegrationError("read-failure");
  return `/communications/calls/${encodeURIComponent(id)}`;
}

async function readOwnedCall(graph: GraphClient, id: string, signal: AbortSignal, onState?: StateObserver) {
  const call = await graph.json(callPath(id), callSchema, signal, "GET", undefined, true, "v1.0", 16384);
  if (call.id !== id) throw new IntegrationError("read-failure");
  const info = resultInfoSchema.safeParse(call.resultInfo);
  onState?.(callStates.includes(call.state) ? call.state : "unknown",
    info.success ? info.data.code : undefined, info.success ? info.data.subcode : undefined, call.callChainId ?? undefined);
  return { state: call.state, resultCode: info.success ? info.data.code : undefined };
}

export async function waitForAnswer(
  graph: GraphClient, id: string, signal: AbortSignal, deadline: number,
  pollIntervalMs: number, now: () => number = Date.now, sleep = pause, onState?: StateObserver,
): Promise<void> {
  const bounded = AbortSignal.timeout(Math.max(1, deadline - now()));
  signal = AbortSignal.any([signal, bounded]);
  while (now() < deadline) {
    signal.throwIfAborted();
    const call = await readOwnedCall(graph, id, signal, onState);
    signal.throwIfAborted();
    if (["terminating", "terminated"].includes(call.state) || (call.resultCode !== undefined && call.resultCode >= 400)) {
      throw new IntegrationError("read-failure");
    }
    if (now() >= deadline) throw new IntegrationError("delivery-timeout");
    if (call.state === "established") return;
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollIntervalMs, remaining), signal);
  }
  throw new IntegrationError("delivery-timeout");
}

const rosterSchema = z.object({
  value: z.array(z.object({
    id: callIdSchema,
    isInLobby: z.boolean().optional(),
    info: z.object({
      identity: z.object({ application: z.object({ id: z.string().uuid() }).nullish() }),
    }),
  })).max(200),
  "@odata.nextLink": z.unknown().optional(),
});

export async function verifyParticipants(
  graph: GraphClient, id: string, expected: readonly [string, string], signal: AbortSignal,
  deadline: number, pollIntervalMs: number, now: () => number = Date.now, sleep = pause,
): Promise<void> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - now()))]);
  while (now() < deadline) {
    signal.throwIfAborted();
    const roster = await graph.json(`${callPath(id)}/participants`, rosterSchema, signal, "GET",
      undefined, true, "v1.0", 131072);
    signal.throwIfAborted();
    // A partial or unbounded roster is not evidence that both bots joined this meeting.
    if (roster["@odata.nextLink"] != null) throw new IntegrationError("read-failure");
    const identities = new Map<string, Set<string>>();
    for (const participant of roster.value) {
      const application = participant.info.identity.application?.id.toLowerCase();
      if (!application || participant.isInLobby !== false) continue;
      const participants = identities.get(application) ?? new Set<string>();
      participants.add(participant.id);
      identities.set(application, participants);
    }
    const [primary, peer] = expected.map(id => identities.get(id.toLowerCase()));
    if (now() < deadline && primary?.size && peer?.size &&
        [...primary].some(id => !peer.has(id))) return;
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollIntervalMs, remaining), signal);
  }
  throw new IntegrationError("delivery-timeout");
}

const meetingCallSchema = z.object({
  id: callIdSchema,
  chatInfo: z.object({ threadId: z.string().min(1).max(300) }),
  meetingInfo: z.object({
    "@odata.type": z.literal("#microsoft.graph.organizerMeetingInfo"),
    organizer: z.object({ user: z.object({ id: z.string().uuid(), tenantId: z.string().uuid() }) }),
  }),
  tenantId: z.string().uuid(),
});

export async function verifyMeetingMetadata(
  graph: GraphClient, id: string, expected: { threadId: string; organizerUserId: string; tenantId: string },
  signal: AbortSignal,
): Promise<void> {
  const call = await graph.json(callPath(id), meetingCallSchema, signal, "GET", undefined, true, "v1.0", 16384);
  signal.throwIfAborted();
  if (call.id !== id || call.chatInfo.threadId !== expected.threadId ||
      call.meetingInfo.organizer.user.id.toLowerCase() !== expected.organizerUserId.toLowerCase() ||
      call.meetingInfo.organizer.user.tenantId.toLowerCase() !== expected.tenantId.toLowerCase() ||
      call.tenantId.toLowerCase() !== expected.tenantId.toLowerCase()) {
    throw new IntegrationError("read-failure");
  }
}

export async function playAudio(
  graph: GraphClient, operations: TeamsCallOperations, id: string, clientContext: string, mediaUri: string, botClientId: string,
  signal: AbortSignal, deadline: number, pollIntervalMs: number,
  now: () => number = Date.now, sleep = pause, onState?: StateObserver,
  onOperation?: (operationId: string, status: string, resultCode?: number) => void,
): Promise<void> {
  signal.throwIfAborted();
  const remaining = deadline - now();
  if (remaining <= 0) throw new IntegrationError("delivery-timeout");
  const bounded = AbortSignal.timeout(remaining);
  signal = AbortSignal.any([signal, bounded]);
  const pending = operations.register(id, clientContext, remaining, botClientId);
  try {
    const accepted = await graph.json(`${callPath(id)}/playPrompt`, playPromptOperationSchema, signal, "POST", {
      clientContext,
      prompts: [{
        "@odata.type": "#microsoft.graph.mediaPrompt",
        mediaInfo: { "@odata.type": "#microsoft.graph.mediaInfo", uri: mediaUri, resourceId: testToneResourceId },
      }],
    }, false, "v1.0", 16384);
    pending.bind(accepted);
    onOperation?.(accepted.id, accepted.status, accepted.resultInfo?.code);
    let lastStatus = "";
    while (now() < deadline) {
      signal.throwIfAborted();
      const call = await readOwnedCall(graph, id, signal, onState);
      if (["terminating", "terminated"].includes(call.state) || (call.resultCode !== undefined && call.resultCode >= 400)) {
        throw new IntegrationError("read-failure");
      }
      signal.throwIfAborted();
      if (now() >= deadline) throw new IntegrationError("delivery-timeout");
      const observed = pending.observation();
      if (observed) {
        if (lastStatus !== observed.status) {
          onOperation?.(accepted.id, observed.status, observed.resultInfo?.code);
          lastStatus = observed.status;
        }
        if (observed.status === "failed" || (observed.resultInfo?.code !== undefined && observed.resultInfo.code >= 400)) {
          throw new IntegrationError("read-failure");
        }
        if (observed.status === "completed") return;
      }
      const timeLeft = deadline - now();
      if (timeLeft > 0) await sleep(Math.min(pollIntervalMs, timeLeft), signal);
    }
    throw new IntegrationError("delivery-timeout");
  } finally { pending.dispose(); }
}

async function waitForCallTermination(
  graph: GraphClient, id: string, signal: AbortSignal,
  deadline: number, pollIntervalMs: number, now: () => number = Date.now, sleep = pause, onState?: StateObserver,
): Promise<void> {
  callPath(id);
  while (now() < deadline) {
    signal.throwIfAborted();
    try {
      const call = await readOwnedCall(graph, id, signal, onState);
      signal.throwIfAborted();
      if (now() > deadline) throw new IntegrationError("delivery-timeout");
      if (call.state === "terminated") return;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof IntegrationError && error.status === 404 && now() <= deadline) return;
      throw error;
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollIntervalMs, remaining), signal);
  }
  throw new IntegrationError("delivery-timeout");
}

export async function leaveCall(
  graph: GraphClient, id: string, signal: AbortSignal, deadline: number,
  pollIntervalMs: number, now: () => number = Date.now, sleep = pause, onState?: StateObserver,
): Promise<void> {
  signal.throwIfAborted();
  const response = await graph.request(callPath(id), signal, "DELETE", undefined, false);
  await response.body?.cancel();
  if (![202, 204, 404].includes(response.status)) throw new IntegrationError("read-failure", response.status);
  await waitForCallTermination(graph, id, signal, deadline, pollIntervalMs, now, sleep, onState);
}
