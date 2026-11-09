import { BlobServiceClient, type BlockBlobClient, type ContainerClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import { z } from "zod";
import { dispatchRunId, laneInstanceId, type LaneDispatch } from "./dispatch.js";

export const laneRecordSchema = z.object({
  dispatch: z.object({
    tenant: z.string(), service: z.string(), lane: z.string(), slot: z.number(),
    configSha256: z.string(), attemptId: z.string(),
    journey: z.string().optional(),
    provider: z.boolean().optional(),
    probeType: z.string().optional(),
    testId: z.string().optional(),
  }),
  runId: z.string().uuid(),
  phase: z.enum(["starting", "accepted", "running", "completed", "failed", "ambiguous"]),
  updatedAt: z.string().datetime(),
  lastExecutionStartedAt: z.string().datetime().optional(),
  lastPublicationAt: z.string().datetime().optional(),
});
export type LaneRecord = z.infer<typeof laneRecordSchema>;
export class LaneConflictError extends Error {
  constructor(message: string) { super(message); this.name = "LaneConflictError"; }
}
export interface LaneOwnership {
  accept(dispatch: LaneDispatch, start: () => Promise<void>): Promise<{ runId: string; duplicate: boolean }>;
  claim(dispatch: LaneDispatch): Promise<"execute" | "completed">;
  finish(dispatch: LaneDispatch, phase: "completed" | "failed" | "ambiguous"): Promise<void>;
}

/** Recognizes only expected Blob concurrency responses; all authentication/storage failures surface. */
function status(error: unknown, expected: number): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === expected;
}

/** Refuses overlap or replay of an uncertain mutation, including after a Function process disappears. */
function validateLaneStart(previous: LaneRecord | undefined, dispatch: LaneDispatch): "new" | "duplicate" {
  if (!previous) return "new";
  if (dispatch.slot < previous.dispatch.slot) throw new LaneConflictError("An older schedule slot cannot be replayed");
  if (dispatch.slot === previous.dispatch.slot) {
    if (dispatch.configSha256 !== previous.dispatch.configSha256) throw new LaneConflictError("The slot is already owned by another configuration");
    if (previous.phase === "starting") throw new LaneConflictError("Durable acceptance is uncertain; reconcile the lane before retrying");
    return "duplicate";
  }
  if (["starting", "accepted", "running", "ambiguous"].includes(previous.phase)) {
    throw new LaneConflictError("The previous lane has unconfirmed ownership; operator reconciliation is required before another slot");
  }
  return "new";
}

/** Uses a leased lane journal plus conditional writes to fence Durable's at-least-once activity delivery. */
class BlobLaneOwnership implements LaneOwnership {
  constructor(private readonly container: ContainerClient) {}

