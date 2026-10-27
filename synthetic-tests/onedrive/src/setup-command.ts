import { AzureCliCredential, type TokenCredential } from "@azure/identity";
import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createServiceCredential } from "../../utils/src/auth.js";
import { ConfigurationError } from "../../utils/src/config.js";
import { consoleTelemetry, type Telemetry } from "../../utils/src/contracts.js";
import { GraphClient } from "../../utils/src/graph.js";
import { categoryOf } from "../../utils/src/http.js";
import { parseProjectConfig } from "../../utils/src/project-config.js";
import { setupOneDriveTargets, type FolderBinding, type SetupGraph } from "./setup.js";

const scope = "https://graph.microsoft.com/.default";
const usage = "Usage: npm run onedrive:setup -- <private-project-config> --tenant-id <id> --worker-client-id <id> --authentication <azure-cli|managed-identity|certificate> [--setup-client-id <id>] [--certificate-path <file>] [--concurrency <1-10>] [--target-timeout-seconds <30-3600>] [--apply]";
const argumentsSchema = z.object({
  projectFile: z.string().min(1),
  tenantId: z.string().uuid(),
  workerClientId: z.string().uuid(),
  authentication: z.enum(["azure-cli", "managed-identity", "certificate"]),
  setupClientId: z.string().uuid().optional(),
  certificatePath: z.string().min(1).optional(),
  concurrency: z.coerce.number().int().min(1).max(10).default(4),
  targetTimeoutSeconds: z.coerce.number().int().min(30).max(3600).default(300),
  apply: z.boolean(),
}).strict();
export type SetupArguments = z.infer<typeof argumentsSchema>;
const documentSchema = z.object({
  services: z.object({
    onedrive: z.object({ targets: z.array(z.object({ id: z.string() }).passthrough()) }).passthrough(),
  }).passthrough(),
}).passthrough();

export function parseSetupArguments(args: string[]): SetupArguments {
  const [projectFile, ...remaining] = args;
  if (!projectFile || projectFile.startsWith("--")) throw new ConfigurationError(usage);
  const flags = new Map([
    ["--tenant-id", "tenantId"], ["--worker-client-id", "workerClientId"],
    ["--authentication", "authentication"], ["--setup-client-id", "setupClientId"],
    ["--certificate-path", "certificatePath"], ["--concurrency", "concurrency"],
    ["--target-timeout-seconds", "targetTimeoutSeconds"],
  ]);
  const values: Record<string, string> = {};
  let apply = false;
  for (let index = 0; index < remaining.length; index++) {
    const flag = remaining[index]!;
    if (flag === "--apply" && !apply) { apply = true; continue; }
    const name = flags.get(flag);
    const value = remaining[++index];
    if (!name || values[name] !== undefined || !value || value.startsWith("--")) throw new ConfigurationError(usage);
    values[name] = value;
  }
  const parsed = argumentsSchema.safeParse({ projectFile, ...values, apply });
  if (!parsed.success) throw new ConfigurationError(usage);
  const options = parsed.data;
  if (options.authentication === "azure-cli" ? options.setupClientId || options.certificatePath
    : !options.setupClientId || (options.authentication === "certificate" ? !options.certificatePath : options.certificatePath)) {
    throw new ConfigurationError("Select exactly one explicit setup credential; managed-identity/certificate require --setup-client-id, and only certificate accepts --certificate-path");
  }
  if (options.setupClientId?.toLowerCase() === options.workerClientId.toLowerCase()) {
    throw new ConfigurationError("The privileged setup identity must be separate from the OneDrive worker");
  }
  return options;
}

export function cachedSetupCredential(credential: TokenCredential): TokenCredential {
  let cached: Awaited<ReturnType<TokenCredential["getToken"]>>;
  let refreshing: ReturnType<TokenCredential["getToken"]> | undefined;
  return {
    async getToken(_scopes, options) {
      if (cached && cached.expiresOnTimestamp > Date.now() + 300000) return cached;
      refreshing ??= (async () => {
        const token = await credential.getToken(scope, options);
        if (!token) throw new ConfigurationError("The setup credential did not return a Graph token");
        cached = token;
        return token;
      })();
      try { return await refreshing; }
      finally { refreshing = undefined; }
    },
  };
}

function setupGraph(options: SetupArguments): SetupGraph {
  const credential = options.authentication === "azure-cli" ? new AzureCliCredential({ tenantId: options.tenantId })
    : createServiceCredential({
      AZURE_CLIENT_ID: options.setupClientId,
      M365_TENANT_ID: options.tenantId, M365_CLIENT_ID: options.setupClientId,
      M365_CLIENT_CERTIFICATE_PATH: options.certificatePath,
    }, options.authentication);
  const cached = cachedSetupCredential(credential);
  return new GraphClient(
    cached,
    { attempts: 5, timeoutMs: 300000, maxRetryDelayMs: 60000, retryThrottledWrites: true },
  );
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = `${file}.onedrive-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export async function runSetupCommand(
  options: SetupArguments, graph: SetupGraph, telemetry: Telemetry, signal: AbortSignal,
) {
  const file = await realpath(options.projectFile);
  const lockPath = `${file}.onedrive-setup.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  if (options.apply) {
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new ConfigurationError("Another setup holds the project-config lock; verify that it has stopped before removing a stale .onedrive-setup.lock file");
      }
      throw error;
    }
  }
  try {
    if (lock) await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    let expected = await readFile(file, "utf8");
    let raw: unknown;
    try { raw = JSON.parse(expected); }
    catch { throw new ConfigurationError("Project config must contain valid JSON"); }
    const project = parseProjectConfig(raw);
    if (!project.services.onedrive.enabled) throw new ConfigurationError("OneDrive setup requires an enabled root service selection");
    const document = documentSchema.parse(raw);
    const targets = new Map(document.services.onedrive.targets.map(target => [target.id, target]));
    let writes = Promise.resolve();
    const checkpoint = (binding: FolderBinding) => {
      writes = writes.then(async () => {
        if (await readFile(file, "utf8") !== expected) {
          throw new ConfigurationError("Project config changed during setup; no external edits were overwritten. Rerun against the reviewed profile");
        }
        const target = targets.get(binding.targetId);
        if (!target) throw new ConfigurationError("Setup target is no longer in the approved root configuration");
        if (target.driveId === binding.driveId && target.folderId === binding.folderId) return;
        target.driveId = binding.driveId;
        target.folderId = binding.folderId;
        const next = `${JSON.stringify(document, null, 2)}\n`;
        await atomicWrite(file, next);
        expected = next;
      });
      return writes;
    };
    return await setupOneDriveTargets(project.services.onedrive.targets, graph, {
      ...options, signal, telemetry, ...(options.apply ? { checkpoint } : {}),
    });
  } finally {
    if (lock) {
      try { await lock.close(); }
      finally { await unlink(lockPath); }
    }
  }
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const options = parseSetupArguments(args);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const summary = await runSetupCommand(options, setupGraph(options), consoleTelemetry, controller.signal);
    if (controller.signal.aborted) process.exitCode = 130;
    else if (summary.failed || summary.notStarted) process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({
      event: "onedrive-setup-failed",
      category: error instanceof ConfigurationError ? "configuration-failure" : categoryOf(error),
      errorType: error instanceof Error ? error.name : "unknown",
      ...(error instanceof ConfigurationError ? { message: error.message } : {}),
    }));
    process.exitCode = 1;
  });
}
