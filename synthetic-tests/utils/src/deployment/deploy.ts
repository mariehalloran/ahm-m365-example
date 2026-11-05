import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConfigurationError } from "../configuration/config.js";
import { readBindingsText } from "../configuration/bindings.js";
import { readProjectDocument } from "../configuration/project-config.js";
import { canonicalProjectFile } from "../paths.js";
import { prepareProjectDeployment, type PreparedDeployment } from "./prepare-deployment.js";
import {
  assertUnchanged, az, buildBicep, createCommandTempDirectory, createStateDirectory, deployStack, hash, pinCoordinatorImage,
  preflight, saveProvenance, sourceFingerprint, verifyCoordinator, type DeploymentRun,
} from "./deploy-phases.js";
import {
  deployExecutionFunctions, pauseAndDrainCoordinator, resolveFunctionEndpoint,
  uploadConfiguration, verifyDirectReports, verifyLaneExecution, verifyObservations,
} from "./reporting-deployment.js";

const execFileAsync = promisify(execFile);
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

/** Executes one bounded CLI operation without printing tokens, real targets or raw credential errors. */
export const runDeploymentCommand: DeploymentCommandRunner = async command => {
  try {
    return (await execFileAsync(command.tool, command.args, {
      cwd: command.cwd, env: command.env, timeout: Math.max(1, command.timeoutSeconds * 1000),
      signal: command.signal, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    })).stdout;
  } catch (error) {
    const details = error as { code?: unknown; killed?: boolean };
    throw new DeploymentCommandError(command.phase, command.signal.aborted ? "cancelled" : details.killed ? "timeout" : "failed",
      typeof details.code === "number" ? details.code : undefined);
  }
};

interface DeploymentOptions {
  file?: string;
  plan?: boolean;
  env?: NodeJS.ProcessEnv;
  run?: DeploymentCommandRunner;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  emit?: (event: Record<string, unknown>) => void;
}

/** Describes the actual selected architecture without exposing configured account/resource identifiers. */
export function deploymentPlan(prepared: PreparedDeployment) {
  const serviceCount = new Set(prepared.owners.map(owner => owner.type)).size;
  return {
    event: "monitoring-deployment-plan", cloudChanges: false, configFile: canonicalProjectFile,
    stage: prepared.settings.stage, modelCount: prepared.modelNames.length,
    coordinator: { count: 1, purpose: "cron-dispatch-only", receivesResults: false, pollsExecutions: false, authentication: "selected-managed-identity" },
    functions: {
      runtime: "Node.js 22 / programming model v4", plan: "Flex Consumption FC1",
      start: "Entra-authenticated durable HTTP starter; 202 after Storage acceptance",
      state: "identity-based Azure Storage; persistent lane ownership and callback state",
      executionOwners: prepared.owners.length, laneCount: prepared.lanes.length,
      functionAppCount: serviceCount + 1, watchdog: "separate non-Graph managed identity and Function host; execution/publication freshness",
      apiRegistrationConfigured: Boolean(prepared.settings.functions.apiClientId),
    },
    reporting: {
      logAnalyticsEnabled: prepared.document.logAnalytics.enabled,
      transport: prepared.document.logAnalytics.enabled
        ? "Function -> LogsIngestionClient -> DCE/DCR -> M365Synthetic_CL -> native KQL signals"
        : "Function -> aggregated Azure Monitor Health Models ingestHealthReport",
      stepPublication: "during execution", finalJourneyPublication: true, perTargetModelSignals: false,
      eventHubs: false, captureOrReplay: false, ingestionBridge: false, resultsQueue: false,
    },
    lanes: prepared.lanes.map(lane => {
      const owner = prepared.owners.find(owner => owner.tenant === lane.tenant && owner.type === lane.service)!;
      return {
        tenantIndex: prepared.document.tenants.findIndex(tenant => tenant.id === lane.tenant),
        service: lane.service, lane: lane.lane, intervalSeconds: lane.intervalSeconds, timeoutSeconds: lane.timeoutSeconds,
        journey: lane.journey,
        ...(lane.provider ? {} : { probeType: lane.probeType, testId: lane.testId }),
        cycleTimeoutSeconds: owner.service.cycleTimeoutSeconds, cleanupTimeoutSeconds: owner.service.cleanupTimeoutSeconds,
        cleanupGraceSeconds: owner.service.cleanupGraceSeconds, publicationTimeoutSeconds: owner.service.publicationTimeoutSeconds,
        slotMarginSeconds: owner.service.slotMarginSeconds,
        targetCount: lane.provider ? 0 : 1,
        ...(lane.service === "exchange" ? {
          actualHttpPermits: { global: owner.service.maxConcurrentRequests, perMailbox: owner.service.maxConcurrentRequestsPerMailbox },
        } : {}),
      };
    }),
    prerequisites: [
      "Explicit one-off Function Entra setup; no function-key, secret or certificate fallback",
      "Stop obsolete service Graph workers and the old ingestion Function before migration",
      "Review preserved legacy Event Hubs/Capture/storage resources; no automatic deletion",
      "Verify independent freshness monitoring and action-group notifications end to end",
    ],
    verification: ["indexed-durable-and-callback-functions", "Entra-policy", "dispatcher-ready-revision",
      "all-live-lane-execution-and-publication-journals", prepared.document.logAnalytics.enabled ? "all-target-journey-log-ingestion" : "complete-journey-and-group-health-aggregates"],
    note: "Local plan only. No Azure resource changes, authentication, Graph operations or live health ingestion were verified.",
  };
}

