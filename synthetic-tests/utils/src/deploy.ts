import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConfigurationError } from "./config.js";
import { applyBindings, parseBindings, readBindingsText } from "./bindings.js";
import {
  beginMutations, buildBicep, createStateDirectory, deployFoundation, deployModels, deployWorkers, deploysWorkers, hash, nativeCertificates,
  parseJson, pinImage, preflight, previewChanges, removeSecureParameters, retireObsoleteEntities, saveProvenance, sourceFingerprint,
  verifyRollout, writeParameterFiles, type DeploymentRun,
} from "./deploy-phases.js";
import { canonicalProjectFile } from "./paths.js";
import { prepareProjectDeployment, type PreparedDeployment } from "./prepare-deployment.js";
import {
  deployFreshnessAlert, deployIngestionFunction, deployReportingFoundation, uploadWorkerConfiguration,
  verifyDirectReports, verifyObservations, writeReportingParameters,
} from "./reporting-deployment.js";
import { prepareLogPipelineRetirement, retireLogPipeline, retireWorkerDiagnosticGrants } from "./retire-log-pipeline.js";

const execFileAsync = promisify(execFile);
const placeholderSubscriptionId = "00000000-0000-0000-0000-000000000000";
export interface DeploymentCommand {
  tool: "az" | "git" | "npm" | "zip";
  args: string[];
  phase: string;
  timeoutSeconds: number;
  cwd: string;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
}
export type DeploymentCommandRunner = (command: DeploymentCommand) => Promise<string>;
export class DeploymentCommandError extends Error {
  constructor(readonly phase: string, readonly reason: "failed" | "timeout" | "cancelled", readonly exitCode?: number) {
    super(`${phase}: command ${reason}${exitCode === undefined ? "" : ` (exit ${exitCode})`}`);
    this.name = "DeploymentCommandError";
  }
}
export const runDeploymentCommand: DeploymentCommandRunner = async command => {
  try {
    return (await execFileAsync(command.tool, command.args, {
      cwd: command.cwd, env: command.env, timeout: Math.max(1, Math.floor(command.timeoutSeconds * 1000)),
      signal: command.signal, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    })).stdout;
  } catch (error) {
    const details = error as { code?: unknown; killed?: boolean };
    throw new DeploymentCommandError(command.phase, command.signal.aborted ? "cancelled" : details.killed ? "timeout" : "failed",
      typeof details.code === "number" ? details.code : undefined);
  }
};

interface DeploymentOptions {
  file?: string; plan?: boolean; env?: NodeJS.ProcessEnv; run?: DeploymentCommandRunner;
  signal?: AbortSignal; sleep?: (milliseconds: number) => Promise<void>; now?: () => number;
  emit?: (event: Record<string, unknown>) => void;
}

const printEvent = (event: Record<string, unknown>) => console.log(JSON.stringify(event));
const wait = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));

