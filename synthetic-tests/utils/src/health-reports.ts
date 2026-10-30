import {
  journeyStepEntities, probeServices, reportedResult, resultSchema,
  type DiagnosticCategory, type SyntheticResult, type Telemetry,
} from "./contracts.js";
import { groupSignalName, tenantSignalName } from "./groups.js";
import {
  createHealthReportPublisher, evaluateHealthState,
  type EvaluationRules, type HealthReport, type HealthReportClientOptions,
} from "./health-report-client.js";
import type { ProjectConfig } from "./project-config.js";
import type { CyclePublisher, CycleResults } from "./results.js";
import type { ServiceConfig } from "./service-config.js";

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

interface MeasurementSample {
  success: boolean;
  durationMs: number;
  observedAt: string;
  diagnosticCategory?: DiagnosticCategory;
}
interface EntitySamples {
  entityName: string;
  journey: string;
  kind: "journey" | "step" | "call-phase";
  step: string;
  samples: MeasurementSample[];
}
type ReportingGroup = { id: string; displayName: string };

function collectEntitySamples(results: SyntheticResult[], level: "journey" | "all"): EntitySamples[] {
  const entities = new Map<string, EntitySamples>();
  const append = (scope: Omit<EntitySamples, "samples">, sample: MeasurementSample) => {
    const entity = entities.get(scope.entityName) ?? { ...scope, samples: [] };
    entity.samples.push(sample);
    entities.set(scope.entityName, entity);
  };
  for (const result of results) {
    const journey = probeServices[result.testType];
    append({ entityName: journey.entityName, journey: journey.journey, kind: "journey", step: "" }, {
      success: result.success, durationMs: result.durationMs, observedAt: result.observedAt,
      ...(result.diagnosticCategory ? { diagnosticCategory: result.diagnosticCategory } : {}),
    });
    if (level === "journey") continue;
    for (const step of result.steps) {
      if (step.status === "skipped") continue;
      append({
        entityName: `${journey.entityName}-${journeyStepEntities[result.testType]?.[step.name] ?? step.name}`,
        journey: journey.journey, kind: "step", step: step.name,
      }, {
        success: step.status === "succeeded", durationMs: step.durationMs, observedAt: step.observedAt,
        ...(step.status === "failed" ? { diagnosticCategory: step.diagnosticCategory } : {}),
      });
    }
  }
  return [...entities.values()];
}

function measurementReports(
  project: ProjectConfig, cycle: DirectReportCycle, entity: EntitySamples,
  signals: readonly [string, string], group?: ReportingGroup,
): HealthReport[] {
  const { entityName, samples } = entity;
  if (samples.length < project.healthModel.minimumSamples) return [];
  const policy = project.healthModel;
  const succeeded = samples.filter(sample => sample.success).length;
  const observedAt = samples.reduce((latest, sample) =>
    Date.parse(sample.observedAt) > Date.parse(latest.observedAt) ? sample : latest).observedAt;
  const context = {
    aggregation: "single-cycle", runId: cycle.cycleId.slice(0, 80),
    configSha256: cycle.configSha256?.slice(0, 64) ?? null,
    containerRevision: cycle.containerRevision?.slice(0, 128) ?? null,
    tenantAlias: project.tenant.id, journey: entity.journey, kind: entity.kind, step: entity.step,
    groupId: group?.id ?? "", samples: samples.length, succeeded, observedAt,
    diagnosticCategories: [...new Set(samples.flatMap(sample => sample.diagnosticCategory ? [sample.diagnosticCategory] : []))],
    ...(group ? { groupName: group.displayName } : {}),
  };
  const measurements: { signalName: string; unit: string; value: number; rules: EvaluationRules }[] = [
    {
      signalName: signals[0], unit: "Percent", value: 100 * succeeded / samples.length,
      rules: {
        degradedRule: { operator: "LessThan", threshold: policy.successDegradedPercent },
        unhealthyRule: { operator: "LessThan", threshold: policy.successUnhealthyPercent },
      },
    },
    {
      signalName: signals[1], unit: "Milliseconds",
      value: samples.reduce((sum, sample) => sum + sample.durationMs, 0) / samples.length,
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
      healthState: evaluateHealthState(measurement.value, measurement.rules),
      expiresInMinutes: policy.signalWindowMinutes,
      value: measurement.value, evaluationRules: measurement.rules,
      additionalContext: JSON.stringify({ ...context, unit: measurement.unit }),
    },
  }));
}

function callMeasurementReports(project: ProjectConfig, cycle: DirectReportCycle, results: SyntheticResult[]): HealthReport[] {
  const calls = results.filter(result => result.testType === "teams-call");
  const phases = [
    { step: "wait-for-answer", phase: "connection", signals: [teamsCallSignals[0], teamsCallSignals[1]] },
    { step: "end-call", phase: "disconnection", signals: [teamsCallSignals[2], teamsCallSignals[3]] },
  ] as const;
  return phases.flatMap(phase => {
    const samples = calls.flatMap(result => {
      const step = result.steps.find(step => step.name === phase.step);
      if (!step || step.status === "skipped") return [];
      const placed = result.steps.find(step => step.name === "place-call");
      const submissionMs = phase.step === "wait-for-answer" && placed && placed.status !== "skipped" ? placed.durationMs : 0;
      return [{
        success: step.status === "succeeded", durationMs: step.durationMs + submissionMs, observedAt: step.observedAt,
        ...(step.status === "failed" ? { diagnosticCategory: step.diagnosticCategory } : {}),
      }];
    });
    return measurementReports(project, cycle, {
      entityName: "teams-call", journey: probeServices["teams-call"].journey,
      kind: "call-phase", step: phase.phase, samples,
    }, phase.signals);
  });
}

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

export function createDirectHealthReporter(
  project: ProjectConfig, service: ServiceConfig, telemetry: Telemetry, env: NodeJS.ProcessEnv,
  options: HealthReportClientOptions = {},
): CyclePublisher {
  const publish = createHealthReportPublisher(project, service, telemetry, env, options);
  return async cycle => {
    const deadline = AbortSignal.timeout(service.type === "exchange" ? 12000 : 30000);
    const signal = cycle.signal ? AbortSignal.any([cycle.signal, deadline]) : deadline;
    const reports = directHealthReports(project, service, {
      ...cycle,
      ...(env.MONITORING_CONFIG_SHA256 ? { configSha256: env.MONITORING_CONFIG_SHA256 } : {}),
      ...(env.CONTAINER_APP_REVISION ? { containerRevision: env.CONTAINER_APP_REVISION } : {}),
    });
    await publish(reports, { ...cycle, signal });
  };
}
