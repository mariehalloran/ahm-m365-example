import type { TokenCredential } from "@azure/identity";
import { createHealthReportCredential } from "./auth.js";
import { isReportedStep, probeServices, testTypes, type DiagnosticCategory, type ReportedStepName, type SyntheticResult, type Telemetry } from "./contracts.js";
import { AuthenticatedHttp, categoryOf, IntegrationError, type HttpOptions } from "./http.js";
import type { ProjectConfig } from "./project-config.js";
import type { ServiceConfig } from "./service-config.js";
import { providerDiagnosticSchema, type ProviderDiagnostic } from "./provider-diagnostics.js";
import { activityFunctions, isPercentageActivity, type ActivityFunction } from "./provider-catalog.js";

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
    signalName: "synthetic-success-percentage" | "synthetic-mean-duration" | "microsoft-reported-service-status" | "microsoft-reported-issue-count" | `microsoft-activity-${ActivityFunction}`;
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
  unit: "Percent" | "Milliseconds";
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
      signalName: measurement.signalName, expiresInMinutes: ttlMinutes,
      additionalContext: JSON.stringify({ ...JSON.parse(context), unit: measurement.unit }),
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
      signalName: "synthetic-success-percentage", unit: "Percent", rules: successRules,
      value: attempted ? 100 * succeeded / attempted : undefined,
    },
    {
      signalName: "synthetic-mean-duration", unit: "Milliseconds", rules: durationRules,
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
  serviceoperational: 100,
  serviceinterruption: 0,
  servicedegradation: 50,
};

export function serviceActivityReports(
  service: ServiceConfig, cycle: ProviderCycle, ttlMinutes: number, now = Date.now(),
): HealthReport[] {
  if (!service.serviceActivity.enabled) return [];
  const parsed = cycle.providerDiagnostics.map(record => providerDiagnosticSchema.safeParse(record));
  const records = parsed.flatMap(record => record.success && record.data.service === service.type ? [record.data] : []);
  return (service.serviceActivity.functions ?? activityFunctions[service.type]).map(functionName => {
    const thresholds = service.serviceActivity.thresholds[functionName];
    const rows = records.filter((record): record is Extract<ProviderDiagnostic, { kind: "activity" }> =>
      record.kind === "activity" && record.function === functionName)
      .sort((a, b) => Date.parse(b.intervalEnd) - Date.parse(a.intervalEnd));
    const latest = rows[0];
    const failed = parsed.some((record, index) => !record.success &&
      cycle.providerDiagnostics[index]?.service === service.type &&
      cycle.providerDiagnostics[index]?.kind === "activity" &&
      (cycle.providerDiagnostics[index] as Extract<ProviderDiagnostic, { kind: "activity" }>).function === functionName) || records.some(record =>
      (record.kind === "failure" || record.kind === "skipped") && record.source === functionName);
    const end = latest ? Date.parse(latest.intervalEnd) : NaN;
    const stale = !Number.isFinite(end) || end > now || now - end > service.serviceActivity.maxAgeMinutes * 60000 ||
      (latest && (Date.parse(latest.collectedAt) > now || now - Date.parse(latest.collectedAt) > service.serviceActivity.maxAgeMinutes * 60000));
    const valid = latest && Date.parse(latest.intervalEnd) - Date.parse(latest.intervalStart) === latest.aggregationIntervalMinutes * 60000 &&
      rows.filter(row => row.intervalEnd === latest.intervalEnd).length === 1 &&
      (isPercentageActivity(functionName) ? latest.value === undefined && latest.percentage !== undefined
        : latest.percentage === undefined && latest.value !== undefined);
    const sample = latest ? isPercentageActivity(functionName) ? latest.percentage : latest.value : undefined;
    const value = failed || stale || !valid ? undefined : sample;
    const rules: EvaluationRules | undefined = thresholds ? {
      degradedRule: { operator: "LessThan", threshold: thresholds.degradedBelow },
      unhealthyRule: { operator: "LessThan", threshold: thresholds.unhealthyBelow },
    } : undefined;
    return {
      entityName: `${service.type}-service-health-${functionName}`,
      body: {
        signalName: `microsoft-activity-${functionName}` as const, expiresInMinutes: ttlMinutes,
        healthState: value === undefined || !rules ? "Unknown" : evaluateHealthState(value, rules),
        ...(value === undefined ? {} : { value, ...(rules ? { evaluationRules: rules } : {}) }),
        additionalContext: JSON.stringify({
          cycleId: cycle.cycleId, source: functionName, apiVersion: "beta", aggregation: "latest-complete-bucket",
          ...(latest ? { intervalStart: latest.intervalStart, intervalEnd: latest.intervalEnd } : {}),
          unit: isPercentageActivity(functionName) ? "Percent" : "Count",
          evaluated: rules !== undefined,
          interpretation: functionName === "getAudioStreamQoEMetricsForTeams" ? "telemetry-coverage-not-call-quality"
            : functionName === "getAudioStreamsOverUdpMetricsForTeams" ? "network-context-not-call-quality"
              : rules ? "customer-configured-threshold" : "diagnostic-only-no-threshold",
          diagnosticCategories: failed ? ["collection-failure"] : !latest ? ["no-data"] : stale ? ["stale-data"] : value === undefined ? ["malformed-response"] : [],
        }),
      },
    };
  });
}

