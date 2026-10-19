import { z } from "zod";
import { AuthenticatedHttp, IntegrationError } from "./http.js";

export const graphBase = "https://graph.microsoft.com/v1.0";
export class GraphClient {
  constructor(private readonly http: AuthenticatedHttp, private readonly downloadFetch: typeof fetch = fetch) {}
  async authenticate(signal: AbortSignal): Promise<void> { await this.http.token(signal); }
  async request(path: string, signal: AbortSignal, method = "GET", body?: unknown, retrySafe = true): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new IntegrationError("collector-failure");
    const response = await this.http.request(`${graphBase}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Prefer: 'IdType="ImmutableId"' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, signal, retrySafe);
    if (response.status === 404 && method !== "DELETE") throw new IntegrationError("read-failure", 404);
    return response;
  }
  async json<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, method = "GET", body?: unknown, retrySafe = true): Promise<T> {
    const response = await this.request(path, signal, method, body, retrySafe);
    let raw: unknown;
    try { raw = await response.json(); }
    catch { throw new IntegrationError("malformed-response"); }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new IntegrationError("malformed-response");
    return parsed.data;
  }
  async downloadJson(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.http.request(`${graphBase}${path}`, { method: "GET", redirect: "manual" }, signal);
    const location = response.headers.get("location");
    if (response.status !== 302 || !location) throw new IntegrationError("read-failure");
    const url = new URL(location);
    if (url.protocol !== "https:" || ![".sharepoint.com", ".sharepointonline.com"].some(suffix => url.hostname.endsWith(suffix))) {
      throw new IntegrationError("read-failure");
    }
    const download = await this.downloadFetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: "error" });
    if (!download.ok || Number(download.headers.get("content-length") ?? 0) > 4096) throw new IntegrationError("read-failure");
    const text = await download.text();
    if (Buffer.byteLength(text) > 4096) throw new IntegrationError("read-failure");
    try { return JSON.parse(text); }
    catch { throw new IntegrationError("malformed-response"); }
  }
}
