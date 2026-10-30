import type { Telemetry } from "./contracts.js";
import {
  createHealthReportPublisher, evaluateHealthState,
  type EvaluationRules, type HealthReport, type HealthReportClientOptions,
} from "./health-report-client.js";
import { tenantSignalName } from "./groups.js";
import type { ProjectConfig } from "./project-config.js";
import type { ServiceConfig } from "./service-config.js";
import { providerDiagnosticSchema, type ProviderDiagnostic } from "./provider-diagnostics.js";
import { activityFunctions, isPercentageActivity } from "./provider-catalog.js";

export type { HealthReport } from "./health-report-client.js";
export interface ProviderCycle { cycleId: string; providerDiagnostics: ProviderDiagnostic[]; signal?: AbortSignal }
export type ProviderReporter = (cycle: ProviderCycle) => Promise<void>;

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
    const failures = records.filter((record): record is Extract<ProviderDiagnostic, { kind: "failure" }> =>
      record.kind === "failure" && record.source === functionName);
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
      entityName: `${service.type}-service-health`,
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
          diagnosticCategories: failures.length ? [...new Set(failures.map(record => record.category))]
            : failed ? ["collection-failure"] : !latest ? ["no-data"] : stale ? ["stale-data"] : value === undefined ? ["malformed-response"] : [],
          httpStatuses: [...new Set(failures.flatMap(record => record.httpStatus === undefined ? [] : [record.httpStatus]))].slice(0, 8),
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
    entityName: `${service}-service-health`,
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
    entityName: `${service}-service-health`,
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

export function createProviderReporter(
  project: ProjectConfig, service: ServiceConfig, telemetry: Telemetry, env: NodeJS.ProcessEnv,
  options: HealthReportClientOptions = {},
): ProviderReporter {
  const policy = project.healthModel;
  const publish = createHealthReportPublisher(project, service, telemetry, env, options);
  // The one place overall signals gain their tenant; group signals are already qualified by group and tenant.
  const qualified = (report: HealthReport): HealthReport => project.multiTenant
    ? { ...report, body: { ...report.body, signalName: tenantSignalName(project.tenant.id, report.body.signalName) } }
    : report;
  return async cycle => {
    const overall = project.serviceHealth.enabled && service.mode === "live" ? [
        ...(service.serviceHealth ? [
          serviceHealthReport(service.type, cycle, policy.signalWindowMinutes, Date.now(), service.serviceActivity.maxAgeMinutes),
          serviceHealthIssuesReport(service.type, cycle, policy.signalWindowMinutes, Date.now(), service.serviceActivity.maxAgeMinutes),
        ] : []),
        ...serviceActivityReports(service, cycle, policy.signalWindowMinutes),
      ].filter(report => report.body.value !== undefined) : [];
    const reports = overall.map(qualified);
    await publish(reports, cycle);
  };
}
