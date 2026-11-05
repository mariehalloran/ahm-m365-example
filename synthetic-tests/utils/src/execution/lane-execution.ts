import { randomUUID } from "node:crypto";
import { ConfigurationError, filterRuntimeProbes, type Config } from "../configuration/config.js";
import { resultContext } from "../configuration/groups.js";
import type { ProjectConfig } from "../configuration/project-config.js";
import { hasProviderSources, serviceSettings, type ServiceConfig } from "../configuration/service-config.js";
import { consoleTelemetry, probeServices, resultSchema, type Probe, type Telemetry } from "../contracts.js";
import { categoryOf, IntegrationError, withAbort } from "../integrations/http.js";
import { activityFunctions } from "../providers/provider-catalog.js";
import type { ProviderCollector, ProviderCollectionSummary } from "../providers/provider-collection.js";
import { providerDiagnosticSchema, type ProviderDiagnostic } from "../providers/provider-diagnostics.js";
import { createProviderReporter } from "../providers/provider-health-reports.js";
import { createExecutionReporter, type ExecutionCorrelation } from "../reporting/execution-reporter.js";
import { createResultOutput, type ResultOutput } from "../reporting/results.js";
import { laneBudget, type ExecutionLane } from "./execution-lanes.js";
import { baseResult, type ProbeHandler } from "./probes.js";
import { runCycle, type RunnerDependencies } from "./runner.js";
import { providerGraphClient, serviceRuntime, validateProjectTenantBinding, validateRuntimeConsent } from "./runtime.js";
import { createTeamsCallbackState } from "../integrations/teams-callback-state.js";

export interface LaneOptions {
  project: ProjectConfig;
  handler: ProbeHandler;
  providers?: ProviderCollector;
  selectedProbe?: Pick<Probe, "type" | "id">;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  telemetry?: Telemetry;
  slotStart?: number;
  correlation?: ExecutionCorrelation;
  createDependencies?: typeof serviceRuntime;
}
export class UnsettledExecutionError extends Error {
  constructor() { super("A cancelled journey did not settle; execution ownership requires operator reconciliation"); }
}

/** Re-throws every independent execution/reporting failure without fabricating a synthetic failure. */
function throwFailures(errors: unknown[]): void {
  const distinct = [...new Set(errors)];
  if (distinct.length === 1) throw distinct[0];
  if (distinct.length) throw new AggregateError(distinct, "Execution lane operations failed");
}

/** Executes one lane in its Function, streaming completed actions and finally draining publication. */
export async function executeServiceLane(service: ServiceConfig, lane: ExecutionLane, options: LaneOptions): Promise<void> {
  const env = options.env ?? process.env;
  const telemetry = options.telemetry ?? consoleTelemetry;
  const signal = options.signal ?? new AbortController().signal;
  validateProjectTenantBinding(options.project.tenant, service, env);
  validateRuntimeConsent(service, env);
  const slotStart = options.slotStart ?? Date.now();
  const { slotEnd } = laneBudget(service, lane, slotStart);
  const hardDeadline = AbortSignal.timeout(Math.max(1, slotEnd - Date.now()));
  const laneSignal = AbortSignal.any([signal, hardDeadline]);
  const cycleId = options.correlation?.cycleId ?? randomUUID();
  const reporter = createExecutionReporter(options.project, service, telemetry, env, {
    signal: hardDeadline, ...(options.correlation ? { correlation: options.correlation } : {}),
  });
  const results = createResultOutput(telemetry, result => resultContext(options.project, result));
  const laneConfig = filterRuntimeProbes(serviceSettings(service, env, options.project.services[service.type].scenarios),
    probe => lane.journeys.includes(probeServices[probe.type].journey));
  const config = options.selectedProbe ? filterRuntimeProbes(laneConfig,
    probe => probe.type === options.selectedProbe!.type && probe.id === options.selectedProbe!.id) : laneConfig;
  if (!config.probes.length) throw new ConfigurationError("Dispatch probe is not selected in the configured lane");
  const runConfig: Config = config.EXECUTION_MODE === "live"
    ? { ...config, probes: config.probes, INTERVAL_MS: lane.intervalSeconds * 1000, PROBE_TIMEOUT_MS: lane.timeoutSeconds * 1000 }
    : { ...config, probes: config.probes, INTERVAL_MS: lane.intervalSeconds * 1000, PROBE_TIMEOUT_MS: lane.timeoutSeconds * 1000 };
  let dependencies: RunnerDependencies | undefined;
  let initialized = false;
  const errors: unknown[] = [];
  let unsettled = false;
  try {
    const initializationDeadline = AbortSignal.timeout(Math.max(1, slotEnd - Date.now()
      - (lane.timeoutSeconds + service.cleanupGraceSeconds + service.publicationTimeoutSeconds) * 1000));
    const teamsCallState = service.type === "teams" && service.mode === "live" &&
      config.probes.some(probe => probe.type === "teams-call")
      ? createTeamsCallbackState(options.project, env, cycleId, slotEnd, error => { errors.push(error); }) : undefined;
    dependencies = await withAbort(AbortSignal.any([laneSignal, initializationDeadline]), () =>
      (options.createDependencies ?? serviceRuntime)(service, runConfig, telemetry, env, results, {
        ...(teamsCallState ? { teamsCallState } : {}),
      }));
    initialized = true;
    const budget = laneBudget(service, lane, slotStart);
    const cycleConfig: Config = runConfig.EXECUTION_MODE === "live"
      ? { ...runConfig, probes: runConfig.probes, CYCLE_TIMEOUT_MS: budget.executionMs }
      : { ...runConfig, probes: runConfig.probes, CYCLE_TIMEOUT_MS: budget.executionMs };
    await runCycle(cycleConfig, {
      ...dependencies, handler: options.handler, reporter, cycleId, publicationSignal: hardDeadline,
      onUnsettledAttempt: () => { unsettled = true; },
      capacityGroups: options.project.groups.filter(group => group.service === service.type)
        .map(group => ({ id: group.id, displayName: group.displayName, targetIds: group.targetIds })),
    }, laneSignal);
  } catch (error) {
    errors.push(error);
    if (!initialized) {
      const observedAt = Date.now();
      const category = signal.aborted ? "cancelled" : error instanceof ConfigurationError ? "configuration-failure" : categoryOf(error);
      telemetry.emit("service-initialization-failed", { cycleId, category, probeCount: config.probes.length });
      for (const probe of config.probes) {
        const result = resultSchema.parse({
          ...baseResult(probe, observedAt), durationMs: Math.max(0, observedAt - slotStart),
          diagnosticCategory: category, diagnosticContext: { testStage: "initialization" },
        });
        results.record(result, service.mode);
        try { await reporter.journey(result); }
        catch (publicationError) { errors.push(publicationError); }
      }
    }
  } finally {
    const publicationSignal = AbortSignal.any([
      hardDeadline, AbortSignal.timeout(service.publicationTimeoutSeconds * 1000),
    ]);
    try { await reporter.finish(publicationSignal); }
    catch (error) { errors.push(error); }
    try { await dependencies?.shutdown?.(); }
    catch (error) { errors.push(error); }
  }
  if (unsettled) errors.push(new UnsettledExecutionError());
  throwFailures(errors);
}

