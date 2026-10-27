import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigurationError } from "../../utils/src/config.js";
import { IntegrationError } from "../../utils/src/http.js";
import { playPromptOperationSchema, promptOperationFailed, type TeamsCallOperations } from "../../utils/src/teams-call-operations.js";
import type { ConnectedTeamsCall } from "./call.js";

const maxAudioBytes = 512 * 1024;
const nonpublic = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) nonpublic.addSubnet(network, prefix, "ipv4");

export function approvedAudioUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ConfigurationError("Audio requires an explicitly approved public HTTPS WAV URL"); }
  if (value !== value.trim() || url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.port || !/\.wav$/i.test(url.pathname) || !url.hostname.includes(".")) {
    throw new ConfigurationError("Audio requires an explicitly approved public HTTPS WAV URL without credentials, fragment or custom port");
  }
  return url;
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) return !nonpublic.check(address, "ipv4");
  // Require global unicast IPv6; mapped IPv4 and local/link-local addresses are excluded.
  return isIP(address) === 6 && /^[23][\da-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
}

function wavDuration(audio: Buffer): number {
  const invalid = () => new ConfigurationError("Audio must be a complete PCM WAV: mono, 16-bit, 16 kHz, at most ten seconds");
  if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" ||
      audio.toString("ascii", 8, 12) !== "WAVE" || audio.readUInt32LE(4) !== audio.length - 8) throw invalid();
  let validFormat = false;
  let dataBytes = 0;
  for (let offset = 12; offset < audio.length;) {
    if (offset + 8 > audio.length) throw invalid();
    const type = audio.toString("ascii", offset, offset + 4);
    const length = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length + (length % 2) > audio.length) throw invalid();
    if (type === "fmt ") {
      if (validFormat || length < 16 || audio.readUInt16LE(start) !== 1 || audio.readUInt16LE(start + 2) !== 1 ||
          audio.readUInt32LE(start + 4) !== 16000 || audio.readUInt32LE(start + 8) !== 32000 ||
          audio.readUInt16LE(start + 12) !== 2 || audio.readUInt16LE(start + 14) !== 16) throw invalid();
      validFormat = true;
    } else if (type === "data") {
      if (!validFormat || dataBytes || length === 0 || length % 2) throw invalid();
      dataBytes = length;
    }
    offset = start + length + (length % 2);
  }
  const durationMs = dataBytes / 32;
  if (!validFormat || !dataBytes || durationMs > 10000) throw invalid();
  return durationMs;
}

export interface ApprovedHostedAudio {
  url: string;
  durationMs: number;
  sha256: string;
}

export async function validateHostedAudio(
  value: string, signal: AbortSignal,
  options: {
    fetch?: typeof fetch;
    resolveHost?: (hostname: string) => Promise<readonly { address: string }[]>;
  } = {},
): Promise<ApprovedHostedAudio> {
  const url = approvedAudioUrl(value);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  const resolve = options.resolveHost ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  let onAbort: (() => void) | undefined;
  try {
    bounded.throwIfAborted();
    const addresses = await Promise.race([
      resolve(url.hostname),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(bounded.reason);
        bounded.addEventListener("abort", onAbort, { once: true });
        if (bounded.aborted) onAbort();
      }),
    ]);
    if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) {
      throw new ConfigurationError("Audio URL must resolve only to public internet addresses");
    }
    const response = await (options.fetch ?? fetch)(url, { method: "GET", signal: bounded, redirect: "error" });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new IntegrationError("read-failure", response.status);
    }
    const declaredBytes = response.headers.get("content-length");
    if (declaredBytes !== null && (!/^\d+$/.test(declaredBytes) || Number(declaredBytes) > maxAudioBytes)) {
      await response.body.cancel();
      throw new IntegrationError("malformed-response");
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        bounded.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxAudioBytes) {
          await reader.cancel();
          throw new IntegrationError("malformed-response");
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    bounded.throwIfAborted();
    const audio = Buffer.concat(chunks);
    return { url: url.href, durationMs: wavDuration(audio), sha256: createHash("sha256").update(audio).digest("hex") };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ConfigurationError || error instanceof IntegrationError) throw error;
    // Fetch/DNS errors can contain signed URL query strings; never propagate their messages.
    throw new IntegrationError(bounded.aborted ? "delivery-timeout" : "read-failure");
  } finally { if (onAbort) bounded.removeEventListener("abort", onAbort); }
}

export async function playHostedAudio(
  call: ConnectedTeamsCall, audio: ApprovedHostedAudio, operations: TeamsCallOperations, botClientId: string,
  timeoutMs: number, now: () => number = Date.now,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = async (ms, signal) => { await delay(ms, undefined, { signal }); },
): Promise<string> {
  const deadline = Math.min(call.deadline - 1000, now() + timeoutMs);
  const remaining = Math.floor(deadline - now());
  if (remaining <= audio.durationMs) throw new IntegrationError("delivery-timeout");
  const signal = AbortSignal.any([call.signal, AbortSignal.timeout(remaining)]);
  const clientContext = randomUUID();
  const attempt = operations.register(call.primary.id, clientContext, remaining, botClientId);
  try {
    await call.verifyConnected(signal);
    signal.throwIfAborted();
    const operation = await call.primary.graph.json(
      `/communications/calls/${encodeURIComponent(call.primary.id)}/playPrompt`,
      playPromptOperationSchema, signal, "POST", {
        clientContext,
        prompts: [{
          "@odata.type": "#microsoft.graph.mediaPrompt",
          mediaInfo: { "@odata.type": "#microsoft.graph.mediaInfo", uri: audio.url, resourceId: randomUUID() },
        }],
      }, false, "v1.0", 16384,
    );
    attempt.bind(operation);
    // HTTP acceptance (even Completed in the response) cannot replace an authenticated, correlated callback.
    while (now() < deadline) {
      signal.throwIfAborted();
      await call.verifyConnected(signal);
      signal.throwIfAborted();
      const observed = attempt.observation();
      if (observed && promptOperationFailed(observed)) throw new IntegrationError("read-failure");
      if (observed?.status === "completed") return operation.id;
      await sleep(Math.min(250, Math.max(0, deadline - now())), signal);
    }
    throw new IntegrationError("delivery-timeout");
  } finally { attempt.dispose(); }
}
