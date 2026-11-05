import {
  probeServices, reportedResult, resultSchema, type SyntheticResult,
} from "../contracts.js";
import { groupSignalName, tenantSignalName } from "../configuration/groups.js";
import {
  evaluateHealthState,
  type EvaluationRules, type HealthReport,
} from "./health-report-client.js";
import type { ProjectConfig } from "../configuration/project-config.js";
import type { CycleResults } from "./results.js";
import type { ServiceConfig } from "../configuration/service-config.js";
import { resultMeasurements, type MeasurementSample } from "./measurements.js";
import type { ObservedMeasurement } from "./execution-reporter.js";

export type { HealthReport } from "./health-report-client.js";
export interface DirectReportCycle extends CycleResults {
  configSha256?: string;
  containerRevision?: string;
}
export const teamsCallSignals = [
  "observed-call-connection-success-percentage", "observed-call-mean-connection-duration",
  "observed-call-disconnection-success-percentage", "observed-call-mean-disconnection-duration",
] as const;
const journeySignals = ["observed-success-percentage", "observed-mean-duration"] as const;

interface EntitySamples {
  entityName: string;
  journey: string;
  kind: "journey" | "step" | "call-phase";
  step: string;
  samples: MeasurementSample[];
}
type ReportingGroup = { id: string; displayName: string };

/** Groups executed measurements without dropping inconclusive diagnostic records. */
function collectEntitySamples(results: SyntheticResult[], level: "journey" | "all" | "call-phase"): EntitySamples[] {
  const entities = new Map<string, EntitySamples>();
  const append = (scope: Omit<EntitySamples, "samples">, sample: MeasurementSample) => {
    const key = `${scope.entityName}:${scope.kind}:${scope.step}`;
    const entity = entities.get(key) ?? { ...scope, samples: [] };
    entity.samples.push(sample);
    entities.set(key, entity);
  };
  for (const result of results) {
    for (const measurement of resultMeasurements(result)) {
      if (level === "all" ? measurement.kind === "call-phase" : measurement.kind !== level) continue;
      const { entityName, journey, kind, step, ...sample } = measurement;
      append({ entityName, journey, kind, step }, sample);
    }
  }
  return [...entities.values()];
}

/** Evaluates only conclusive samples; insufficient evidence explicitly replaces the signal with Unknown. */
function measurementReports(
  project: ProjectConfig, cycle: DirectReportCycle, entity: EntitySamples,
  signals: readonly [string, string], group?: ReportingGroup,
): HealthReport[] {
  const { entityName, samples } = entity;
  if (!samples.length) return [];
  const policy = project.healthModel;
  const conclusive = samples.filter(sample => sample.success !== null);
  const available = conclusive.length >= policy.minimumSamples;
  const succeeded = conclusive.filter(sample => sample.success).length;
  const observedAt = samples.reduce((latest, sample) =>
    Date.parse(sample.observedAt) > Date.parse(latest.observedAt) ? sample : latest).observedAt;
  const context = {
    aggregation: "single-cycle", runId: cycle.cycleId.slice(0, 80),
    configSha256: cycle.configSha256?.slice(0, 64) ?? null,
    containerRevision: cycle.containerRevision?.slice(0, 128) ?? null,
    tenantAlias: project.tenant.id, journey: entity.journey, kind: entity.kind, step: entity.step,
    groupId: group?.id ?? "", samples: conclusive.length, attempts: samples.length,
    inconclusive: samples.length - conclusive.length, minimumSamples: policy.minimumSamples, succeeded, observedAt,
    diagnosticCategories: [...new Set(samples.flatMap(sample => [
      ...(sample.diagnosticCategory ? [sample.diagnosticCategory] : []),
      ...(sample.cleanupFailed ? ["cleanup-failure"] : []),
    ]))],
    ...(group ? { groupName: group.displayName } : {}),
  };
  const measurements: { signalName: string; unit: string; value: number | undefined; rules: EvaluationRules }[] = [
    {
      signalName: signals[0], unit: "Percent", value: available ? 100 * succeeded / conclusive.length : undefined,
      rules: {
        degradedRule: { operator: "LessThan", threshold: policy.successDegradedPercent },
        unhealthyRule: { operator: "LessThan", threshold: policy.successUnhealthyPercent },
      },
    },
    {
      signalName: signals[1], unit: "Milliseconds",
      value: available ? conclusive.reduce((sum, sample) => sum + sample.durationMs, 0) / conclusive.length : undefined,
      rules: {
        degradedRule: { operator: "GreaterThan", threshold: policy.latencyDegradedMilliseconds },
        unhealthyRule: { operator: "GreaterThan", threshold: policy.latencyUnhealthyMilliseconds },
      },
    },
  ];
  return measurements.map(measurement => ({
    entityName,
    body: {
      signalName: group ? groupSignalName(group.id, project.tenant.id, measurement.signalName)
        : project.multiTenant ? tenantSignalName(project.tenant.id, measurement.signalName) : measurement.signalName,
      healthState: measurement.value === undefined ? "Unknown" : evaluateHealthState(measurement.value, measurement.rules),
      expiresInMinutes: policy.signalWindowMinutes,
      ...(measurement.value === undefined ? {} : { value: measurement.value, evaluationRules: measurement.rules }),
      additionalContext: JSON.stringify({ ...context, unit: measurement.unit }),
    },
  }));
}

