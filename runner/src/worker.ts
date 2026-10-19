import { setTimeout as delay } from "node:timers/promises";
import { RecordingSink } from "../../health-model/src/ahm.js";
import { ConfigurationError, type Config } from "./config.js";
import { consoleTelemetry, type Telemetry } from "../../shared/src/contracts.js";
import { categoryOf } from "../../shared/src/http.js";
import { runCycle, type RunnerDependencies } from "./runner.js";
import { serviceRuntime } from "./runtime.js";
import { parseServiceConfig, serviceSettings, type ServiceConfig } from "./service-config.js";

export function parseWorkerArguments(args: readonly string[]) {
  let config: string | undefined;
  let once = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--config" && !config && args[index + 1] && !args[index + 1]!.startsWith("--")) {
      config = args[++index];
    } else if (argument === "--once" && !once) once = true;
    else throw new ConfigurationError("Usage: npm run probe -- --config <service-config.json> [--once]");
  }
  if (!config) throw new ConfigurationError("An explicit --config is required. Usage: npm run probe -- --config <service-config.json> [--once]");
  return { config, once };
}

export interface WorkerOptions {
  once?: boolean;
  signal?: AbortSignal;
  telemetry?: Telemetry;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  createDependencies?: (service: ServiceConfig, config: Config, telemetry: Telemetry) => RunnerDependencies;
  execute?: typeof runCycle;
}

export async function runServiceWorker(raw: ServiceConfig, options: WorkerOptions = {}): Promise<void> {
  const service = parseServiceConfig(raw);
  const output = options.telemetry ?? consoleTelemetry;
  const metadata = {
    type: service.type, mode: service.mode, entity: service.cohort, reportingEnabled: service.reportToHealthModel,
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
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) return;
  const dependencies = options.createDependencies
    ? options.createDependencies(service, config, telemetry)
    : serviceRuntime(service, config, telemetry, env);
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort }));
  const execute = options.execute ?? runCycle;
  const interval = service.intervalSeconds * 1000;
  const origin = now();
  let slot = 0;
  telemetry.emit("service-worker-started", {
    intervalSeconds: service.intervalSeconds, timeoutSeconds: service.timeoutSeconds, once: options.once ?? false,
    probeCount: config.probes.length,
  });
  try {
    while (!signal.aborted) {
      try {
        if (dependencies.sink instanceof RecordingSink) dependencies.sink.reports.length = 0;
        const cycle = await execute(config, dependencies, signal);
        telemetry.emit("service-cycle-summary", {
          cycleId: cycle.cycleId, state: cycle.reports[0]?.state ?? "Unknown", probeCount: cycle.results.length,
        });
      } catch (error) {
        if (signal.aborted) break;
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
    if (!signal.aborted) throw error;
  } finally {
    telemetry.emit("service-worker-stopped", { cancelled: signal.aborted });
  }
}
