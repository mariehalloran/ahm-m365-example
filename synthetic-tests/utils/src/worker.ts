import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigurationError, type Config } from "./config.js";
import { consoleTelemetry, resultSchema, type Probe, type Telemetry } from "./contracts.js";
import { categoryOf, IntegrationError } from "./http.js";
import { baseResult, type ProbeHandler } from "./probes.js";
import { runCycle, type RunnerDependencies } from "./runner.js";
import { providerGraphClient, serviceRuntime, validateRuntimeConsent } from "./runtime.js";
import { parseServiceConfig, serviceProbes, serviceSettings, type ServiceConfig } from "./service-config.js";
import type { ProviderCollectionSummary, ProviderCollector } from "./provider-collection.js";
import { applyProjectConfig, type ProjectConfig } from "./project-config.js";
import { createHealthReporter, type HealthReporter } from "./health-reports.js";
import { createResultOutput, type ResultOutput } from "./results.js";
import { providerDiagnosticSchema, type ProviderDiagnostic } from "./provider-diagnostics.js";

export function parseWorkerArguments(args: readonly string[], defaultConfig?: string) {
  let config: string | undefined;
  let once = false;
  let projectConfig: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--config" && !config && args[index + 1] && !args[index + 1]!.startsWith("--")) {
      config = args[++index];
    } else if (argument === "--project-config" && !projectConfig && args[index + 1] && !args[index + 1]!.startsWith("--")) {
      projectConfig = args[++index];
    } else if (argument === "--once" && !once) once = true;
    else throw new ConfigurationError("Usage: npm run <exchange|teams|sharepoint> -- [--project-config <monitoring.config.json>] [--config <service-config.json>] [--once]");
  }
  if (!config && defaultConfig === undefined) throw new ConfigurationError("An explicit --config is required");
  return { config: config ?? defaultConfig!, once, ...(projectConfig ? { projectConfig } : {}) };
}

export interface WorkerOptions {
  handler?: ProbeHandler;
  providers?: ProviderCollector;
  expectedService?: ServiceConfig["type"];
  once?: boolean;
  signal?: AbortSignal;
  telemetry?: Telemetry;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  createDependencies?: (service: ServiceConfig, config: Config, telemetry: Telemetry) => RunnerDependencies | Promise<RunnerDependencies>;
  execute?: typeof runCycle;
  project?: ProjectConfig;
}

interface InitializedService {
  config: Config;
  dependencies: RunnerDependencies;
}

async function initializeService(
  service: ServiceConfig, options: WorkerOptions, telemetry: Telemetry,
  env: NodeJS.ProcessEnv, reportHealth: HealthReporter | undefined,
  suppliedResults: ResultOutput,
): Promise<InitializedService> {
  const config = serviceSettings(service, env, options.project?.services[service.type].scenarios);
  if ((service.serviceHealth || service.serviceActivity.enabled) && !options.providers) {
    throw new ConfigurationError("Configured provider sources require the service-owned collector");
  }
  const runtime = await (options.createDependencies
    ? options.createDependencies(service, config, telemetry)
    : serviceRuntime(service, config, telemetry, env, suppliedResults));
  return {
    config,
    dependencies: {
      ...runtime, ...(options.handler ? { handler: options.handler } : {}), ...(reportHealth ? { reportHealth } : {}),
    },
  };
}

async function reportInitializationFailure(
  service: ServiceConfig, probes: Probe[], reportHealth: HealthReporter | undefined, telemetry: Telemetry, error: unknown, startedAt: number,
  output: ResultOutput,
): Promise<void> {
  const observedAt = Date.now();
  const category = error instanceof ConfigurationError ? "configuration-failure" : categoryOf(error);
  const cycleId = randomUUID();
  telemetry.emit("service-initialization-failed", {
    cycleId, category, probeCount: probes.length,
    errorType: error instanceof Error ? error.name : "unknown",
    ...(error instanceof ConfigurationError ? { message: error.message } : {}),
  });
  const results = probes.map(probe => resultSchema.parse({
    ...baseResult(probe, observedAt),
    durationMs: Math.max(0, observedAt - startedAt),
    diagnosticCategory: category,
    diagnosticContext: { testStage: "initialization" },
  }));
  const outputErrors: unknown[] = [];
  for (const result of results) {
    try { output.record(result, service.mode); }
    catch (outputError) {
      outputErrors.push(outputError);
      telemetry.emit("result-output-failed", { cycleId, category: categoryOf(outputError) });
    }
  }
  try { await reportHealth?.({ cycleId, results }); }
  catch (error) { outputErrors.push(error); }
  throwFailures(outputErrors);
}

