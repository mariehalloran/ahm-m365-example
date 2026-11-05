import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ManagedIdentityCredential, type TokenCredential } from "@azure/identity";
import { z } from "zod";
import { ConfigurationError } from "../../utils/src/configuration/config.js";
import { readProjectDocument, serviceTypes, type ProjectDocument } from "../../utils/src/configuration/project-config.js";
import { canonicalProjectFile } from "../../utils/src/paths.js";
import { consoleTelemetry, type Telemetry } from "../../utils/src/contracts.js";
import { runExecutionLanes } from "../../utils/src/execution/execution-lanes.js";
import { createDispatch, dispatchInventory, dispatchRunId } from "../../functions/src/dispatch.js";

interface CoordinatorOptions {
  document: ProjectDocument;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  telemetry?: Telemetry;
  credential?: TokenCredential;
  fetch?: typeof fetch;
  once?: boolean;
}

/** Sends only authenticated start requests and verifies the minimal 202 receipt, without polling execution. */
async function runCoordinator(options: CoordinatorOptions): Promise<void> {
  const settings = options.document.deployment;
  if (!settings) throw new ConfigurationError("The dispatcher requires root deployment settings");
  const env = z.object({
    AZURE_CLIENT_ID: z.string().uuid(),
    MONITORING_CONFIG_SHA256: z.string().regex(/^[a-f0-9]{64}$/),
    FUNCTION_API_CLIENT_ID: z.string().uuid(),
    FUNCTION_START_URLS: z.string().min(2),
  }).parse(options.env);
  const lanes = dispatchInventory(options.document, env.MONITORING_CONFIG_SHA256);
  const selectedServices = [...new Set(lanes.map(lane => lane.service))];
  let parsedStartUrls: unknown;
  try {
    parsedStartUrls = JSON.parse(env.FUNCTION_START_URLS);
  } catch {
    throw new ConfigurationError("FUNCTION_START_URLS must be valid JSON");
  }
  const startUrls = z.record(z.enum(serviceTypes), z.string().url()).parse(parsedStartUrls);
  const serviceStartUrls = new Map<string, URL>();
  for (const service of selectedServices) {
    const value = startUrls[service];
    if (!value) throw new ConfigurationError(`Missing FUNCTION_START_URLS entry for service '${service}'`);
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".azurewebsites.net") || url.pathname !== "/api/lanes/start" ||
        url.search || url.hash || url.username || url.password) {
      throw new ConfigurationError(`Invalid function start URL for service '${service}'`);
    }
    serviceStartUrls.set(service, url);
  }
  if (settings.coordinator.identityClientId?.toLowerCase() !== env.AZURE_CLIENT_ID.toLowerCase() ||
      settings.functions.apiClientId?.toLowerCase() !== env.FUNCTION_API_CLIENT_ID.toLowerCase()) {
    throw new ConfigurationError("Dispatcher endpoint, audience or managed identity does not match the deployed root snapshot");
  }
  const telemetry = options.telemetry ?? consoleTelemetry;
  const credential = options.credential ?? new ManagedIdentityCredential({ clientId: env.AZURE_CLIENT_ID });
  telemetry.emit("coordinator-started", {
    laneCount: lanes.length,
    serviceCount: selectedServices.length,
    execution: "durable-function-starts-only",
  });
  await runExecutionLanes(lanes, async lane => {
    const selected = lanes.find(item => item.name === lane.name)!;
    const dispatch = createDispatch(selected);
    const url = serviceStartUrls.get(selected.service);
    if (!url) throw new ConfigurationError(`Missing function start URL for service '${selected.service}'`);
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(settings.coordinator.startTimeoutSeconds * 1000)]);
    try {
      const token = await credential.getToken(`${env.FUNCTION_API_CLIENT_ID}/.default`, { abortSignal: signal });
      if (!token) throw new Error("The selected dispatcher identity did not receive an API token");
      const response = await (options.fetch ?? fetch)(url, {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.token}` },
        body: JSON.stringify(dispatch),
      });
      if (response.status !== 202) {
        await response.body?.cancel();
        throw new Error(`Function starter rejected dispatch (HTTP ${response.status})`);
      }
      const receipt = z.object({ runId: z.string().uuid() }).strict().parse(await response.json());
      if (receipt.runId !== dispatchRunId(dispatch)) throw new Error("Function receipt does not match the dispatched configuration and schedule slot");
      telemetry.emit("coordinator-dispatch-accepted", {
        lane: selected.name, service: selected.service, slot: dispatch.slot, attemptId: dispatch.attemptId, runId: receipt.runId,
      });
    } catch (error) {
      telemetry.emit("coordinator-dispatch-failed", {
        lane: selected.name, service: selected.service, slot: dispatch.slot, attemptId: dispatch.attemptId,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
  }, { signal: options.signal, telemetry, ...(options.once === undefined ? {} : { once: options.once }) });
}

/** Runs the sole hosted Container App process; it never creates Graph clients or health publishers. */
async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runCoordinator({
      document: await readProjectDocument(canonicalProjectFile), env: process.env, signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main().catch(error => {
    console.error(JSON.stringify({ event: "coordinator-failed", errorType: error instanceof Error ? error.name : "unknown" }));
    process.exitCode = 1;
  });
}