export function deploymentPlan(prepared: PreparedDeployment) {
  const logAnalytics = prepared.document.logAnalytics.enabled;
  return {
    event: "monitoring-deployment-plan", cloudChanges: false,
    configFile: canonicalProjectFile, subscriptionConfigured: prepared.document.healthModel.subscriptionId !== placeholderSubscriptionId,
    stage: prepared.settings.stage, location: prepared.settings.location, models: prepared.modelNames,
    workerCount: prepared.workers.length, reportingGroups: prepared.reportingGroups.map(({ service, id }) => ({ service, id })),
    logAnalytics: logAnalytics ? {
      ...prepared.document.logAnalytics,
      workspaceName: prepared.settings.workspaceName ?? `law-${prepared.document.healthModel.name}`,
      table: "M365Synthetic_CL", workspaceBilling: "PerGB2018",
      transport: "Event Hubs -> managed-identity Function -> DCR Logs Ingestion API",
    } : { enabled: false, transport: "Container -> direct Azure Monitor Health Models reports" },
    configurationStorageAccount: prepared.settings.configurationStorageAccount,
    workers: prepared.workers.map(worker => ({
      tenant: worker.tenant, service: worker.type, appName: worker.appName, identityResourceId: worker.identityResourceId,
      targetCount: worker.service.type === "teams"
        ? worker.service.botPairs.length * (worker.service.targets.length + worker.service.callTargets.length) : worker.service.targets.length,
      ...(worker.service.type === "teams" ? { botPairCount: worker.service.botPairs.length } : {}),
      mode: worker.service.mode,
    })),
    foundationMode: prepared.settings.foundation.mode, imageMode: prepared.settings.image.mode,
    retiredEntityCount: prepared.settings.retireEntities.length,
    phases: ["credential-and-binding-preflight", "build-bicep", "reporting-foundation-what-if", "models-what-if", "foundation-what-if", "workers-what-if",
      "deploy-configuration-and-selected-reporting-foundation", "deploy-models", "deploy-foundation", ...(deploysWorkers(prepared)
        ? ["pin-image", ...(logAnalytics ? ["deploy-ingestion-function", "verify-ingestion-function"] : []),
          "upload-worker-configuration", "deploy-exchange-pilot",
          logAnalytics ? "verify-observations" : "verify-direct-health-reports", "deploy-workers", "verify-rollout",
          ...(logAnalytics ? ["deploy-freshness-alert", "verify-freshness-query"] : ["retire-owned-log-pipeline-preserve-history"]),
          "retire-obsolete-diagnostic-grants", "retire-explicit-obsolete-entities"] : [])],
    note: "Local plan only: Azure permissions, actual Graph access, bot routes, image availability and rollout are not verified.",
  };
}

export async function deployMonitoring(options: DeploymentOptions = {}) {
  const file = resolve(options.file ?? canonicalProjectFile);
  const configText = await readFile(file, "utf8");
  const bindingsText = await readBindingsText(file);
  const prepared = prepareProjectDeployment(
    applyBindings(parseJson<unknown>(configText, "monitoring.config.json"), parseBindings(bindingsText)),
  );
  if (options.plan) {
    const plan = { ...deploymentPlan(prepared), configFile: file };
    (options.emit ?? printEvent)(plan);
    return plan;
  }
  if (prepared.document.healthModel.subscriptionId === placeholderSubscriptionId) {
    throw new ConfigurationError("Configure an approved healthModel.subscriptionId before Azure deployment; --plan remains local");
  }
  const run = await createRun({ file, configText, bindingsText }, prepared, options);
  try {
    await saveProvenance(run);
    const { registry, retirements } = await preflight(run);
    const logPipelineRetirement = prepared.document.logAnalytics.enabled ? undefined : await prepareLogPipelineRetirement(run);
    await buildBicep(run);
    await writeParameterFiles(run, registry);
    await writeReportingParameters(run);
    await deployReportingFoundation(run, "what-if");
    await previewChanges(run, registry);
    await beginMutations(run);
    await deployReportingFoundation(run, "create");
    await deployModels(run);
    await deployFoundation(run);
    if (deploysWorkers(prepared)) {
      const image = await pinImage(run, registry);
      if (prepared.document.logAnalytics.enabled) await deployIngestionFunction(run);
      await uploadWorkerConfiguration(run);
      const pilot = prepared.workers.find(worker => worker.type === "exchange") ?? prepared.workers[0]!;
      const pilotStarted = new Date(run.now()).toISOString();
      await deployWorkers(run, image, [pilot.type]);
      await verifyRollout(run, image, [pilot.type]);
      const verifyReports = prepared.document.logAnalytics.enabled ? verifyObservations : verifyDirectReports;
      await verifyReports(run, pilot.type, pilotStarted);
      await deployWorkers(run, image);
      await verifyRollout(run, image);
      for (const service of [...new Set(prepared.workers.map(worker => worker.type))]) {
        await verifyReports(run, service, pilotStarted);
      }
      if (prepared.document.logAnalytics.enabled) await deployFreshnessAlert(run);
      else await retireLogPipeline(run, logPipelineRetirement!);
      await retireWorkerDiagnosticGrants(run);
      await retireObsoleteEntities(run, retirements);
    }
    return await recordSuccess(run); // awaited so a failure while recording success is recorded as a failed run
  } catch (error) {
    await recordFailure(run, error);
    throw error;
  } finally {
    await removeSecureParameters(run);
  }
}

