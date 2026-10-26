import { z } from "zod";
import { IntegrationError } from "./http.js";
import type { CallingIdentity } from "./teams-calling-auth.js";

const identifier = z.string().min(1).max(2048).refine(value =>
  value.trim() === value && !/[\u0000-\u001f\u007f/\\?#]/.test(value) && ![".", ".."].includes(value));
export const playPromptOperationSchema = z.object({
  "@odata.type": z.literal("#microsoft.graph.playPromptOperation"),
  id: identifier,
  clientContext: z.string().uuid(),
  status: z.enum(["notStarted", "running", "completed", "failed"]),
  resultInfo: z.object({ code: z.number().int().optional(), subcode: z.number().int().optional() }).nullish(),
});
type Operation = z.infer<typeof playPromptOperationSchema>;
type Observation = Omit<Operation, "id"> & { id: string; callId: string };
interface Entry {
  callId: string;
  botClientId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  operationId?: string;
  pending: Observation[];
  latest?: Operation;
}

// Graph's documented callback example uses uppercase, unhyphenated GUIDs in resource paths.
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

const notificationSchema = z.object({
  changeType: z.enum(["updated", "deleted"]),
  resourceUrl: z.string().max(8192),
  resourceData: playPromptOperationSchema.omit({ id: true }).extend({
    id: identifier.optional(), "@odata.id": z.string().max(8192),
  }),
});

export class TeamsCallOperations {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}

  register(callId: string, clientContext: string, lifetimeMs: number, botClientId: string) {
    this.prune();
    if (!identifier.safeParse(callId).success || !z.string().uuid().safeParse(clientContext).success ||
        !z.string().uuid().safeParse(botClientId).success ||
        !Number.isInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 120000 ||
        this.entries.has(clientContext) || this.entries.size >= 32) throw new IntegrationError("configuration-failure");
    const timer = setTimeout(() => this.remove(clientContext), lifetimeMs);
    timer.unref();
    const entry: Entry = { callId, botClientId: botClientId.toLowerCase(), expiresAt: this.now() + lifetimeMs, timer, pending: [] };
    this.entries.set(clientContext, entry);
    return {
      bind: (operation: Operation) => {
        if (!this.active(clientContext) || operation.clientContext !== clientContext ||
            !identifier.safeParse(operation.id).success) throw new IntegrationError("read-failure");
        if (operation.status === "failed" || (operation.resultInfo?.code !== undefined && operation.resultInfo.code >= 400)) {
          throw new IntegrationError("read-failure");
        }
        entry.operationId = operation.id;
        for (const observation of entry.pending) this.apply(entry, observation);
        entry.pending = [];
      },
      observation: (): Operation | undefined => this.active(clientContext)?.latest,
      dispose: () => this.remove(clientContext),
    };
  }

  accept(notification: unknown, identity: CallingIdentity): void {
    const envelope = z.object({ value: z.array(z.unknown()).max(100) }).safeParse(notification);
    if (!envelope.success) return;
    this.prune();
    for (const raw of envelope.data.value) {
      const parsed = notificationSchema.safeParse(raw);
      if (!parsed.success) continue;
      const { resourceData: data, resourceUrl } = parsed.data;
      const resource = operationResource(resourceUrl);
      const dataResource = operationResource(data["@odata.id"]);
      if (!resource || !dataResource || !sameId(resource.callId, dataResource.callId) ||
          !sameId(resource.operationId, dataResource.operationId) ||
          (data.id !== undefined && !sameId(data.id, resource.operationId))) continue;
      const entry = this.active(data.clientContext);
      if (!entry || entry.botClientId !== identity.botClientId.toLowerCase() ||
          !sameId(entry.callId, resource.callId)) continue;
      const observation: Observation = { ...data, callId: resource.callId, id: resource.operationId };
      if (entry.operationId) this.apply(entry, observation);
      else if (entry.pending.length < 4) entry.pending.push(observation);
    }
  }

  shutdown(): void { for (const key of this.entries.keys()) this.remove(key); }

  private apply(entry: Entry, observation: Observation): void {
    if (!entry.operationId || !sameId(entry.operationId, observation.id) ||
        ["completed", "failed"].includes(entry.latest?.status ?? "")) return;
    entry.latest = observation;
  }

  private active(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.now()) { this.remove(key); return undefined; }
    return entry;
  }
  private prune(): void { for (const key of this.entries.keys()) this.active(key); }
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) clearTimeout(entry.timer);
    this.entries.delete(key);
  }
}
