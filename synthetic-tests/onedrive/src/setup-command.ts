import { AzureCliCredential, type TokenCredential } from "@azure/identity";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceCredential } from "../../utils/src/auth.js";
import { ConfigurationError } from "../../utils/src/config.js";
import { withProjectCheckpoint } from "../../utils/src/config-checkpoint.js";
import { consoleTelemetry, type Telemetry } from "../../utils/src/contracts.js";
import { GraphClient } from "../../utils/src/graph.js";
import { categoryOf } from "../../utils/src/http.js";
import { canonicalProjectFile } from "../../utils/src/paths.js";
import { parseProjectDocument, rawTenantServices, selectTenant, type ProjectConfig } from "../../utils/src/project-config.js";
import { setupOneDriveTargets, type FolderBinding, type SetupGraph } from "./setup.js";

const scope = "https://graph.microsoft.com/.default";
const usage = "Usage: npm run onedrive:setup -- [--config <monitoring.config.json>] [--tenant <alias>] [--apply]; configure the explicit privileged credential in tenants[].services.onedrive.setup";
export interface SetupArguments { projectFile: string; tenant?: string; apply: boolean }
type SetupOptions = NonNullable<ProjectConfig["services"]["onedrive"]["setup"]> & SetupArguments & { tenantId: string };

export function parseSetupArguments(args: string[]): SetupArguments {
  const values: Record<string, string> = {};
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--apply" && !apply) { apply = true; continue; }
    const value = args[++index];
    if (!["--config", "--tenant"].includes(flag) || values[flag] || !value || value.startsWith("--")) {
      throw new ConfigurationError(usage);
    }
    values[flag] = value;
  }
  return {
    projectFile: values["--config"] ?? canonicalProjectFile, apply,
    ...(values["--tenant"] ? { tenant: values["--tenant"] } : {}),
  };
}

export function selectedSetupOptions(args: SetupArguments, project: ProjectConfig): SetupOptions {
  const setup = project.services.onedrive.setup;
  if (!setup) throw new ConfigurationError("Configure tenants[].services.onedrive.setup with an explicit privileged authentication choice and workerClientId");
  if (setup.authentication === "azure-cli" ? setup.setupClientId || setup.certificatePath
    : !setup.setupClientId || (setup.authentication === "certificate" ? !setup.certificatePath : setup.certificatePath)) {
    throw new ConfigurationError("Select exactly one explicit setup credential; managed-identity/certificate require setupClientId, and only certificate accepts certificatePath");
  }
  if (setup.setupClientId?.toLowerCase() === setup.workerClientId.toLowerCase()) {
    throw new ConfigurationError("The privileged setup identity must be separate from the OneDrive worker");
  }
  if (project.services.onedrive.worker?.identityClientId &&
      project.services.onedrive.worker.identityClientId.toLowerCase() !== setup.workerClientId.toLowerCase()) {
    throw new ConfigurationError("setup.workerClientId must match the configured worker identityClientId");
  }
  return { ...args, ...setup, tenantId: project.tenant.tenantId,
    ...(setup.certificatePath ? { certificatePath: resolve(resolve(args.projectFile, ".."), setup.certificatePath) } : {}) };
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

function setupGraph(options: SetupOptions): SetupGraph {
  const credential = options.authentication === "azure-cli" ? new AzureCliCredential({ tenantId: options.tenantId })
    : createServiceCredential({
      AZURE_CLIENT_ID: options.setupClientId, M365_TENANT_ID: options.tenantId,
      M365_CLIENT_ID: options.setupClientId, M365_CLIENT_CERTIFICATE_PATH: options.certificatePath,
    }, options.authentication);
  return new GraphClient(cachedSetupCredential(credential),
    { attempts: 5, timeoutMs: 300000, maxRetryDelayMs: 60000, retryThrottledWrites: true });
}

export async function runSetupCommand(
  args: SetupArguments, graph: SetupGraph | undefined, telemetry: Telemetry, signal: AbortSignal,
) {
  return withProjectCheckpoint(args.projectFile, args.apply, async context => {
    const project = selectTenant(parseProjectDocument(context.document), args.tenant);
    const options = selectedSetupOptions(args, project);
    if (!project.services.onedrive.enabled) throw new ConfigurationError("OneDrive setup requires an enabled root service selection");
    const checkpoint = (binding: FolderBinding) => context.checkpoint(raw => {
      const target = rawTenantServices(raw, project.tenant.id).onedrive.targets.find(target => target.id === binding.targetId);
      if (!target) throw new ConfigurationError("Setup target is no longer in the tenant inventory");
      target.driveId = binding.driveId;
      target.folderId = binding.folderId;
      return raw;
    });
    return setupOneDriveTargets(project.services.onedrive.targets, graph ?? setupGraph(options), {
      ...options, signal, telemetry, ...(options.apply ? { checkpoint } : {}),
    });
  });
}

async function main(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const options = parseSetupArguments(args);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const summary = await runSetupCommand(options, undefined, consoleTelemetry, controller.signal);
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
      event: "onedrive-setup-failed", category: error instanceof ConfigurationError ? "configuration-failure" : categoryOf(error),
      errorType: error instanceof Error ? error.name : "unknown",
      ...(error instanceof ConfigurationError ? { message: error.message } : {}),
    }));
    process.exitCode = 1;
  });
}
