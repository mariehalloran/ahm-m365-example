import { setTimeout as delay } from "node:timers/promises";
import { ConfigurationError, type Config } from "./config.js";
import { consoleTelemetry, type Telemetry } from "./contracts.js";
import { categoryOf } from "./http.js";
import type { ProbeHandler } from "./probes.js";
import { runCycle, type RunnerDependencies } from "./runner.js";
import { serviceRuntime } from "./runtime.js";
import { parseServiceConfig, serviceSettings, type ServiceConfig } from "./service-config.js";
import type { ProviderCollector } from "./provider-collection.js";
import { applyProjectConfig, type ProjectConfig } from "./project-config.js";
import { createHealthReporter } from "./health-reports.js";

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

async function executeServiceCycle(
  service: ServiceConfig, config: Config, dependencies: RunnerDependencies,
  options: WorkerOptions, signal: AbortSignal, telemetry: Telemetry,
): Promise<void> {
  const providerCollection = Promise.resolve().then(() => options.providers?.({
    service, results: dependencies.results, signal,
    ...(dependencies.graph ? { graph: dependencies.graph } : {}),
  }));
  const execute = options.execute ?? runCycle;
  const [journeyExecution, providerExecution] = await Promise.allSettled([
    execute(config, dependencies, signal),
    providerCollection,
  ]);
  if (journeyExecution.status === "rejected") throw journeyExecution.reason;
  if (providerExecution.status === "rejected") throw providerExecution.reason;
  const cycle = journeyExecution.value;
  const providers = providerExecution.value;
  if (providers && providers.configured > 0) await dependencies.results.forceFlush();
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
    type: service.type, mode: service.mode, cohort: service.cohort, telemetry: service.telemetry,
    simulation: service.mode === "simulation",
    durationMeaning: service.mode === "simulation" ? "modeled-not-measured-latency" : "measured-probe-duration",
  };
  const telemetry: Telemetry = { emit: (event, data) => output.emit(event, { ...data, ...metadata }) };
  if (!service.enabled) {
    telemetry.emit("service-worker-disabled", { probeCount: 0 });
    return;
  }
  const env = options.env ?? process.env;
  const config = serviceSettings(service, env);
  if ((service.serviceHealth || service.serviceActivity.enabled) && !options.providers) {
    throw new ConfigurationError("Configured provider sources require the service-owned collector");
  }
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) return;
  const reportHealth = options.project ? createHealthReporter(options.project, service, telemetry, env) : undefined;
  const runtime = await (options.createDependencies
    ? options.createDependencies(service, config, telemetry)
    : serviceRuntime(service, config, telemetry, env));
  const dependencies: RunnerDependencies = {
    ...runtime, ...(options.handler ? { handler: options.handler } : {}), ...(reportHealth ? { reportHealth } : {}),
  };
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort }));
  const interval = service.intervalSeconds * 1000;
  let origin = 0;
  let slot = 0;
  try {
    origin = now();
    telemetry.emit("service-worker-started", {
      intervalSeconds: service.intervalSeconds, timeoutSeconds: service.timeoutSeconds, once: options.once ?? false,
      probeCount: config.probes.length,
    });
    while (!signal.aborted) {
      try {
        await executeServiceCycle(service, config, dependencies, options, signal, telemetry);
      } catch (error) {
        if (signal.aborted && !options.once) break;
        telemetry.emit("service-cycle-failed", { category: categoryOf(error), probeCount: config.probes.length });
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
    if (options.once || !signal.aborted) throw error;
  } finally {
    try { await dependencies.results.shutdown(); }
    finally { telemetry.emit("service-worker-stopped", { cancelled: signal.aborted }); }
  }
}
