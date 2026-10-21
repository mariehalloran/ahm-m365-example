import type { TokenCredential } from "@azure/identity";
import { createServiceCredential } from "./auth.js";
import { probeServices, type StepName, type SyntheticResult, type Telemetry } from "./contracts.js";
import { AuthenticatedHttp, categoryOf, IntegrationError, type HttpOptions } from "./http.js";
import type { ProjectConfig } from "./project-config.js";
import type { ServiceConfig } from "./service-config.js";

const MAX_CONCURRENT_REPORTS = 3;
const REPORT_TIMEOUT_MS = 5000;
const REPORT_BATCH_TIMEOUT_MS = 30000;

type HealthState = "Healthy" | "Degraded" | "Unhealthy" | "Unknown";
type Policy = ProjectConfig["healthModel"];
interface EvaluationRules {
  degradedRule: { operator: "LessThan" | "GreaterThan"; threshold: number };
  unhealthyRule: { operator: "LessThan" | "GreaterThan"; threshold: number };
}
export interface HealthReport {
  entityName: string;
  body: {
    signalName: "synthetic-success-percentage" | "synthetic-mean-duration";
    healthState: HealthState;
    expiresInMinutes: number;
    additionalContext: string;
    value?: number;
    evaluationRules?: EvaluationRules;
  };
}
export interface CycleResults { cycleId: string; results: SyntheticResult[] }
export type HealthReporter = (cycle: CycleResults) => Promise<void>;

interface MeasurementSample {
  success: boolean;
  durationMs: number;
}
interface EntitySamples {
  entityName: string;
  samples: MeasurementSample[];
  skipped: number;
}
interface Measurement {
  signalName: HealthReport["body"]["signalName"];
  rules: EvaluationRules;
  value: number | undefined;
}
interface PublicationContext {
  http: AuthenticatedHttp;
  modelPath: string;
  cycleId: string;
  telemetry: Telemetry;
}

function evaluateHealthState(value: number, rules: EvaluationRules): HealthState {
  const breaches = (rule: EvaluationRules["unhealthyRule"]) =>
    rule.operator === "LessThan" ? value < rule.threshold : value > rule.threshold;
  if (breaches(rules.unhealthyRule)) return "Unhealthy";
  if (breaches(rules.degradedRule)) return "Degraded";
  return "Healthy";
}

function collectActionSamples(name: StepName, results: SyntheticResult[]): MeasurementSample[] {
  const samples: MeasurementSample[] = [];
  for (const result of results) {
    for (const step of result.steps) {
      if (step.name !== name || step.status === "skipped") continue;
      samples.push({ success: step.status === "succeeded", durationMs: step.durationMs });
    }
  }
  return samples;
}

function collectEntitySamples(service: ServiceConfig["type"], results: SyntheticResult[]): EntitySamples[] {
  const journey = Object.values(probeServices).find(item => item.service === service)!;
  return [
    {
      entityName: `${service}-global`,
      samples: results.map(result => ({ success: result.success, durationMs: result.durationMs })),
      skipped: 0,
    },
    ...journey.steps.map(name => {
      const samples = collectActionSamples(name, results);
      return { entityName: `${service}-${name}`, samples, skipped: results.length - samples.length };
    }),
  ];
}

function createMeasurementReport(
  entityName: string, measurement: Measurement, context: string, ttlMinutes: number,
): HealthReport {
  return {
    entityName,
    body: {
      signalName: measurement.signalName, expiresInMinutes: ttlMinutes, additionalContext: context,
      healthState: measurement.value === undefined ? "Unknown" : evaluateHealthState(measurement.value, measurement.rules),
      ...(measurement.value === undefined ? {} : { value: measurement.value, evaluationRules: measurement.rules }),
    },
  };
}