/** Deploys models, durable execution Functions and one dispatcher from the same authoritative root configuration. */
export async function deployMonitoring(options: DeploymentOptions = {}) {
  const file = resolve(options.file ?? canonicalProjectFile);
  const configText = await readFile(file, "utf8");
  const bindingsText = await readBindingsText(file);
  const prepared = prepareProjectDeployment(await readProjectDocument(file));
  const emit = options.emit ?? (event => console.log(JSON.stringify(event)));
  if (options.plan) {
    const plan = deploymentPlan(prepared);
    emit(plan);
    return plan;
  }
  if (prepared.document.healthModel.subscriptionId === "00000000-0000-0000-0000-000000000000") {
    throw new ConfigurationError("Deployment requires an approved root subscription; --plan remains local");
  }
  const now = options.now ?? Date.now;
  const runId = `${new Date(now()).toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const run: DeploymentRun = {
    prepared, configFile: file, configText, bindingsText, runId,
    projectDocumentSha256: hash(JSON.stringify(prepared.document)),
    directory: await createStateDirectory(prepared.settings.stateDirectory, runId),
    tmpDirectory: await createCommandTempDirectory(runId),
    sourceHash: await sourceFingerprint(), subscription: ["--subscription", prepared.document.healthModel.subscriptionId],
    phase: "preflight", mutated: false, env: options.env ?? process.env, now,
    signal: options.signal ?? new AbortController().signal, runner: options.run ?? runDeploymentCommand,
    sleep: options.sleep ?? (milliseconds => new Promise(done => setTimeout(done, milliseconds))), emit,
  };
  try {
    await saveProvenance(run, "preflight");
    await preflight(run);
    await buildBicep(run);
    for (const stack of ["configuration", "models", "execution"]) await deployStack(run, stack, "what-if");
    await assertUnchanged(run);
    run.mutated = true;
    await saveProvenance(run, "deploying");
    await pauseAndDrainCoordinator(run);
    await deployStack(run, "configuration", "create");
    await deployStack(run, "models", "create");
    await deployStack(run, "execution", "create");
    await resolveFunctionEndpoint(run);
    await uploadConfiguration(run);
    await deployStack(run, "execution", "create");
    if (run.prepared.settings.stage === "all") {
      await deployExecutionFunctions(run);
      run.image = await pinCoordinatorImage(run);
      await deployStack(run, "execution", "what-if", true);
      const verificationStart = run.now();
      await deployStack(run, "execution", "create", true);
      await az(run, "start-coordinator", [
        "resource", "invoke-action", "--action", "start",
        "--resource-type", "Microsoft.App/containerApps", "--name", run.prepared.settings.coordinator.appName,
        "--resource-group", run.prepared.document.healthModel.resourceGroup, ...run.subscription, "--output", "none",
      ]);
      await verifyCoordinator(run);
      await verifyLaneExecution(run, verificationStart);
      if (run.prepared.document.logAnalytics.enabled) {
        await verifyObservations(run, verificationStart);
        await deployStack(run, "freshness", "what-if");
        await deployStack(run, "freshness", "create");
      } else await verifyDirectReports(run, verificationStart);
    }
    if (run.prepared.settings.retireEntities.length) {
      throw new ConfigurationError("Explicit obsolete entity retirement is manual in this migration; no entities or historical resources were automatically deleted");
    }
    await saveProvenance(run, "succeeded", { image: run.image });
    const result = {
      event: "monitoring-deployment-completed", runId, stage: run.prepared.settings.stage,
      laneCount: run.prepared.lanes.length, stateDirectory: run.directory,
      note: "Verify operational alerts and notification delivery independently; 202 acceptance alone is not monitoring success.",
    };
    emit(result);
    return result;
  } catch (error) {
    await saveProvenance(run, run.signal.aborted ? "cancelled" : "failed", {
      errorType: error instanceof Error ? error.name : "unknown", remoteMayStillRun: run.mutated,
    });
    emit({
      event: "monitoring-deployment-failed", phase: run.phase, stateDirectory: run.directory, remoteMayStillRun: run.mutated,
      ...(error instanceof ConfigurationError ? { message: error.message } : {}),
    });
    throw error;
  }
}

/** Accepts only the repository-root deployment and its local no-cloud preview. */
export function parseDeployArguments(args: string[]) {
  if (args.length === 0) return { plan: false };
  if (args.length === 1 && args[0] === "--plan") return { plan: true };
  throw new ConfigurationError("Usage: npm --prefix synthetic-tests run deploy -- [--plan]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await deployMonitoring({ ...parseDeployArguments(process.argv.slice(2)), signal: controller.signal }); }
  catch (error) {
    console.error(JSON.stringify({
      event: "monitoring-deploy-command-failed", errorType: error instanceof Error ? error.name : "unknown",
      ...(error instanceof ConfigurationError || error instanceof DeploymentCommandError ? { message: error.message } : {}),
    }));
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
