import type { TokenCredential } from "@azure/identity";
import { setTimeout as delay } from "node:timers/promises";
import type { DiagnosticCategory } from "./contracts.js";

export class IntegrationError extends Error {
  // `detail` is a short, value-free hint (field paths, never content) for operators reading failure events.
  constructor(public readonly category: DiagnosticCategory, public readonly status?: number, public readonly detail?: string) {
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

export async function requestWithRetry(
  url: RequestInfo | URL, init: RequestInit, signal: AbortSignal, retrySafe = true, options: HttpOptions = {},
): Promise<Response> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 15000)]);
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const attempts = retrySafe || options.retryThrottledWrites ? options.attempts ?? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    try {
      response = await withAbort(bounded, () => fetcher(url, {
        ...init,
        signal: bounded,
      }));
    } catch {
      bounded.throwIfAborted();
      if (!retrySafe || attempt + 1 >= attempts) throw new IntegrationError("graph-unavailable");
      await withAbort(bounded, () => sleep(250 * 2 ** attempt, bounded));
      continue;
    }
    // Completed writes can carry resource IDs needed for cleanup after cancellation.
    if (response.ok || response.status === 404 || (init.redirect === "manual" && response.status === 302)) return response;
    await withAbort(bounded, async () => { await response.body?.cancel(); });
    if ((response.status === 429 || (retrySafe && [502, 503, 504].includes(response.status))) && attempt + 1 < attempts) {
      const wait = retryDelayMs(response.headers, attempt);
      if (wait <= (options.maxRetryDelayMs ?? 10000)) {
        await withAbort(bounded, () => sleep(wait, bounded));
        continue;
      }
    }
    throw new IntegrationError(
      response.status === 401 ? "authentication-failure" :
      response.status === 403 ? "permission-failure" :
      response.status === 429 ? "graph-throttling" : "graph-unavailable",
      response.status,
    );
  }
  throw new IntegrationError("collector-failure");
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
