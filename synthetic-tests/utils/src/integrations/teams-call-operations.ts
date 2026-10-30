import { z } from "zod";
import { IntegrationError } from "./http.js";
import type { CallingIdentity } from "./teams-calling-auth.js";

const identifier = z.string().min(1).max(2048).refine(value =>
  value.trim() === value && !/[\u0000-\u001f\u007f/\\?#]/.test(value) && ![".", ".."].includes(value));
const status = z.enum(["notStarted", "running", "completed", "failed", "NotStarted", "Running", "Completed", "Failed"])
  .transform(value => value.toLowerCase() as "notstarted" | "running" | "completed" | "failed");
export const playPromptOperationSchema = z.object({
  "@odata.type": z.literal("#microsoft.graph.playPromptOperation").optional(),
  "@odata.context": z.string().max(8192).optional(),
  id: identifier,
  clientContext: z.string().uuid(),
  status,
  resultInfo: z.object({
    code: z.number().int().nullish(), subcode: z.number().int().nullish(),
  }).nullish(),
});
type Operation = z.infer<typeof playPromptOperationSchema>;
interface Attempt {
  callId: string;
  clientContext: string;
  botClientId: string;
  expiresAt: number;
  operationId?: string;
  pending: Operation[];
  latest?: Operation;
}
const notificationSchema = z.object({
  changeType: z.enum(["updated", "deleted"]),
  resourceUrl: z.string().max(8192),
  resourceData: playPromptOperationSchema.omit({ id: true }).extend({
    "@odata.type": z.literal("#microsoft.graph.playPromptOperation"),
    id: identifier.optional(), "@odata.id": z.string().max(8192),
  }),
});

function sameId(left: string, right: string): boolean {
  const guid = /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i;
  return guid.test(left) && guid.test(right)
    ? left.replaceAll("-", "").toLowerCase() === right.replaceAll("-", "").toLowerCase() : left === right;
}

function operationResource(value: string): { callId: string; operationId: string } | undefined {
  const match = /^\/communications\/calls\/([^/]+)\/operations\/([^/]+)$/.exec(value);
  if (!match) return undefined;
  try {
    const callId = decodeURIComponent(match[1]!);
    const operationId = decodeURIComponent(match[2]!);
    if (!identifier.safeParse(callId).success || !identifier.safeParse(operationId).success) return undefined;
    return { callId, operationId };
  } catch { return undefined; }
}

export function promptOperationFailed(operation: Operation): boolean {
  return operation.status === "failed" || (operation.resultInfo?.code ?? 0) >= 400;
}

/** One ephemeral pilot operation; only the runtime's verified callback may feed it. */
export class TeamsCallOperations {
  private attempt: Attempt | undefined;
  constructor(private readonly now: () => number = Date.now) {}

  register(callId: string, clientContext: string, lifetimeMs: number, botClientId: string) {
    if (this.active() || !identifier.safeParse(callId).success ||
        !z.string().uuid().safeParse(clientContext).success || !z.string().uuid().safeParse(botClientId).success ||
        !Number.isInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 120000) {
      throw new IntegrationError("configuration-failure");
    }
    const attempt: Attempt = {
      callId, clientContext, botClientId: botClientId.toLowerCase(), expiresAt: this.now() + lifetimeMs, pending: [],
    };
    this.attempt = attempt;
    return {
      bind: (operation: Operation) => {
        if (this.active() !== attempt || !sameId(operation.clientContext, clientContext) || promptOperationFailed(operation)) {
          throw new IntegrationError("read-failure");
        }
        attempt.operationId = operation.id;
        for (const observation of attempt.pending) this.apply(attempt, observation);
        attempt.pending = [];
      },
      observation: () => this.active() === attempt ? attempt.latest : undefined,
      dispose: () => { if (this.attempt === attempt) this.attempt = undefined; },
    };
  }

  accept(notification: unknown, identity: CallingIdentity): void {
    const attempt = this.active();
    const envelope = z.object({ value: z.array(z.unknown()).max(100) }).safeParse(notification);
    if (!attempt || !envelope.success || identity.botClientId.toLowerCase() !== attempt.botClientId) return;
    for (const raw of envelope.data.value) {
      const parsed = notificationSchema.safeParse(raw);
      if (!parsed.success) continue;
      const data = parsed.data.resourceData;
      const resource = operationResource(parsed.data.resourceUrl);
      const dataResource = operationResource(data["@odata.id"]);
      if (!resource || !dataResource || !sameId(resource.callId, attempt.callId) ||
          !sameId(resource.callId, dataResource.callId) || !sameId(resource.operationId, dataResource.operationId) ||
          (data.id !== undefined && !sameId(data.id, resource.operationId)) ||
          !sameId(data.clientContext, attempt.clientContext)) continue;
      const observation: Operation = { ...data, id: resource.operationId };
      if (attempt.operationId) this.apply(attempt, observation);
      else if (attempt.pending.length < 4) attempt.pending.push(observation);
    }
  }

  shutdown(): void { this.attempt = undefined; }

  private active(): Attempt | undefined {
    if (this.attempt && this.now() >= this.attempt.expiresAt) this.attempt = undefined;
    return this.attempt;
  }

  private apply(attempt: Attempt, observation: Operation): void {
    if (!attempt.operationId || !sameId(attempt.operationId, observation.id) ||
        ["completed", "failed"].includes(attempt.latest?.status ?? "")) return;
    attempt.latest = observation;
  }
}