export function serviceHealthReport(
  service: ServiceConfig["type"], cycle: ProviderCycle, ttlMinutes: number, now = Date.now(), maxAgeMinutes = 60,
): HealthReport {
  const parsed = cycle.providerDiagnostics.map(record => providerDiagnosticSchema.safeParse(record));
  const records = parsed.flatMap(record => record.success && record.data.service === service ? [record.data] : []);
  const overviews = records.filter(record => record.kind === "overview");
  const failures = records.filter((record): record is Extract<ProviderDiagnostic, { kind: "failure" }> =>
    record.kind === "failure" && record.apiVersion === "v1.0" && record.source === "serviceAnnouncement.healthOverviews");
  const skipped = records.some(record =>
    record.kind === "skipped" && record.source === "serviceAnnouncement.healthOverviews");
  const scores = overviews.map(record => serviceStatusScores[record.status.toLowerCase()]);
  const knownScores = scores.filter((score): score is number => typeof score === "number");
  const stale = overviews.some(record => Date.parse(record.collectedAt) > now ||
    now - Date.parse(record.collectedAt) > maxAgeMinutes * 60000);
  const invalid = parsed.some((record, index) => !record.success &&
    cycle.providerDiagnostics[index]?.service === service && cycle.providerDiagnostics[index]?.kind === "overview");
  const value = failures.length || skipped || stale || invalid || !scores.length || knownScores.length !== scores.length
    ? undefined : Math.min(...knownScores);
  return {
    entityName: `${service}-service-health-health-overviews`,
    body: {
      signalName: "microsoft-reported-service-status", expiresInMinutes: ttlMinutes,
      healthState: value === undefined ? "Unknown" : value === 100 ? "Healthy" : value === 0 ? "Unhealthy" : "Degraded",
      ...(value === undefined ? {} : { value }),
      additionalContext: JSON.stringify({
        cycleId: cycle.cycleId, source: "serviceAnnouncement.healthOverviews", apiVersion: "v1.0",
        unit: "status-score", mapping: { serviceOperational: 100, serviceDegradation: 50, serviceInterruption: 0 },
        overviewCount: overviews.length,
        statuses: [...new Set(overviews.map(record => record.status))].slice(0, 8),
        diagnosticCategories: failures.length ? [...new Set(failures.map(record => record.category))]
          : !overviews.length ? ["no-data"] : stale ? ["stale-data"] : [],
        httpStatuses: [...new Set(failures.flatMap(record => record.httpStatus === undefined ? [] : [record.httpStatus]))].slice(0, 8),
      }),
    },
  };
}

export function serviceHealthIssuesReport(
  service: ServiceConfig["type"], cycle: ProviderCycle, ttlMinutes: number, now = Date.now(), maxAgeMinutes = 60,
): HealthReport {
  const parsed = cycle.providerDiagnostics.map(record => providerDiagnosticSchema.safeParse(record));
  const records = parsed.flatMap(record => record.success && record.data.service === service ? [record.data] : []);
  const summaries = records.filter(record => record.kind === "issue-summary");
  const summary = summaries[0];
  const failed = records.some(record =>
    (record.kind === "failure" || record.kind === "skipped") && record.source === "serviceAnnouncement.issues");
  const invalid = parsed.some((record, index) => !record.success &&
    cycle.providerDiagnostics[index]?.service === service && cycle.providerDiagnostics[index]?.kind === "issue-summary");
  const stale = summary && (Date.parse(summary.collectedAt) > now ||
    now - Date.parse(summary.collectedAt) > maxAgeMinutes * 60000);
  const value = summaries.length !== 1 || failed || invalid || stale ? undefined : summary?.count;
  return {
    entityName: `${service}-service-health-issues`,
    body: {
      signalName: "microsoft-reported-issue-count", healthState: "Unknown", expiresInMinutes: ttlMinutes,
      ...(value === undefined ? {} : { value }),
      additionalContext: JSON.stringify({
        cycleId: cycle.cycleId, source: "serviceAnnouncement.issues", apiVersion: "v1.0", unit: "Count",
        interpretation: "diagnostic-only-no-threshold", evaluated: false,
        diagnosticCategories: failed ? ["collection-failure"] : stale ? ["stale-data"]
          : invalid || summaries.length > 1 ? ["malformed-response"] : !summary ? ["no-data"] : [],
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
  if (!service.enabled) return async () => undefined;
  const policy = project.healthModel;
  const http = service.mode === "live" ? new AuthenticatedHttp(
    options.credential ?? createHealthReportCredential(env, service.healthReportAuthentication),
    "https://management.azure.com/.default", { ...options, attempts: 2, timeoutMs: REPORT_TIMEOUT_MS },
  ) : undefined;
  const modelName = `${policy.name}-${service.type}`;
  const modelPath = `https://management.azure.com/subscriptions/${encodeURIComponent(policy.subscriptionId)}`
    + `/resourceGroups/${encodeURIComponent(policy.resourceGroup)}/providers/Microsoft.CloudHealth/healthmodels/${encodeURIComponent(modelName)}`;
  return async cycle => {
    const reports = "results" in cycle ? aggregateHealthReports(service.type, cycle, policy)
      : service.mode === "live" ? [
        ...(service.serviceHealth ? [
          serviceHealthReport(service.type, cycle, policy.reportTtlMinutes, Date.now(), service.serviceActivity.maxAgeMinutes),
          serviceHealthIssuesReport(service.type, cycle, policy.reportTtlMinutes, Date.now(), service.serviceActivity.maxAgeMinutes),
        ] : []),
        ...serviceActivityReports(service, cycle, policy.reportTtlMinutes),
      ] : [];
    if (!http) {
      for (const report of reports) telemetry.emit("health-report-preview", { modelName, ...report });
      return;
    }
    await publishHealthReports(reports, { http, modelPath, telemetry, cycleId: cycle.cycleId });
  };
}
