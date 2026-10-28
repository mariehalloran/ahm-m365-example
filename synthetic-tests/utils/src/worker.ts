import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigurationError, type Config } from "./config.js";
import { consoleTelemetry, probeServices, resultSchema, type Probe, type Telemetry } from "./contracts.js";
import { categoryOf, IntegrationError, withAbort } from "./http.js";
import { baseResult, type ProbeHandler } from "./probes.js";
import { runCycle, type RunnerDependencies } from "./runner.js";
import { providerGraphClient, serviceRuntime, validateProjectTenantBinding, validateRuntimeConsent } from "./runtime.js";
import { parseServiceConfig, serviceProbes, serviceSettings, type ServiceConfig } from "./service-config.js";
import type { ProviderCollectionSummary, ProviderCollector } from "./provider-collection.js";
import { applyProjectConfig, type ProjectConfig } from "./project-config.js";
import { createHealthReporter, type HealthReporter } from "./health-reports.js";
import { createResultOutput, type ResultOutput } from "./results.js";
import { providerDiagnosticSchema, type ProviderDiagnostic } from "./provider-diagnostics.js";
import type { ResultTelemetry } from "./otel.js";
import { executionLanes, runExecutionLanes } from "./execution-lanes.js";
import { resultContext } from "./groups.js";
import { canonicalProjectFile } from "./paths.js";

const usage = "Usage: npm run <exchange|teams|onedrive> -- [--config <monitoring.config.json>] [--tenant <alias>] [--once]";

export function parseWorkerArguments(args: readonly string[]) {
  let config: string | undefined;
  let tenant: string | undefined;
  let once = false;
  const hasValue = (index: number) => args[index + 1] !== undefined && !args[index + 1]!.startsWith("--");
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--config" && !config && hasValue(index)) config = args[++index];
    else if (argument === "--tenant" && !tenant && hasValue(index)) tenant = args[++index];
    else if (argument === "--once" && !once) once = true;
    else throw new ConfigurationError(usage);
  }
  return { config: config ?? canonicalProjectFile, once, ...(tenant ? { tenant } : {}) };
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
  createOtel?: (destination: ProjectConfig["otel"]["destination"], output: Telemetry, env: NodeJS.ProcessEnv) => Promise<ResultTelemetry>;
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
      ...(service.type === "exchange" && options.project ? {
        capacityGroups: options.project.groups.filter(group => group.service === "exchange").map(group => ({
          id: group.id, displayName: group.displayName, targetIds: group.targetIds,
        })),
      } : {}),
    },
  };
}