/** Collects provider evidence on its own cadence, preserving per-source failures and explicit Unknown. */
async function collectServiceProviders(
  service: ServiceConfig, options: LaneOptions, results: ResultOutput, signal: AbortSignal, collectedAt: number,
): Promise<ProviderCollectionSummary | undefined> {
  const env = options.env ?? process.env;
  const telemetry = options.telemetry ?? consoleTelemetry;
  if (!options.providers) throw new ConfigurationError("Configured provider sources require the service-owned collector");
  let graph: ReturnType<typeof providerGraphClient>;
  const errors: unknown[] = [];
  try { graph = providerGraphClient(service, env); }
  catch (error) { errors.push(error); }
  let summary: ProviderCollectionSummary | undefined;
  try {
    summary = await options.providers({ service, results, signal, now: () => collectedAt, ...(graph ? { graph } : {}) });
    telemetry.emit("service-provider-summary", { providers: summary });
  } catch (error) { errors.push(error); }
  throwFailures(errors);
  return summary;
}

/** Publishes supporting provider context independently of synthetic outcomes and Experience rollup. */
export async function executeProviderLane(service: ServiceConfig, options: LaneOptions): Promise<void> {
  if (!hasProviderSources(service)) throw new ConfigurationError("No provider sources are selected for this lane");
  const telemetry = options.telemetry ?? consoleTelemetry;
  const env = options.env ?? process.env;
  validateProjectTenantBinding(options.project.tenant, service, env);
  validateRuntimeConsent(service, env);
  const slotStart = options.slotStart ?? Date.now();
  const slotEnd = slotStart + (service.providerIntervalSeconds - service.slotMarginSeconds) * 1000;
  const collectionEnd = slotEnd - service.publicationTimeoutSeconds * 1000;
  if (Date.now() >= collectionEnd || Date.now() < slotStart) throw new ConfigurationError("Provider dispatch is stale");
  const hardDeadline = AbortSignal.timeout(Math.max(1, slotEnd - Date.now()));
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(Math.max(1, collectionEnd - Date.now())),
  ]);
  const cycleId = options.correlation?.cycleId ?? randomUUID();
  const collectedAt = Date.now();
  const providerDiagnostics: ProviderDiagnostic[] = [];
  const output = createResultOutput(telemetry);
  const results: ResultOutput = {
    record: output.record,
    recordDiagnostic(raw) {
      const diagnostic = providerDiagnosticSchema.parse(raw);
      providerDiagnostics.push(diagnostic);
      output.recordDiagnostic(diagnostic);
    },
  };
  const errors: unknown[] = [];
  try { await collectServiceProviders(service, options, results, signal, collectedAt); }
  catch (error) {
    errors.push(error);
    const source = service.serviceHealth ? "serviceAnnouncement.healthOverviews" : service.serviceMessages
      ? "serviceAnnouncement.messages" : (service.serviceActivity.functions ?? activityFunctions[service.type])[0];
    if (source && !providerDiagnostics.some(record => record.kind === "failure" && record.source === source)) {
      results.recordDiagnostic({
        kind: "failure", service: service.type, source, apiVersion: source.startsWith("serviceAnnouncement.") ? "v1.0" : "beta",
        collectedAt: new Date(collectedAt).toISOString(), category: error instanceof ConfigurationError ? "configuration-failure" : categoryOf(error),
        ...(error instanceof IntegrationError && error.status !== undefined ? { httpStatus: error.status } : {}),
      });
    }
  }
  const publicationSignal = AbortSignal.any([hardDeadline, AbortSignal.timeout(service.publicationTimeoutSeconds * 1000)]);
  try {
    await createProviderReporter(options.project, service, telemetry, env)({
      cycleId, collectedAt: new Date(collectedAt).toISOString(), providerDiagnostics, signal: publicationSignal,
    });
  } catch (error) { errors.push(error); }
  throwFailures(errors);
}