async function createRun(
  source: { file: string; configText: string; bindingsText: string }, prepared: PreparedDeployment, options: DeploymentOptions,
): Promise<DeploymentRun> {
  const { file, configText, bindingsText } = source;
  const env = options.env ?? process.env;
  const certificates = nativeCertificates(prepared, env);
  const sourceHash = await sourceFingerprint();
  const now = options.now ?? Date.now;
  const runId = `${new Date(now()).toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  if (prepared.settings.image.mode === "build" && `${prepared.settings.image.tag}-${runId}`.length > 128) {
    throw new ConfigurationError("deployment.image.tag is too long to append a unique deployment run ID within 128 characters");
  }
  const directory = await createStateDirectory(prepared.settings.stateDirectory, runId);
  const { subscriptionId, resourceGroup } = prepared.document.healthModel;
  return {
    prepared, configFile: file, configText, bindingsText, sourceHash, certificates, runId, directory,
    subscription: ["--subscription", subscriptionId],
    provenance: {
      runId, status: "preflight", configSha256: hash(configText), bindingsSha256: hash(bindingsText), sourceSha256: sourceHash,
      subscriptionId, resourceGroup, models: prepared.modelNames, startedAt: new Date(now()).toISOString(),
    },
    phase: "preflight", mutated: false, env, now,
    signal: options.signal ?? new AbortController().signal,
    runner: options.run ?? runDeploymentCommand,
    sleep: options.sleep ?? wait,
    emit: options.emit ?? printEvent,
  };
}

async function recordSuccess(run: DeploymentRun) {
  run.provenance.status = "succeeded";
  run.provenance.completedAt = new Date(run.now()).toISOString();
  await saveProvenance(run);
  const result = {
    event: "monitoring-deployment-completed", runId: run.runId, stateDirectory: run.directory, stage: run.prepared.settings.stage,
    image: run.provenance.image, workerCount: run.prepared.workers.length,
    note: "ARM/ready-revision rollout completed; independently verify real journey reports, freshness and notifications.",
  };
  run.emit(result);
  return result;
}

async function recordFailure(run: DeploymentRun, error: unknown) {
  const { provenance } = run;
  provenance.status = run.signal.aborted ? "cancelled" : "failed";
  provenance.phase = error instanceof DeploymentCommandError ? error.phase : run.phase;
  provenance.remoteMayStillRun = run.mutated;
  provenance.errorType = error instanceof Error ? error.name : "unknown";
  await saveProvenance(run);
  run.emit({
    event: "monitoring-deployment-failed", phase: provenance.phase, stateDirectory: run.directory, remoteMayStillRun: run.mutated,
    ...(error instanceof ConfigurationError ? { message: error.message } : {}),
  });
}

export function parseDeployArguments(args: string[]) {
  let plan = false;
  let file: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--plan" && !plan) plan = true;
    else if (args[index] === "--config" && !file && args[index + 1] && !args[index + 1]!.startsWith("--")) file = args[++index];
    else throw new ConfigurationError("Usage: npm --prefix synthetic-tests run deploy -- [--plan] [--config <monitoring.config.json>]");
  }
  return { plan, ...(file ? { file } : {}) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await deployMonitoring({ ...parseDeployArguments(process.argv.slice(2)), signal: controller.signal }); }
  catch (error) {
    console.error(JSON.stringify({ event: "monitoring-deploy-command-failed", errorType: error instanceof Error ? error.name : "unknown",
      ...(error instanceof ConfigurationError || error instanceof DeploymentCommandError ? { message: error.message } : {}) }));
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
