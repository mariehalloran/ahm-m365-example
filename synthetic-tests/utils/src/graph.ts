import type { TokenCredential } from "@azure/identity";
import { AuthenticationHandler, Client, ResponseType, type GraphRequest, type Middleware } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";
import { z } from "zod";
import { IntegrationError, readResponseBody, requestWithRetry, withAbort, type HttpOptions } from "./http.js";
import type { GraphRequestPermits } from "./graph-request-permits.js";

const graphOrigin = "https://graph.microsoft.com";
const graphScope = `${graphOrigin}/.default`;
export const graphBase = `${graphOrigin}/v1.0`;
export type GraphApiVersion = "v1.0" | "beta";
export type GraphOperations = Pick<GraphClient, "authenticate" | "json" | "request">;
export type GraphFileOperations = GraphOperations & Pick<GraphClient, "downloadContent">;

// Names the offending fields and Zod issue codes only, never the response content.
function schemaDetail(error: z.ZodError): string {
  const issues = [...new Set(error.issues.map(issue => `${issue.path.join(".") || "(root)"}(${issue.code})`))];
  return `schema:${issues.slice(0, 3).join(",")}${issues.length > 3 ? `,+${issues.length - 3}` : ""}`;
}

export interface GraphOptions extends HttpOptions {
  downloadFetch?: typeof fetch;
  mailbox?: string;
  requestPermits?: GraphRequestPermits;
}

