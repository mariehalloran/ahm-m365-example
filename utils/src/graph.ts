import { z } from "zod";
import { AuthenticatedHttp, IntegrationError } from "./http.js";

export const graphBase = "https://graph.microsoft.com/v1.0";

export function graphNextPagePath(nextLink: string, collectionPath: string): string {
  let url: URL;
  try {
    url = new URL(nextLink);
  } catch {
    throw new IntegrationError("read-failure");
  }
  if (url.origin !== "https://graph.microsoft.com" ||
      url.pathname !== `/v1.0${collectionPath}` ||
      url.username || url.password || url.hash) {
    throw new IntegrationError("read-failure");
  }
  return `${collectionPath}${url.search}`;
}

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
    let url: URL;
    try {
      url = new URL(location);
    } catch {
      throw new IntegrationError("read-failure");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
        ![".sharepoint.com", ".sharepointonline.com"].some(suffix => url.hostname.endsWith(suffix))) {
      throw new IntegrationError("read-failure");
    }
    const download = await this.downloadFetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: "error" });
    if (!download.ok || !download.body) {
      throw new IntegrationError("read-failure");
    }
    const reader = download.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > 4096) {
          await reader.cancel();
          throw new IntegrationError("read-failure");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString("utf8");
    try { return JSON.parse(text); }
    catch { throw new IntegrationError("malformed-response"); }
  }
}