function throwFailures(errors: unknown[]): void {
  const distinct = [...new Set(errors)];
  if (distinct.length === 1) throw distinct[0];
  if (distinct.length > 1) throw new AggregateError(distinct, "Multiple service worker operations failed");
}

async function collectServiceProviders(
  service: ServiceConfig, options: WorkerOptions, results: ResultOutput, signal: AbortSignal,
  telemetry: Telemetry, env: NodeJS.ProcessEnv,
): Promise<ProviderCollectionSummary | undefined> {
  if (!options.providers) return undefined;
  let graph: ReturnType<typeof providerGraphClient>;
  const errors: unknown[] = [];
  try { graph = providerGraphClient(service, env); }
  catch (error) { errors.push(error); }
  // A failed Graph setup still produces the collector's sanitized per-source failure records.
  let providers: ProviderCollectionSummary | undefined;
  try {
    providers = await options.providers({ service, results, signal, ...(graph ? { graph } : {}) });
    telemetry.emit("service-provider-summary", { providers });
  } catch (error) { errors.push(error); }
  throwFailures(errors);
  return providers;
}

async function executeServiceCycle(
  service: ServiceConfig, initialization: Promise<InitializedService>,
  options: WorkerOptions, signal: AbortSignal, telemetry: Telemetry,
  env: NodeJS.ProcessEnv, results: ResultOutput, reportHealth: HealthReporter | undefined,
  initializationFailed: (error: unknown) => Promise<void>,
): Promise<void> {
  const providerCollection = (options.providers || service.serviceHealth) ? Promise.resolve().then(async () => {
    const cycleId = randomUUID();
    const providerDiagnostics: ProviderDiagnostic[] = [];
    const providerOutput: ResultOutput = {
      record: results.record.bind(results),
      recordDiagnostic(raw) {
        const record = providerDiagnosticSchema.parse(raw);
        providerDiagnostics.push(record);
        results.recordDiagnostic(record);
      },
    };
    const errors: unknown[] = [];
    let summary: ProviderCollectionSummary | undefined;
    try {
      if (!options.providers) throw new ConfigurationError("Configured provider sources require the service-owned collector");
      summary = await collectServiceProviders(service, options, providerOutput, signal, telemetry, env);
    } catch (error) {
      errors.push(error);
      try {
        providerOutput.recordDiagnostic({
          kind: "failure", service: service.type, source: "serviceAnnouncement.healthOverviews", apiVersion: "v1.0",
          collectedAt: new Date().toISOString(), category: error instanceof ConfigurationError ? "configuration-failure" : categoryOf(error),
          ...(error instanceof IntegrationError && error.status !== undefined ? { httpStatus: error.status } : {}),
        });
      } catch (outputError) { errors.push(outputError); }
    }
    try { await reportHealth?.({ cycleId, providerDiagnostics }); }
    catch (error) { errors.push(error); }
    throwFailures(errors);
    return summary;
  }) : Promise.resolve(undefined);
  const execute = options.execute ?? runCycle;
  const [journeyExecution, providerExecution] = await Promise.allSettled([
    initialization.then(
      ({ config, dependencies }) => execute(config, dependencies, signal),
      async error => {
        try { await initializationFailed(error); }
        catch (publicationError) {
          throw new AggregateError([error, publicationError], "Multiple service worker operations failed");
        }
        throw error;
      },
    ),
    providerCollection,
  ]);
  const errors: unknown[] = [];
  for (const execution of [journeyExecution, providerExecution]) {
    if (execution.status === "rejected") errors.push(execution.reason);
  }
  throwFailures(errors);
  if (journeyExecution.status !== "fulfilled" || providerExecution.status !== "fulfilled") return;
  const cycle = journeyExecution.value;
  const providers = providerExecution.value;
  telemetry.emit("service-cycle-summary", {
    cycleId: cycle.cycleId, probeCount: cycle.results.length,
    ...(providers ? { providers } : {}),
  });
}

