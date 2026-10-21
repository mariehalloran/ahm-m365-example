import type { TokenCredential } from "@azure/identity";
import { createServiceCredential } from "./auth.js";
import { isReportedStep, probeServices, testTypes, type DiagnosticCategory, type ReportedStepName, type SyntheticResult, type Telemetry } from "./contracts.js";
import { AuthenticatedHttp, categoryOf, IntegrationError, type HttpOptions } from "./http.js";
import type { ProjectConfig } from "./project-config.js";
import type { ServiceConfig } from "./service-config.js";
import { providerDiagnosticSchema, type ProviderDiagnostic } from "./provider-diagnostics.js";

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
    signalName: "synthetic-success-percentage" | "synthetic-mean-duration" | "microsoft-reported-service-status";
    healthState: HealthState;
    expiresInMinutes: number;
    additionalContext: string;
    value?: number;
    evaluationRules?: EvaluationRules;
  };
}
export interface CycleResults { cycleId: string; results: SyntheticResult[] }
export interface ProviderCycle { cycleId: string; providerDiagnostics: ProviderDiagnostic[] }
export type HealthReporter = (cycle: CycleResults | ProviderCycle) => Promise<void>;

interface MeasurementSample {
  success: boolean;
  durationMs: number;
  diagnosticCategory?: DiagnosticCategory;
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

function collectActionSamples(name: ReportedStepName, results: SyntheticResult[]): MeasurementSample[] {
  const samples: MeasurementSample[] = [];
  for (const result of results) {
    for (const step of result.steps) {
      if (step.name !== name || step.status === "skipped") continue;
      samples.push({
        success: step.status === "succeeded", durationMs: step.durationMs,
        ...(step.status === "failed" ? { diagnosticCategory: step.diagnosticCategory } : {}),
      });
    }
  }
  return samples;
}

function collectEntitySamples(service: ServiceConfig["type"], results: SyntheticResult[]): EntitySamples[] {
  const supported = testTypes.filter(type => probeServices[type].service === service);
  const observed = results.length
    ? supported.filter(type => results.some(result => result.testType === type))
    : supported.slice(0, 1);
  return observed.flatMap(testType => {
    const journey = probeServices[testType];
    const journeyResults = results.filter(result => result.testType === testType);
    const groups: EntitySamples[] = [
      {
        entityName: journey.entityName,
        samples: journeyResults.map(result => ({
          success: result.success, durationMs: result.durationMs,
          ...(result.diagnosticCategory ? { diagnosticCategory: result.diagnosticCategory } : {}),
        })),
        skipped: 0,
      },
      ...journey.steps.filter(isReportedStep).map(name => {
        const samples = collectActionSamples(name, journeyResults);
        return {
          entityName: `${journey.entityName}-${name}`, samples,
          skipped: journeyResults.length - samples.length,
        };
      }),
    ];
    return groups;
  });
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
  const diagnosticCategories = [...new Set(group.samples.flatMap(sample =>
    sample.diagnosticCategory ? [sample.diagnosticCategory] : []))];
  const context = JSON.stringify({
    aggregation: "single-cycle", cycleId, attempted, succeeded, skipped: group.skipped,
    ...(diagnosticCategories.length ? { diagnosticCategories } : {}),
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

const serviceStatusScores: Readonly<Record<string, number>> = {
  serviceoperational: 100, servicerestored: 100, resolved: 100, resolvedexternal: 100,
  falsepositive: 100, postincidentreviewpublished: 100,
  serviceinterruption: 0,
  servicedegradation: 50, investigating: 50, restoringservice: 50, verifyingservice: 50,
  extendedrecovery: 50, investigationsuspended: 50, mitigated: 50, mitigatedexternal: 50,
  confirmed: 50, reported: 50,
};

export function serviceHealthReport(
  service: ServiceConfig["type"], cycle: ProviderCycle, ttlMinutes: number,
): HealthReport {
  const records = cycle.providerDiagnostics.map(record => providerDiagnosticSchema.parse(record))
    .filter(record => record.service === service);
  const overviews = records.filter(record => record.kind === "overview");
  const failures = records.filter((record): record is Extract<ProviderDiagnostic, { kind: "failure" }> =>
    record.kind === "failure" && record.apiVersion === "v1.0" && record.source === "serviceAnnouncement.healthOverviews");
  const skipped = records.some(record =>
    record.kind === "skipped" && record.source === "serviceAnnouncement.healthOverviews");
  const scores = overviews.map(record => serviceStatusScores[record.status.toLowerCase()]);
  const knownScores = scores.filter((score): score is number => typeof score === "number");
  const value = failures.length || skipped || !scores.length || knownScores.length !== scores.length
    ? undefined : Math.min(...knownScores);
  return {
    entityName: `${service}-service-health`,
    body: {
      signalName: "microsoft-reported-service-status", expiresInMinutes: ttlMinutes,
      healthState: value === undefined ? "Unknown" : value === 100 ? "Healthy" : value === 0 ? "Unhealthy" : "Degraded",
      ...(value === undefined ? {} : { value }),
      additionalContext: JSON.stringify({
        cycleId: cycle.cycleId, source: "serviceAnnouncement.healthOverviews", apiVersion: "v1.0",
        overviewCount: overviews.length,
        statuses: [...new Set(overviews.map(record => record.status))].slice(0, 8),
        diagnosticCategories: failures.length ? [...new Set(failures.map(record => record.category))]
          : !overviews.length ? ["no-data"] : [],
        httpStatuses: [...new Set(failures.flatMap(record => record.httpStatus === undefined ? [] : [record.httpStatus]))].slice(0, 8),
      }),
    },
  };
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
    const reports = "results" in cycle ? aggregateHealthReports(service.type, cycle, policy)
      : service.mode === "live" && service.serviceHealth ? [serviceHealthReport(service.type, cycle, policy.reportTtlMinutes)] : [];
    if (!http) {
      for (const report of reports) telemetry.emit("health-report-preview", { modelName, ...report });
      return;
    }
    await publishHealthReports(reports, { http, modelPath, telemetry, cycleId: cycle.cycleId });
  };
}