/** Reuses the same evidence rules for connection and departure phase signals. */
function callMeasurementReports(project: ProjectConfig, cycle: DirectReportCycle, results: SyntheticResult[]): HealthReport[] {
  const entities = collectEntitySamples(results, "call-phase");
  const phases = [
    { name: "connection", signals: [teamsCallSignals[0], teamsCallSignals[1]] },
    { name: "disconnection", signals: [teamsCallSignals[2], teamsCallSignals[3]] },
  ] as const;
  return phases.flatMap(phase => {
    const entity = entities.find(entity => entity.step === phase.name);
    return entity ? measurementReports(project, cycle, entity, phase.signals) : [];
  });
}

/** Builds aggregate service, journey, step and configured reporting-group reports for one cycle. */
export function directHealthReports(project: ProjectConfig, service: ServiceConfig, cycle: DirectReportCycle): HealthReport[] {
  if (!service.enabled) return [];
  const results = cycle.results.map(raw => reportedResult(resultSchema.parse(raw)));
  if (results.some(result => probeServices[result.testType].service !== service.type)) {
    throw new Error("Health report service does not match its execution lane");
  }
  const reports = collectEntitySamples(results, "all").flatMap(entity =>
    measurementReports(project, cycle, entity, journeySignals));
  if (service.type === "teams") return [...reports, ...callMeasurementReports(project, cycle, results)];
  for (const group of project.groups.filter(group => group.service === service.type)) {
    const members = new Set(group.targetIds);
    const groupResults = results.filter(result => members.has(result.testId));
    for (const entity of collectEntitySamples(groupResults, "journey")) {
      reports.push(...measurementReports(project, cycle, entity, journeySignals, group));
    }
  }
  return reports;
}

/** Aggregates every completed target measurement before publishing a shared entity or group signal. */
export function measurementHealthReports(
  project: ProjectConfig, service: ServiceConfig, cycle: DirectReportCycle, observed: ObservedMeasurement[],
): HealthReport[] {
  if (!observed.length) return [];
  const first = observed[0]!.measurement;
  const entity: EntitySamples = {
    entityName: first.entityName, journey: first.journey, kind: first.kind, step: first.step,
    samples: observed.map(row => row.measurement),
  };
  const signals = first.kind !== "call-phase" ? journeySignals
    : first.step === "connection" ? [teamsCallSignals[0], teamsCallSignals[1]] as const
      : [teamsCallSignals[2], teamsCallSignals[3]] as const;
  const reports = measurementReports(project, cycle, entity, signals);
  if (first.kind === "journey" && service.type !== "teams") {
    for (const group of project.groups.filter(group => group.service === service.type)) {
      const members = new Set(group.targetIds);
      const samples = observed.filter(row => members.has(row.result.testId)).map(row => row.measurement);
      reports.push(...measurementReports(project, cycle, { ...entity, samples }, signals, group));
    }
  }
  return reports;
}