export async function runServiceWorker(raw: ServiceConfig, options: WorkerOptions = {}): Promise<void> {
  const parsed = parseServiceConfig(raw);
  const service = options.project ? applyProjectConfig(options.project, parsed) : parsed;
  if (options.expectedService && service.type !== options.expectedService) {
    throw new ConfigurationError(`This worker only accepts ${options.expectedService} configs`);
  }
  const output = options.telemetry ?? consoleTelemetry;
  const metadata = {
    type: service.type, mode: service.mode, cohort: service.cohort,
    simulation: service.mode === "simulation",
    durationMeaning: service.mode === "simulation" ? "modeled-not-measured-latency" : "measured-probe-duration",
  };
  const telemetry: Telemetry = { emit: (event, data) => output.emit(event, { ...data, ...metadata }) };
  if (!service.enabled) {
    telemetry.emit("service-worker-disabled", { probeCount: 0 });
    return;
  }
  const env = options.env ?? process.env;
  const configuredProbes = serviceProbes(service, options.project?.services[service.type].scenarios);
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) return;
  validateRuntimeConsent(service, env);
  const reportHealth = options.project ? createHealthReporter(options.project, service, telemetry, env) : undefined;
  const results = createResultOutput(telemetry);
  let initialized: InitializedService | undefined;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort }));
  const interval = service.intervalSeconds * 1000;
  let origin = 0;
  let slot = 0;
  const workerErrors: unknown[] = [];
  try {
    if ((!reportHealth || service.mode !== "live") && !service.serviceHealth && !service.serviceActivity.enabled) {
      initialized = await initializeService(service, options, telemetry, env, reportHealth, results);
    }
    origin = now();
    telemetry.emit("service-worker-started", {
      intervalSeconds: service.intervalSeconds, timeoutSeconds: service.timeoutSeconds, once: options.once ?? false,
      probeCount: configuredProbes.length,
    });
    while (!signal.aborted) {
      try {
        const startedAt = Date.now();
        const initializationFailed = async (error: unknown) => {
          if (!signal.aborted) {
            await reportInitializationFailure(
              service, configuredProbes, reportHealth, telemetry, error, startedAt, results,
            );
          }
        };
        const initialization = initialized ? Promise.resolve(initialized)
          : initializeService(service, options, telemetry, env, reportHealth, results).then(value => {
            initialized = value;
            return value;
          });
        await executeServiceCycle(
          service, initialization, options, signal, telemetry, env,
          results, reportHealth,
          initializationFailed,
        );
      } catch (error) {
        if (signal.aborted && !options.once) break;
        telemetry.emit("service-cycle-failed", {
          category: error instanceof ConfigurationError ? "configuration-failure" : categoryOf(error),
          probeCount: configuredProbes.length,
        });
        if (options.once) throw error;
      }
      if (options.once || signal.aborted) break;
      slot++;
      const due = origin + slot * interval;
      const skipped = Math.max(0, Math.ceil((now() - due) / interval));
      if (skipped) {
        slot += skipped;
        telemetry.emit("service-slots-skipped", { skipped, intervalSeconds: service.intervalSeconds });
      }
      await sleep(Math.max(0, origin + slot * interval - now()), signal);
    }
  } catch (error) {
    if (options.once || !signal.aborted) workerErrors.push(error);
  } finally {
    telemetry.emit("service-worker-stopped", { cancelled: signal.aborted });
  }
  throwFailures(workerErrors);
}
