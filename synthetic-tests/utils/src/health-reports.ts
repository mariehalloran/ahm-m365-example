import type { TokenCredential } from "@azure/identity";
import { createServiceCredential } from "./auth.js";
import { probeServices, type SyntheticResult, type Telemetry } from "./contracts.js";
import { AuthenticatedHttp, categoryOf, IntegrationError, type HttpOptions } from "./http.js";
import type { ProjectConfig } from "./project-config.js";
import type { ServiceConfig } from "./service-config.js";

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

function stateOf(value: number, rules: EvaluationRules): HealthState {
  const breaches = (rule: EvaluationRules["unhealthyRule"]) =>
    rule.operator === "LessThan" ? value < rule.threshold : value > rule.threshold;
  return breaches(rules.unhealthyRule) ? "Unhealthy" : breaches(rules.degradedRule) ? "Degraded" : "Healthy";
}

export function aggregateHealthReports(
  service: ServiceConfig["type"], cycle: CycleResults, policy: Policy,
): HealthReport[] {
  const journey = Object.values(probeServices).find(item => item.service === service)!;
  const successRules: EvaluationRules = {
    degradedRule: { operator: "LessThan", threshold: policy.successDegradedPercent },
    unhealthyRule: { operator: "LessThan", threshold: policy.successUnhealthyPercent },
  };
  const durationRules: EvaluationRules = {
    degradedRule: { operator: "GreaterThan", threshold: policy.latencyDegradedMilliseconds },
    unhealthyRule: { operator: "GreaterThan", threshold: policy.latencyUnhealthyMilliseconds },
  };
  const groups = [
    {
      entityName: `${service}-global`,
      samples: cycle.results.map(result => ({ success: result.success, durationMs: result.durationMs })),
      skipped: 0,
    },
    ...journey.steps.map(name => {
      const steps = cycle.results.flatMap(result => result.steps.filter(step => step.name === name));
      return {
        entityName: `${service}-${name}`,
        samples: steps.flatMap(step => step.status === "skipped" ? [] : [{
          success: step.status === "succeeded", durationMs: step.durationMs,
        }]),
        skipped: cycle.results.length - steps.filter(step => step.status !== "skipped").length,
      };
    }),
  ];
  return groups.flatMap(group => {
    const count = group.samples.length;
    const context = JSON.stringify({
      aggregation: "single-cycle", cycleId: cycle.cycleId, attempted: count,
      succeeded: group.samples.filter(sample => sample.success).length, skipped: group.skipped,
    });
    const measurements = [
      {
        signalName: "synthetic-success-percentage" as const, rules: successRules,
        value: count ? 100 * group.samples.filter(sample => sample.success).length / count : undefined,
      },
      {
        signalName: "synthetic-mean-duration" as const, rules: durationRules,
        value: count ? group.samples.reduce((sum, sample) => sum + sample.durationMs, 0) / count : undefined,
      },
    ];
    return measurements.map(measurement => ({
      entityName: group.entityName,
      body: {
        signalName: measurement.signalName, expiresInMinutes: policy.reportTtlMinutes, additionalContext: context,
        healthState: measurement.value === undefined ? "Unknown" : stateOf(measurement.value, measurement.rules),
        ...(measurement.value === undefined ? {} : { value: measurement.value, evaluationRules: measurement.rules }),
      },
    }));
  });
}

export function createHealthReporter(
  project: ProjectConfig, service: ServiceConfig, telemetry: Telemetry, env: NodeJS.ProcessEnv,
  options: HttpOptions & { credential?: TokenCredential } = {},
): HealthReporter {
  const policy = project.healthModel;
  const http = service.mode === "live" ? new AuthenticatedHttp(
    options.credential ?? createServiceCredential(env, service.graphAuthentication, "health-report"),
    "https://management.azure.com/.default", { ...options, attempts: 2, timeoutMs: 5000 },
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
    const signal = AbortSignal.timeout(30000);
    let index = 0;
    let failures = 0;
    const sendNext = async () => {
      while (index < reports.length) {
        const report = reports[index++]!;
        try {
          const response = await http.request(
            `${modelPath}/entities/${encodeURIComponent(report.entityName)}/ingestHealthReport?api-version=2026-05-01-preview`,
            { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report.body) },
            signal,
          );
          await response.body?.cancel();
          if (response.status !== 204) throw new IntegrationError("collector-failure", response.status);
          telemetry.emit("health-report-published", {
            cycleId: cycle.cycleId, entityName: report.entityName, signalName: report.body.signalName,
          });
        } catch (error) {
          failures++;
          telemetry.emit("health-report-failed", {
            cycleId: cycle.cycleId, entityName: report.entityName, signalName: report.body.signalName,
            category: categoryOf(error), ...(error instanceof IntegrationError ? { status: error.status } : {}),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, reports.length) }, sendNext));
    if (failures) throw new IntegrationError("collector-failure");
  };
}