function requestUrl(path: string, version: GraphApiVersion): URL {
  if (!["v1.0", "beta"].includes(version) || !path.startsWith("/") || path.startsWith("//") ||
      path.includes("\\") || /[\u0000-\u001f\u007f#]/.test(path)) {
    throw new IntegrationError("collector-failure");
  }
  const url = new URL(`${graphOrigin}/${version}${path}`);
  if (url.pathname !== `/${version}${path.split("?")[0]}`) throw new IntegrationError("collector-failure");
  return url;
}

function send(request: GraphRequest, method: string, content: string | undefined): Promise<Response> {
  switch (method) {
    case "POST": return request.post(content);
    case "PUT": return request.put(content);
    case "PATCH": return request.patch(content);
    case "DELETE": return request.options(content === undefined ? {} : { body: content }).delete();
    default: return request.options({ method, ...(content === undefined ? {} : { body: content }) }).get();
  }
}

export function graphNextPagePath(nextLink: string, collectionPath: string, version: GraphApiVersion = "v1.0"): string {
  let url: URL;
  try {
    url = new URL(nextLink);
  } catch {
    throw new IntegrationError("read-failure");
  }
  if (!["v1.0", "beta"].includes(version) || /[\u0000-\u0020\u007f\\]/.test(nextLink) ||
      url.origin !== graphOrigin ||
      url.pathname !== `/${version}${collectionPath}` ||
      url.username || url.password || url.hash) {
    throw new IntegrationError("read-failure");
  }
  return `${collectionPath}${url.search}`;
}

export class GraphClient {
  private readonly downloadFetch: typeof fetch;

  constructor(private readonly credential: TokenCredential, private readonly options: GraphOptions = {}) {
    this.downloadFetch = options.downloadFetch ?? fetch;
  }

  forMailbox(mailbox: string, requestPermits: GraphRequestPermits): GraphClient {
    if (this.options.mailbox && this.options.mailbox.toLowerCase() !== mailbox.toLowerCase()) {
      throw new IntegrationError("configuration-failure");
    }
    return new GraphClient(this.credential, { ...this.options, mailbox, requestPermits });
  }

  private deadline(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 15000)]);
  }

  private authenticationProvider(signal: AbortSignal): TokenCredentialAuthenticationProvider {
    return new TokenCredentialAuthenticationProvider(this.credential, {
      scopes: [graphScope], getTokenOptions: { abortSignal: signal },
    });
  }

  async authenticate(signal: AbortSignal): Promise<void> {
    const bounded = this.deadline(signal);
    try { await withAbort(bounded, () => this.authenticationProvider(bounded).getAccessToken()); }
    catch {
      bounded.throwIfAborted();
      throw new IntegrationError("authentication-failure");
    }
  }

  async request(path: string, signal: AbortSignal, method = "GET", body?: unknown, retrySafe = true, version: GraphApiVersion = "v1.0"): Promise<Response> {
    const bounded = this.deadline(signal);
    const response = await this.execute(path, bounded, method, body, retrySafe, version, "error");
    // Scoped Exchange mutation callers need only status; release their permit after the response body is cancelled.
    if (this.options.requestPermits) await withAbort(bounded, async () => response.body?.cancel());
    return response;
  }

  private async execute(
    path: string, signal: AbortSignal, method: string, body: unknown, retrySafe: boolean,
    version: GraphApiVersion, redirect: "error" | "manual",
  ): Promise<Response> {
    const url = requestUrl(path, version);
    const mailbox = this.options.mailbox;
    if (mailbox && (path.split("/")[1] !== "users" ||
        decodeURIComponent(path.split("/")[2] ?? "").toLowerCase() !== mailbox.toLowerCase())) {
      throw new IntegrationError("configuration-failure", undefined, "single-mailbox-boundary");
    }
    signal.throwIfAborted();
    let content: string | undefined;
    try { content = body === undefined ? undefined : JSON.stringify(body); }
    catch { throw new IntegrationError("collector-failure"); }
    let transportFailure: IntegrationError | undefined;
    const transport: Middleware = {
      execute: async context => {
        try {
          const target = new URL(typeof context.request === "string" ? context.request : context.request.url);
          if (target.origin !== url.origin || target.pathname !== url.pathname) throw new IntegrationError("collector-failure");
          const permits = this.options.requestPermits;
          context.response = await requestWithRetry(context.request, { ...context.options, redirect }, signal, retrySafe, {
            ...this.options,
            ...(permits && mailbox ? {
              withRequestPermit: (signal, send) => permits.request(mailbox, signal, send),
            } : {}),
          });
        } catch (error) {
          transportFailure = error instanceof IntegrationError ? error : new IntegrationError("collector-failure");
          throw error;
        }
      },
    };
    // Exclude SDK retry/redirect middleware: Graph and ARM/Bot share one
    // abortable retry policy, and authenticated redirects must never be followed.
    const sdk = Client.initWithMiddleware({
      middleware: [new AuthenticationHandler(this.authenticationProvider(signal)), transport],
    });
    const request = sdk.api(url.href).responseType(ResponseType.RAW)
      .headers({ "Content-Type": "application/json", Prefer: 'IdType="ImmutableId"' });
    let response: Response;
    try { response = await withAbort(signal, () => send(request, method, content)); }
    catch {
      signal.throwIfAborted();
      throw transportFailure ?? new IntegrationError("authentication-failure");
    }
    signal.throwIfAborted();
    if (response.status === 404 && method !== "DELETE") {
      await withAbort(signal, async () => { await response.body?.cancel(); });
      throw new IntegrationError("read-failure", 404);
    }
    return response;
  }

  async json<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, signal: AbortSignal, method = "GET", body?: unknown, retrySafe = true, version: GraphApiVersion = "v1.0", maxResponseBytes?: number): Promise<T> {
    const bounded = this.deadline(signal);
    const response = await this.execute(path, bounded, method, body, retrySafe, version, "error");
    let raw: unknown;
    try {
      raw = JSON.parse((await readResponseBody(response, maxResponseBytes ?? 2 * 1024 * 1024, bounded, "malformed-response")).toString("utf8"));
    } catch (error) {
      bounded.throwIfAborted();
      throw error instanceof IntegrationError && error.detail ? error : new IntegrationError("malformed-response", undefined, "invalid-json");
    }
    const parsed = schema.safeParse(raw);
    bounded.throwIfAborted();
    if (!parsed.success) throw new IntegrationError("malformed-response", undefined, schemaDetail(parsed.error));
    return parsed.data;
  }

  async downloadContent(path: string, signal: AbortSignal): Promise<Buffer> {
    const graphSignal = this.deadline(signal);
    const response = await this.execute(path, graphSignal, "GET", undefined, true, "v1.0", "manual");
    const location = response.headers.get("location");
    await withAbort(graphSignal, async () => { await response.body?.cancel(); });
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
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const download = await withAbort(bounded, () => this.downloadFetch(url, { signal: bounded, redirect: "error" }));
    if (!download.ok || !download.body) {
      await withAbort(bounded, async () => { await download.body?.cancel(); });
      throw new IntegrationError("read-failure");
    }
    return readResponseBody(download, 4096, bounded, "read-failure");
  }
}