function createEntityReports(group: EntitySamples, cycleId: string, policy: Policy): HealthReport[] {
  const attempted = group.samples.length;
  const succeeded = group.samples.filter(sample => sample.success).length;
  const context = JSON.stringify({
    aggregation: "single-cycle", cycleId, attempted, succeeded, skipped: group.skipped,
  });
  const successRules: EvaluationRules = {
    degradedRule: { operator: "LessThan", threshold: policy.successDegradedPercent },
    unhealthyRule: { operator: "LessThan", threshold: policy.successUnhealthyPercent },
  };
  const durationRules: EvaluationRules = {
    degradedRule: { operator: "GreaterThan", threshold: policy.latencyDegradedMilliseconds },
    unhealthyRule: { operator: "GreaterThan", threshold: policy.latencyUnhealthyMilliseconds },
  };
  const measurements: Measurement[] = [
    {
      signalName: "synthetic-success-percentage", rules: successRules,
      value: attempted ? 100 * succeeded / attempted : undefined,
    },
    {
      signalName: "synthetic-mean-duration", rules: durationRules,
      value: attempted ? group.samples.reduce((sum, sample) => sum + sample.durationMs, 0) / attempted : undefined,
    },
  ];
  return measurements.map(measurement => createMeasurementReport(group.entityName, measurement, context, policy.reportTtlMinutes));
}

export function aggregateHealthReports(
  service: ServiceConfig["type"], cycle: CycleResults, policy: Policy,
): HealthReport[] {
  return collectEntitySamples(service, cycle.results).flatMap(group =>
    createEntityReports(group, cycle.cycleId, policy));
}

async function sendHealthReport(context: PublicationContext, report: HealthReport, signal: AbortSignal): Promise<void> {
  const response = await context.http.request(
    `${context.modelPath}/entities/${encodeURIComponent(report.entityName)}/ingestHealthReport?api-version=2026-05-01-preview`,
    { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report.body) },
    signal,
  );
  await response.body?.cancel();
  if (response.status !== 204) throw new IntegrationError("collector-failure", response.status);
}

async function publishHealthReports(reports: HealthReport[], context: PublicationContext): Promise<void> {
  const signal = AbortSignal.timeout(REPORT_BATCH_TIMEOUT_MS);
  let nextReport = 0;
  let failures = 0;
  const sendNext = async () => {
    while (nextReport < reports.length) {
      const report = reports[nextReport++]!;
      const metadata = {
        cycleId: context.cycleId, entityName: report.entityName, signalName: report.body.signalName,
      };
      try {
        await sendHealthReport(context, report, signal);
        context.telemetry.emit("health-report-published", metadata);
      } catch (error) {
        failures++;
        context.telemetry.emit("health-report-failed", {
          ...metadata, category: categoryOf(error),
          ...(error instanceof IntegrationError ? { status: error.status } : {}),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_REPORTS, reports.length) }, sendNext));
  if (failures) throw new IntegrationError("collector-failure");
}

export function createHealthReporter(
  project: ProjectConfig, service: ServiceConfig, telemetry: Telemetry, env: NodeJS.ProcessEnv,
  options: HttpOptions & { credential?: TokenCredential } = {},
): HealthReporter {
  const policy = project.healthModel;
  const http = service.mode === "live" ? new AuthenticatedHttp(
    options.credential ?? createServiceCredential(env, service.graphAuthentication, "health-report"),
    "https://management.azure.com/.default", { ...options, attempts: 2, timeoutMs: REPORT_TIMEOUT_MS },
  ) : undefined;
  const modelName = `${policy.name}-${service.type}`;
  const modelPath = `https://management.azure.com/subscriptions/${encodeURIComponent(policy.subscriptionId)}`
    + `/resourceGroups/${encodeURIComponent(policy.resourceGroup)}/providers/Microsoft.CloudHealth/healthmodels/${encodeURIComponent(modelName)}`;
  return async cycle => {
    const reports = aggregateHealthReports(service.type, cycle, policy);
    if (!http) {
      for (const report of reports) telemetry.emit("health-report-preview", { modelName, ...report });
      return;
    }
    await publishHealthReports(reports, { http, modelPath, telemetry, cycleId: cycle.cycleId });
  };
}
