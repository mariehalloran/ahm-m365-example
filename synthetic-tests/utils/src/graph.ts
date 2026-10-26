import { z } from "zod";
import { AuthenticatedHttp, IntegrationError } from "./http.js";

export const graphBase = "https://graph.microsoft.com/v1.0";
export type GraphApiVersion = "v1.0" | "beta";

export function graphNextPagePath(nextLink: string, collectionPath: string, version: GraphApiVersion = "v1.0"): string {
  let url: URL;
  try {
    url = new URL(nextLink);
  } catch {
    throw new IntegrationError("read-failure");
  }
  if (url.origin !== "https://graph.microsoft.com" ||
      url.pathname !== `/${version}${collectionPath}` ||
      url.username || url.password || url.hash) {
    throw new IntegrationError("read-failure");
  }
  return `${collectionPath}${url.search}`;
}

export class GraphClient {
  constructor(private readonly http: AuthenticatedHttp, private readonly downloadFetch: typeof fetch = fetch) {}
  async authenticate(signal: AbortSignal): Promise<void> { await this.http.token(signal); }
  async request(path: string, signal: AbortSignal, method = "GET", body?: unknown, retrySafe = true, version: GraphApiVersion = "v1.0"): Promise<Response> {
    if (!["v1.0", "beta"].includes(version) || !path.startsWith("/") || path.startsWith("//") ||
        path.includes("\\") || /[\r\n#]/.test(path)) throw new IntegrationError("collector-failure");
    const response = await this.http.request(`https://graph.microsoft.com/${version}${path}`, {
      method, redirect: "error",
      headers: { "Content-Type": "application/json", Prefer: 'IdType="ImmutableId"' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, signal, retrySafe);
    if (response.status === 404 && method !== "DELETE") throw new IntegrationError("read-failure", 404);
    return response;
  }
  async json<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, method = "GET", body?: unknown, retrySafe = true, version: GraphApiVersion = "v1.0", maxResponseBytes?: number): Promise<T> {
    const response = await this.request(path, signal, method, body, retrySafe, version);
    let raw: unknown;
    try {
      if (maxResponseBytes === undefined) raw = await response.json();
      else {
        if (!response.body) throw new IntegrationError("malformed-response");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            signal.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxResponseBytes) {
              await reader.cancel();
              throw new IntegrationError("malformed-response");
            }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
    }
    catch { throw new IntegrationError("malformed-response"); }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new IntegrationError("malformed-response");
    return parsed.data;
  }
  async downloadContent(path: string, signal: AbortSignal): Promise<Buffer> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\r\n#]/.test(path)) {
      throw new IntegrationError("collector-failure");
    }
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
    return Buffer.concat(chunks);
  }
  async downloadJson(path: string, signal: AbortSignal): Promise<unknown> {
    const text = (await this.downloadContent(path, signal)).toString("utf8");
    try { return JSON.parse(text); }
    catch { throw new IntegrationError("malformed-response"); }
  }
}
