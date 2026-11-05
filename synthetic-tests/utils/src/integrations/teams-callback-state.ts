import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import { z } from "zod";
import type { ProjectConfig } from "../configuration/project-config.js";
import { ConfigurationError } from "../configuration/config.js";
import { IntegrationError } from "./http.js";

const uuid = z.string().uuid();
const callId = z.string().min(1).max(2048).refine(value => !/[\u0000-\u001f\u007f/\\?#]/.test(value));
const callObservation = z.object({
  id: callId, state: z.string().min(1).max(64).optional(),
  callChainId: uuid.optional(),
  resultInfo: z.object({ code: z.number().int().optional(), subcode: z.number().int().optional() }).optional(),
  receivedAt: z.string().datetime(),
});
const callbackRecord = z.object({
  runId: uuid, attemptId: uuid, configSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int(), closed: z.boolean(),
  bots: z.record(uuid, z.object({ callId: callId.optional(), latest: callObservation.optional() })),
}).strict();
export type TeamsCallbackRecord = z.infer<typeof callbackRecord>;
export interface TeamsCallState {
  register(attemptId: string, bots: readonly string[], signal: AbortSignal): Promise<void>;
  callbackUrl(attemptId: string, botClientId: string): string;
  bind(attemptId: string, botClientId: string, callId: string, signal: AbortSignal): Promise<void>;
  close(attemptId: string, signal: AbortSignal): Promise<void>;
}

/** Recognizes expected optimistic concurrency/missing-record responses only. */
function hasStatus(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === code;
}

/** Stores bounded, value-free callback evidence beside the durable lane journal, never in host memory. */
export class TeamsCallbackStore {
  constructor(private readonly container: ContainerClient) {}

  /** Loads one owned callback attempt with the ETag required for cross-host updates. */
  private async read(runId: string, attemptId: string, signal: AbortSignal) {
    uuid.parse(runId);
    uuid.parse(attemptId);
    const blob = this.container.getBlockBlobClient(`calls/${runId}/${attemptId}.json`);
    const properties = await blob.getProperties({ abortSignal: signal });
    if ((properties.contentLength ?? 0) > 32768) throw new Error("Calling state exceeds its storage limit");
    // Read under a matching ETag: never attach a newer write token to older bytes.
    const current = await blob.downloadToBuffer(0, properties.contentLength, { conditions: { ifMatch: properties.etag! }, abortSignal: signal });
    return { blob, record: callbackRecord.parse(JSON.parse(current.toString("utf8"))), etag: properties.etag! };
  }

  /** Creates an immutable owner binding before either bot posts a call mutation. */
  async register(record: TeamsCallbackRecord, signal: AbortSignal): Promise<void> {
    const parsed = callbackRecord.parse(record);
    const text = JSON.stringify(parsed);
    await this.container.getBlockBlobClient(`calls/${parsed.runId}/${parsed.attemptId}.json`).upload(text, Buffer.byteLength(text), {
      abortSignal: signal, conditions: { ifNoneMatch: "*" },
    });
  }

  /** Retries only explicit ETag contention; storage and authentication failures are never hidden. */
  async update(
    runId: string, attemptId: string, signal: AbortSignal,
    change: (record: TeamsCallbackRecord) => TeamsCallbackRecord,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      signal.throwIfAborted();
      try {
        const { blob, record, etag } = await this.read(runId, attemptId, signal);
        const text = JSON.stringify(callbackRecord.parse(change(record)));
        await blob.upload(text, Buffer.byteLength(text), { abortSignal: signal, conditions: { ifMatch: etag } });
        return;
      } catch (error) {
        if (!hasStatus(error, 412) || attempt === 7) throw error;
      }
    }
  }

  /** Accepts only a verified bot's bounded call-state notifications for its registered, unexpired attempt. */
  async accept(
    runId: string, attemptId: string, botClientId: string, raw: unknown, signal: AbortSignal,
  ): Promise<void> {
    uuid.parse(botClientId);
    const envelope = z.object({ value: z.array(z.object({
      resourceUrl: z.string().max(8192),
      resourceData: z.object({
        id: callId.optional(), state: z.string().min(1).max(64).optional(),
        callChainId: uuid.nullish(),
        resultInfo: z.object({ code: z.number().int().nullish(), subcode: z.number().int().nullish() }).nullish(),
      }),
    })).min(1).max(100) }).parse(raw);
    const receivedAt = new Date().toISOString();
    const observations = envelope.value.flatMap(value => {
      const match = /^(?:https:\/\/graph\.microsoft\.com\/v1\.0)?\/communications\/calls\/([^/?]+)$/.exec(value.resourceUrl);
      if (!match) return [];
      let id: string;
      try { id = decodeURIComponent(match[1]!); }
      catch { return []; }
      if (!callId.safeParse(id).success || value.resourceData.id !== undefined && value.resourceData.id !== id) return [];
      const data = value.resourceData;
      return [{
        id, receivedAt, ...(data.state ? { state: data.state } : {}),
        ...(data.callChainId ? { callChainId: data.callChainId } : {}),
        ...(data.resultInfo ? { resultInfo: {
          ...(data.resultInfo.code == null ? {} : { code: data.resultInfo.code }),
          ...(data.resultInfo.subcode == null ? {} : { subcode: data.resultInfo.subcode }),
        } } : {}),
      }];
    });
    if (!observations.length) throw new Error("Notification contains no supported call-state evidence");
    if (new Set(observations.map(observation => observation.id)).size !== 1) throw new Error("A bot attempt cannot accept notifications for several calls");
    await this.update(runId, attemptId, signal, record => {
      const bot = record.bots[botClientId.toLowerCase()];
      if (record.expiresAt <= Date.now() || record.closed || !bot) throw new Error("Calling attempt is expired or does not own this bot");
      for (const observation of observations) {
        if (bot.callId && bot.callId !== observation.id) throw new Error("Notification does not match the owned call");
        bot.latest = observation;
      }
      return record;
    });
  }
}

/** Creates the shared callback store with an explicit managed identity, never a connection string. */
export function callbackStore(account: string, clientId: string): TeamsCallbackStore {
  z.string().regex(/^[a-z0-9]{3,24}$/).parse(account);
  uuid.parse(clientId);
  return new TeamsCallbackStore(new BlobServiceClient(
    `https://${account}.blob.core.windows.net`, new ManagedIdentityCredential({ clientId }),
  ).getContainerClient("execution-state"));
}

/** Supplies per-journey ownership and dynamic callback routes to live two-bot meeting handlers. */
export function createTeamsCallbackState(
  project: ProjectConfig, env: NodeJS.ProcessEnv, runId: string, expiresAt: number,
  onFailure: (error: unknown) => void,
): TeamsCallState {
  const settings = project.deployment?.functions;
  const identity = uuid.safeParse(env.AZURE_CLIENT_ID);
  const configSha256 = env.MONITORING_CONFIG_SHA256;
  const base = project.services.teams.execution.teamsCallingCallbackUrl;
  if (!settings || !identity.success || !configSha256 || !base) {
    throw new ConfigurationError("Teams calling needs the deployed Function callback and explicit shared-state identity/configuration");
  }
  const store = callbackStore(settings.storageAccount, identity.data);
  /** Keeps monitoring-state failures Unknown and separately surfaces the pipeline exception. */
  async function guarded(operation: () => Promise<void>): Promise<void> {
    try { await operation(); }
    catch (error) {
      onFailure(error);
      throw new IntegrationError("cancelled", undefined, "shared-calling-state-unavailable");
    }
  }
  return {
    register: (attemptId, bots, signal) => guarded(() => store.register({
      runId, attemptId, configSha256, expiresAt, closed: false,
      bots: Object.fromEntries(bots.map(bot => [bot.toLowerCase(), {}])),
    }, signal)),
    callbackUrl: (attemptId, botClientId) => `${base}/${runId}/${attemptId}/${botClientId.toLowerCase()}`,
    bind: (attemptId, botClientId, id, signal) => guarded(() => store.update(runId, attemptId, signal, record => {
      const bot = record.bots[botClientId.toLowerCase()];
      if (!bot || bot.callId && bot.callId !== id) throw new Error("Call does not match its bot owner");
      if (bot.latest?.id !== id) delete bot.latest;
      bot.callId = id;
      return record;
    })),
    close: (attemptId, signal) => guarded(() => store.update(runId, attemptId, signal, record => ({ ...record, closed: true }))),
  };
}
