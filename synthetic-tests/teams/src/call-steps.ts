import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";

export const callIdSchema = z.string().min(1).max(2048).refine(id =>
  id.trim() === id && id !== "." && id !== ".." && !/[\u0000-\u001f\u007f]/.test(id));
const callSchema = z.object({ id: callIdSchema, state: z.string().min(1).max(64), resultInfo: z.unknown().optional() });
const resultInfoSchema = z.object({
  code: z.number().int().min(-2147483648).max(2147483647).optional(),
  subcode: z.number().int().min(-2147483648).max(2147483647).optional(),
});
const callStates = ["incoming", "establishing", "ringing", "established", "hold", "transferring",
  "transferAccepted", "redirecting", "terminating", "terminated", "unknownFutureValue"];
const pause = async (ms: number, signal: AbortSignal): Promise<void> => { await delay(ms, undefined, { signal }); };
type StateObserver = (state: string, resultCode?: number, resultSubcode?: number) => void;

function callPath(id: string): string {
  if (!callIdSchema.safeParse(id).success) throw new IntegrationError("read-failure");
  return `/communications/calls/${encodeURIComponent(id)}`;
}

async function readOwnedCall(graph: GraphClient, id: string, signal: AbortSignal, onState?: StateObserver) {
  const call = await graph.json(callPath(id), callSchema, signal);
  if (call.id !== id) throw new IntegrationError("read-failure");
  const info = resultInfoSchema.safeParse(call.resultInfo);
  onState?.(callStates.includes(call.state) ? call.state : "unknown",
    info.success ? info.data.code : undefined, info.success ? info.data.subcode : undefined);
  return { state: call.state, resultCode: info.success ? info.data.code : undefined };
}

export async function waitBeforeHangup(
  graph: GraphClient, id: string, signal: AbortSignal, deadline: number,
  pollIntervalMs: number, now: () => number = Date.now, sleep = pause, onState?: StateObserver,
): Promise<void> {
  while (now() < deadline) {
    signal.throwIfAborted();
    const call = await readOwnedCall(graph, id, signal, onState);
    signal.throwIfAborted();
    if (["terminating", "terminated"].includes(call.state) || (call.resultCode !== undefined && call.resultCode >= 400)) {
      throw new IntegrationError("read-failure");
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollIntervalMs, remaining), signal);
  }
  signal.throwIfAborted();
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
