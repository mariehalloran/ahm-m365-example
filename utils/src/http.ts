import type { TokenCredential } from "@azure/identity";
import { setTimeout as delay } from "node:timers/promises";
import type { DiagnosticCategory } from "./contracts.js";

export class IntegrationError extends Error {
  constructor(public readonly category: DiagnosticCategory, public readonly status?: number) {
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
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class AuthenticatedHttp {
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(private readonly credential: TokenCredential, private readonly scope: string, private readonly options: HttpOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }

  async token(signal: AbortSignal): Promise<string> {
    try {
      const token = await this.credential.getToken(this.scope, { abortSignal: signal });
      if (!token) throw new IntegrationError("authentication-failure");
      return token.token;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new IntegrationError("authentication-failure");
    }
  }

  async request(url: string, init: RequestInit, signal: AbortSignal, retrySafe = true): Promise<Response> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 15000)]);
    const token = await this.token(bounded);
    const attempts = retrySafe ? this.options.attempts ?? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          ...init,
          signal: bounded,
          headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${token}` },
        });
      } catch (error) {
        if (bounded.aborted) throw error;
        if (attempt + 1 >= attempts) throw new IntegrationError("graph-unavailable");
        await this.sleep(250 * 2 ** attempt, bounded);
        continue;
      }
      if (response.ok || response.status === 404 || (init.redirect === "manual" && response.status === 302)) return response;
      if ([429, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
        const header = response.headers.get("retry-after");
        const retryAfter = header === null ? NaN : Number(header);
        const wait = Number.isFinite(retryAfter) ? retryAfter * 1000
          : header && Number.isFinite(Date.parse(header)) ? Date.parse(header) - Date.now() : 250 * 2 ** attempt;
        await response.body?.cancel();
        if (wait > 10000) throw new IntegrationError(response.status === 429 ? "graph-throttling" : "graph-unavailable", response.status);
        await this.sleep(Math.max(0, wait), bounded);
        continue;
      }
      await response.body?.cancel();
      throw new IntegrationError(
        response.status === 401 ? "authentication-failure" :
        response.status === 403 ? "permission-failure" :
        response.status === 429 ? "graph-throttling" : "graph-unavailable",
        response.status,
      );
    }
    throw new IntegrationError("collector-failure");
  }
}