async function reportInitializationFailure(
  service: ServiceConfig, probes: Probe[], reportHealth: HealthReporter | undefined, telemetry: Telemetry, error: unknown, startedAt: number,
  output: ResultOutput, signal: AbortSignal, capacityGroups?: RunnerDependencies["capacityGroups"],
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
  if (service.type === "exchange") {
    for (const group of capacityGroups ?? [{ id: "ungrouped", displayName: "Ungrouped", targetIds: probes.map(probe => probe.id) }]) {
      const count = probes.filter(probe => group.targetIds.includes(probe.id)).length;
      if (count) telemetry.emit("exchange-minute-capacity", {
        cycleId, groupId: group.id, group: group.displayName, expectedAttempts: count,
        startedAttempts: 0, completedAttempts: count, timedOutAttempts: 0,
        graphRequests: 0, permitWaitRequests: 0, permitWaitMs: 0,
        interpretation: "runner-capacity-not-exchange-availability",
      });
    }
  }
  const outputErrors: unknown[] = [];
  for (const result of results) {
    try { output.record(result, service.mode); }
    catch (outputError) {
      outputErrors.push(outputError);
      telemetry.emit("result-output-failed", { cycleId, category: categoryOf(outputError) });
    }
  }
  const publicationSignal = AbortSignal.any([signal, AbortSignal.timeout(service.type === "exchange" ? 12000 : 30000)]);
  try { await withAbort(publicationSignal, async () => reportHealth?.({ cycleId, results, signal: publicationSignal })); }
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

export async function collectAndReportServiceProviders(
  service: ServiceConfig,
  options: WorkerOptions, signal: AbortSignal, telemetry: Telemetry,
  env: NodeJS.ProcessEnv, results: ResultOutput, reportHealth: HealthReporter | undefined,
): Promise<ProviderCollectionSummary | undefined> {
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
}

async function executeServiceCycle(
  initialization: Promise<InitializedService>, options: WorkerOptions,
  signal: AbortSignal, telemetry: Telemetry, initializationFailed: (error: unknown) => Promise<void>,
): Promise<void> {
  const execute = options.execute ?? runCycle;
  const cycle = await initialization.then(
    ({ config, dependencies }) => execute(config, dependencies, signal),
    async error => {
      try { await initializationFailed(error); }
      catch (publicationError) {
        throw new AggregateError([error, publicationError], "Multiple service worker operations failed");
      }
      throw error;
    },
  );
  telemetry.emit("service-cycle-summary", {
    cycleId: cycle.cycleId, probeCount: cycle.results.length,
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
  validateProjectTenantBinding(options.project?.tenant, service, env);
  const configuredProbes = serviceProbes(service, options.project?.services[service.type].scenarios);
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) return;
  validateRuntimeConsent(service, env);
  const reportHealth = options.project ? createHealthReporter(options.project, service, telemetry, env) : undefined;
  const consoleResults = createResultOutput(telemetry);
  let otel: ResultTelemetry | undefined;
  let otelInitializationError: unknown;
  const otelDiagnosticErrors: unknown[] = [];
  if (options.project?.otel.enabled) {
    try {
      const createOtel = options.createOtel ?? (await import("./azure-monitor.js")).createProbeTelemetry;
      otel = await createOtel(options.project.otel.destination, telemetry, env);
    } catch (error) {
      otelInitializationError = error;
      telemetry.emit("telemetry-initialization-failed", {
        category: error instanceof ConfigurationError ? "configuration-failure" : categoryOf(error),
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  const results: ResultOutput = {
    record(result, mode) {
      consoleResults.record(result, mode);
      if (otel && options.project) otel.record(result, mode, resultContext(options.project, result));
    },
    recordDiagnostic(record) {
      consoleResults.recordDiagnostic(record);
      try { otel?.recordDiagnostic(record); }
      catch (error) {
        otelDiagnosticErrors.push(error);
        telemetry.emit("telemetry-output-failed", { category: "collector-failure" });
      }
    },
  };
  let initialized: InitializedService | undefined;
  const now = options.now ?? (service.type === "exchange" ? Date.now : () => performance.now());
  const sleep = options.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort }));
  const workerErrors: unknown[] = [];
  try {
    if ((!reportHealth || service.mode !== "live") && !service.serviceHealth && !service.serviceActivity.enabled) {
      initialized = await initializeService(service, options, telemetry, env, reportHealth, results);
    }
    telemetry.emit("service-worker-started", {
      intervalSeconds: service.intervalSeconds, timeoutSeconds: service.timeoutSeconds, once: options.once ?? false,
      probeCount: configuredProbes.length,
    });
    let initialization: Promise<InitializedService> | undefined;
    const lanes = executionLanes(service).filter(lane =>
      configuredProbes.some(probe => lane.journeys.includes(probeServices[probe.type].journey)));
    const providerLane = {
      name: "provider-context", intervalSeconds: service.providerIntervalSeconds, timeoutSeconds: service.timeoutSeconds, journeys: [],
    };
    if (service.serviceHealth || service.serviceActivity.enabled) lanes.push(providerLane);
    await runExecutionLanes(lanes, async lane => {
      try {
        if (lane === providerLane) {
          const errors: unknown[] = [];
          try { await collectAndReportServiceProviders(service, options, signal, telemetry, env, results, reportHealth); }
          catch (error) { errors.push(error); }
          try { await otel?.forceFlush(); }
          catch (error) { errors.push(error); }
          errors.push(...otelDiagnosticErrors.splice(0));
          if (otelInitializationError) errors.push(otelInitializationError);
          throwFailures(errors);
          return;
        }
        const startedAt = Date.now();
        const minuteBudgetMs = service.type === "exchange"
          ? options.once ? 59000 : Math.max(1, 59000 - startedAt % 60000) : undefined;
        const minuteDeadline = minuteBudgetMs === undefined ? undefined : AbortSignal.timeout(minuteBudgetMs);
        const laneSignal = minuteDeadline ? AbortSignal.any([signal, minuteDeadline]) : signal;
        const laneProbes = configuredProbes.filter(probe => lane.journeys.includes(probeServices[probe.type].journey));
        const initializationFailed = async (error: unknown) => {
          if (!signal.aborted) {
            await reportInitializationFailure(
              service, laneProbes, reportHealth, telemetry, error, startedAt, results, laneSignal,
              options.project?.groups.filter(group => group.service === service.type)
                .map(group => ({ id: group.id, displayName: group.displayName, targetIds: group.targetIds })),
            );
          }
        };
        initialization ??= initialized ? Promise.resolve(initialized)
          : initializeService(service, options, telemetry, env, reportHealth, results).then(value => {
            initialized = value;
            return value;
          }).catch(error => {
            initialization = undefined;
            throw error;
          });
        const laneInitialization = initialization.then(value => ({
          ...value, config: {
            ...value.config, probes: laneProbes, PROBE_TIMEOUT_MS: lane.timeoutSeconds * 1000,
            ...(minuteBudgetMs === undefined ? {} : { CYCLE_TIMEOUT_MS: Math.max(1, Math.min(30000, minuteBudgetMs - 29000)) }),
          },
        }));
        const publicationErrors: unknown[] = [];
        try {
          const execute = () => executeServiceCycle(laneInitialization, options, laneSignal, telemetry, initializationFailed);
          if (minuteDeadline) await withAbort(minuteDeadline, execute);
          else await execute();
        } catch (error) { publicationErrors.push(error); }
        try {
          if (service.type === "exchange") {
            await withAbort(AbortSignal.any([minuteDeadline!, AbortSignal.timeout(5000)]), async () => otel?.forceFlush());
          } else await otel?.forceFlush();
        }
        catch (error) { publicationErrors.push(error); }
        publicationErrors.push(...otelDiagnosticErrors.splice(0));
        if (otelInitializationError) publicationErrors.push(otelInitializationError);
        throwFailures(publicationErrors);
      } catch (error) {
        if (signal.aborted && !options.once) return;
        telemetry.emit("service-cycle-failed", {
          category: error instanceof ConfigurationError ? "configuration-failure" : categoryOf(error),
          probeCount: configuredProbes.length,
        });
        if (options.once) throw error;
      }
    }, { signal, telemetry, once: options.once ?? false, now, sleep });
  } catch (error) {
    if (options.once || !signal.aborted) workerErrors.push(error);
  } finally {
    try { await initialized?.dependencies.shutdown?.(); }
    catch (error) { workerErrors.push(error); }
    try { await otel?.shutdown(); }
    catch (error) { workerErrors.push(error); }
    telemetry.emit("service-worker-stopped", { cancelled: signal.aborted });
  }
  throwFailures(workerErrors);
}
