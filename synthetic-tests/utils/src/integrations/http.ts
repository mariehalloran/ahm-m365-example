import type { TokenCredential } from "@azure/identity";
import { setTimeout as delay } from "node:timers/promises";
import { httpResponseDiagnosticsSchema, type DiagnosticCategory, type HttpResponseDiagnostics } from "../contracts.js";

export class IntegrationError extends Error {
  // `detail` is a short, value-free hint (field paths, never content) for operators reading failure events.
  constructor(
    public readonly category: DiagnosticCategory, public readonly status?: number, public readonly detail?: string,
    public readonly response?: HttpResponseDiagnostics,
  ) {
    super(category);
    this.name = "IntegrationError";
  }
}

export function categoryOf(error: unknown): DiagnosticCategory {
  if (error instanceof IntegrationError) return error.category;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "cancelled";
  return "collector-failure";
}

export interface HttpOptions {
  fetch?: typeof fetch;
  attempts?: number;
  timeoutMs?: number;
  maxRetryDelayMs?: number;
  retryThrottledWrites?: boolean;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  withRequestPermit?: (signal: AbortSignal, operation: () => Promise<Response>) => Promise<Response>;
  onResponse?: (diagnostics: HttpResponseDiagnostics) => void;
}

export async function withAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation(), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

function retryDelayMs(headers: Headers | undefined, attempt: number): number {
  const header = headers?.get("retry-after") ?? null;
  const seconds = header === null ? NaN : Number(header);
  const wait = Number.isFinite(seconds) ? seconds * 1000
    : header && Number.isFinite(Date.parse(header)) ? Date.parse(header) - Date.now() : 250 * 2 ** attempt;
  return Math.max(0, wait);
}

/** Retains only allowlisted response metadata, never arbitrary headers or response messages. */
function responseDiagnostics(response: Response): HttpResponseDiagnostics {
  const requestId = httpResponseDiagnosticsSchema.shape.requestId.safeParse(
    response.headers.get("request-id") ?? response.headers.get("x-ms-request-id") ?? undefined,
  );
  const code = httpResponseDiagnosticsSchema.shape.serviceErrorCode.safeParse(response.headers.get("x-ms-error-code") ?? undefined);
  const retryAfter = response.headers.get("retry-after");
  const retryDate = retryAfter && retryAfter.length <= 128 ? Date.parse(retryAfter) : NaN;
  return {
    httpStatus: response.status,
    ...(requestId.success && requestId.data ? { requestId: requestId.data } : {}),
    ...(code.success && code.data ? { serviceErrorCode: code.data } : {}),
    ...(retryAfter && /^\d{1,10}$/.test(retryAfter) ? { retryAfter }
      : Number.isFinite(retryDate) ? { retryAfter: new Date(retryDate).toUTCString() } : {}),
  };
}

/** Reads only bounded error codes and request IDs after the raw response has already been observed. */
async function readErrorDiagnostics(response: Response, diagnostics: HttpResponseDiagnostics, signal: AbortSignal): Promise<void> {
  try {
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      await withAbort(signal, async () => { await response.body?.cancel(); });
      return;
    }
    const raw: unknown = JSON.parse((await readResponseBody(response, 16384, signal, "malformed-response")).toString("utf8"));
    if (!raw || typeof raw !== "object" || !("error" in raw) || !raw.error || typeof raw.error !== "object") return;
    const error = raw.error;
    const code = httpResponseDiagnosticsSchema.shape.serviceErrorCode.safeParse("code" in error ? error.code : undefined);
    if (code.success && code.data) diagnostics.serviceErrorCode = code.data;
    const inner = "innerError" in error ? error.innerError : "innererror" in error ? error.innererror : undefined;
    if (!diagnostics.requestId && inner && typeof inner === "object" && "request-id" in inner) {
      const requestId = httpResponseDiagnosticsSchema.shape.requestId.safeParse(inner["request-id"]);
      if (requestId.success && requestId.data) diagnostics.requestId = requestId.data;
    }
  } catch {
    // A broken error body must not replace the status already received; caller cancellation still wins.
    signal.throwIfAborted();
  }
}

/** Preserves a received HTTP failure even if its body or request-permit cleanup subsequently fails. */
function responseError(diagnostics: HttpResponseDiagnostics): IntegrationError {
  const status = diagnostics.httpStatus;
  return new IntegrationError(
    status === 401 ? "authentication-failure" :
    status === 403 ? "permission-failure" :
    status === 429 ? "graph-throttling" : "graph-unavailable",
    status, undefined, diagnostics,
  );
}

export async function requestWithRetry(
  url: RequestInfo | URL, init: RequestInit, signal: AbortSignal, retrySafe = true, options: HttpOptions = {},
): Promise<Response> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 15000)]);
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const attempts = retrySafe || options.retryThrottledWrites ? options.attempts ?? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    let received: HttpResponseDiagnostics | undefined;
    try {
      const send = async () => {
        const raw = await fetcher(url, { ...init, signal: bounded });
        received = responseDiagnostics(raw);
        options.onResponse?.(received);
        return raw;
      };
      response = await withAbort(bounded, () => options.withRequestPermit
        ? options.withRequestPermit(bounded, send) : send());
    } catch (error) {
      bounded.throwIfAborted();
      if (error instanceof IntegrationError) throw error;
      if (received) throw received.httpStatus >= 400 ? responseError(received) : new IntegrationError("cancelled");
      if (!retrySafe || attempt + 1 >= attempts) throw new IntegrationError("graph-unavailable");
      await withAbort(bounded, () => sleep(250 * 2 ** attempt, bounded));
      continue;
    }
    // Completed writes can carry resource IDs needed for cleanup after cancellation.
    if (response.ok || response.status === 404 || (init.redirect === "manual" && response.status === 302)) return response;
    const diagnostics = received ?? responseDiagnostics(response);
    await readErrorDiagnostics(response, diagnostics, bounded);
    if ((response.status === 429 || (retrySafe && [502, 503, 504].includes(response.status))) && attempt + 1 < attempts) {
      const wait = retryDelayMs(response.headers, attempt);
      if (wait <= (options.maxRetryDelayMs ?? 10000)) {
        await withAbort(bounded, () => sleep(wait, bounded));
        continue;
      }
    }
    throw responseError(diagnostics);
  }
  throw new IntegrationError("collector-failure");
}

export async function readResponseBody(
  response: Response, maxBytes: number, signal: AbortSignal, category: "malformed-response" | "read-failure",
): Promise<Buffer> {
  if (!response.body) throw new IntegrationError(category);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let finished = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new IntegrationError(category);
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) { finished = true; break; }
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new IntegrationError(category, undefined, "response-too-large");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

export class AuthenticatedHttp {
  constructor(private readonly credential: TokenCredential, private readonly scope: string, private readonly options: HttpOptions = {}) {}

  async token(signal: AbortSignal): Promise<string> {
    try {
      const token = await withAbort(signal, () => this.credential.getToken(this.scope, { abortSignal: signal }));
      if (!token) throw new IntegrationError("authentication-failure");
      return token.token;
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError("authentication-failure");
    }
  }

  async request(url: string, init: RequestInit, signal: AbortSignal, retrySafe = true): Promise<Response> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 15000)]);
    const token = await this.token(bounded);
    return requestWithRetry(url, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${token}` },
    }, bounded, retrySafe, this.options);
  }
}