  /** Reads a bounded journal with its concurrency token. */
  private async read(blob: BlockBlobClient, leaseId?: string) {
    try {
      const response = await blob.download(0, undefined, {
        abortSignal: AbortSignal.timeout(10000), ...(leaseId ? { conditions: { leaseId } } : {}),
      });
      if ((response.contentLength ?? 0) > 16384) throw new Error("Lane journal exceeds its storage limit");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.readableStreamBody!) {
        size += Buffer.byteLength(chunk);
        if (size > 16384) throw new Error("Lane journal exceeds its storage limit");
        chunks.push(Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString("utf8");
      return { record: text === "{}" ? undefined : laneRecordSchema.parse(JSON.parse(text)), etag: response.etag! };
    } catch (error) {
      if (status(error, 404)) return undefined;
      throw error;
    }
  }

  /** Serializes start acceptance without depending on any particular Function host instance. */
  async accept(dispatch: LaneDispatch, start: () => Promise<void>) {
    const blob = this.container.getBlockBlobClient(`lanes/${laneInstanceId(dispatch)}.json`);
    const lock = this.container.getBlockBlobClient(`locks/${laneInstanceId(dispatch)}`);
    try { await lock.upload("{}", 2, { conditions: { ifNoneMatch: "*" }, abortSignal: AbortSignal.timeout(10000) }); }
    catch (error) { if (!status(error, 409) && !status(error, 412)) throw error; }
    const lease = lock.getBlobLeaseClient();
    try { await lease.acquireLease(60, { abortSignal: AbortSignal.timeout(10000) }); }
    catch (error) {
      if (status(error, 409)) throw new LaneConflictError("Another starter owns this lane");
      throw error;
    }
    try {
      const current = await this.read(blob);
      const decision = validateLaneStart(current?.record, dispatch);
      if (decision === "duplicate") return { runId: current!.record!.runId, duplicate: true };
      const record: LaneRecord = {
        dispatch, runId: dispatchRunId(dispatch), phase: "starting", updatedAt: new Date().toISOString(),
        ...(current?.record?.lastExecutionStartedAt ? { lastExecutionStartedAt: current.record.lastExecutionStartedAt } : {}),
        ...(current?.record?.lastPublicationAt ? { lastPublicationAt: current.record.lastPublicationAt } : {}),
      };
      const text = JSON.stringify(record);
      await blob.upload(text, Buffer.byteLength(text), {
        conditions: current ? { ifMatch: current.etag } : { ifNoneMatch: "*" }, abortSignal: AbortSignal.timeout(10000),
      });
      // An ambiguous start failure deliberately keeps "accepted": never blindly repeat a mailbox mutation.
      await start();
      const accepted = await this.read(blob);
      if (accepted?.record?.phase === "starting") {
        const acceptedText = JSON.stringify({ ...accepted.record, phase: "accepted", updatedAt: new Date().toISOString() });
        try {
          await blob.upload(acceptedText, Buffer.byteLength(acceptedText), {
            conditions: { ifMatch: accepted.etag }, abortSignal: AbortSignal.timeout(10000),
          });
        } catch (error) {
          const claimed = status(error, 412) ? await this.read(blob) : undefined;
          if (!claimed?.record || claimed.record.runId !== record.runId || claimed.record.phase === "starting") throw error;
        }
      }
      return { runId: record.runId, duplicate: false };
    } finally { await lease.releaseLease({ abortSignal: AbortSignal.timeout(10000) }); }
  }

  /** Claims an accepted attempt once; a redelivery after an unacknowledged host failure cannot mutate. */
  async claim(dispatch: LaneDispatch): Promise<"execute" | "completed"> {
    const blob = this.container.getBlockBlobClient(`lanes/${laneInstanceId(dispatch)}.json`);
    const runId = dispatchRunId(dispatch);
    let current = await this.read(blob);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!current?.record || current.record.runId !== runId ||
          current.record.dispatch.attemptId !== dispatch.attemptId) throw new LaneConflictError("Activity does not own the accepted dispatch");
      if (current.record.phase === "completed") return "completed";
      if (!["starting", "accepted"].includes(current.record.phase)) throw new LaneConflictError("Activity delivery is duplicate or its previous execution is ambiguous");
      const text = JSON.stringify({
        ...current.record, phase: "running", updatedAt: new Date().toISOString(), lastExecutionStartedAt: new Date().toISOString(),
      });
      try {
        await blob.upload(text, Buffer.byteLength(text), { conditions: { ifMatch: current.etag }, abortSignal: AbortSignal.timeout(10000) });
        return "execute";
      } catch (error) {
        // startNew can wake this activity before the starter finishes recording acceptance.
        if (status(error, 412) && attempt === 0 && current.record.phase === "starting") {
          const accepted = await this.read(blob);
          if (accepted?.record?.runId === runId && accepted.record.dispatch.attemptId === dispatch.attemptId &&
              accepted.record.phase === "accepted") {
            current = accepted;
            continue;
          }
        }
        if (status(error, 409) || status(error, 412)) throw new LaneConflictError("Another delivery already owns the activity");
        throw error;
      }
    }
    throw new LaneConflictError("Activity ownership did not settle");
  }

  /** Releases a settled execution, but leaves uncertain in-flight operations permanently fenced. */
  async finish(dispatch: LaneDispatch, phase: "completed" | "failed" | "ambiguous"): Promise<void> {
    const blob = this.container.getBlockBlobClient(`lanes/${laneInstanceId(dispatch)}.json`);
    const current = await this.read(blob);
    if (!current?.record || current.record.runId !== dispatchRunId(dispatch) || current.record.phase !== "running") {
      throw new LaneConflictError("Execution ownership changed before completion");
    }
    const text = JSON.stringify({
      ...current.record, phase, updatedAt: new Date().toISOString(),
      ...(phase === "completed" ? { lastPublicationAt: new Date().toISOString() } : {}),
    });
    await blob.upload(text, Buffer.byteLength(text), { conditions: { ifMatch: current.etag }, abortSignal: AbortSignal.timeout(10000) });
  }
}

/** Binds execution state only to the explicitly selected host managed identity. */
export function createLaneOwnership(env: NodeJS.ProcessEnv): LaneOwnership {
  const settings = z.object({
    FUNCTION_STORAGE_ACCOUNT: z.string().regex(/^[a-z0-9]{3,24}$/),
    AZURE_CLIENT_ID: z.string().uuid(),
  }).parse(env);
  return new BlobLaneOwnership(new BlobServiceClient(
    `https://${settings.FUNCTION_STORAGE_ACCOUNT}.blob.core.windows.net`,
    new ManagedIdentityCredential({ clientId: settings.AZURE_CLIENT_ID }),
  ).getContainerClient("execution-state"));
}
