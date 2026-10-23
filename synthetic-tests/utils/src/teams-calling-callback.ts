import { createServer, type IncomingMessage } from "node:http";
import { callingAuthenticationDiagnostic, type CallingAuthenticationDiagnostic } from "./teams-calling-auth.js";

const about = "Internal monitoring lab. Dedicated test resources only. Operators configure message retention and diagnostics. Bot runtime uses managed identity and no user token cache. Not for production or customer-content use.\n";
const maxBodyBytes = 65536;

async function readNotification(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    const chunk = Buffer.from(part);
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw new Error("Body limit");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid notification");
  return value;
}

export async function startTeamsCallingCallback(options: {
  port: number;
  host?: string;
  verify: (token: string) => Promise<void>;
  onAccepted?: () => void;
  onRejected?: (status: number, stage: "headers" | "verification" | "body" | "timeout" | "handler",
    diagnostic?: CallingAuthenticationDiagnostic) => void;
}) {
  let diagnosticWindow = Date.now();
  let rejectedDiagnostics = 0;
  let acceptedDiagnostics = 0;
  const refreshDiagnosticWindow = () => {
    if (Date.now() - diagnosticWindow >= 60000) {
      diagnosticWindow = Date.now();
      rejectedDiagnostics = 0;
      acceptedDiagnostics = 0;
    }
  };
  const server = createServer({ maxHeaderSize: 16384 }, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    const reject = (status: number, stage?: "headers" | "verification" | "body" | "timeout" | "handler",
      diagnostic?: CallingAuthenticationDiagnostic) => {
      if (response.headersSent || response.destroyed) return;
      if (stage) {
        refreshDiagnosticWindow();
        if (rejectedDiagnostics++ < 10) options.onRejected?.(status, stage, diagnostic);
      }
      response.setHeader("Connection", "close");
      response.writeHead(status).end();
    };
    if (request.method === "GET" && request.url === "/about") {
      response.writeHead(200).end(about);
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200).end("ready\n");
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/calls") { reject(404); return; }
    const deadline = setTimeout(() => {
      reject(408, "timeout");
      request.destroy();
    }, 5000);
    response.once("close", () => clearTimeout(deadline));
    const authorization = request.headers.authorization;
    if (!authorization || authorization.length > 8192 || !/^Bearer [^\s]+$/.test(authorization)) {
      reject(401, "headers"); return;
    }
    const length = request.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) {
      reject(413, "headers"); return;
    }
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      reject(415, "headers"); return;
    }
    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const verificationTimeout = new Error("Verification timeout");
      try {
        await Promise.race([
          options.verify(authorization.slice(7)),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(verificationTimeout), 3500); }),
        ]);
      }
      catch (error) {
        reject(401, "verification", error === verificationTimeout
          ? { authErrorCode: "CALLING_VERIFICATION_TIMEOUT" } : callingAuthenticationDiagnostic(error));
        return;
      }
      finally { clearTimeout(timer); }
      try {
        await readNotification(request);
      }
      catch { reject(400, "body"); return; }
      response.writeHead(200).end();
      refreshDiagnosticWindow();
      if (acceptedDiagnostics++ < 10) options.onAccepted?.();
    })().catch(() => { if (!response.headersSent) reject(500, "handler"); else response.destroy(); });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 2000;
  server.timeout = 5000;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 20;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : options.port,
    shutdown: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
