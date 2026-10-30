import type { TokenCredential } from "@azure/identity";
import { createHealthReportCredential } from "./auth.js";
import { ConfigurationError } from "./config.js";
import type { Telemetry } from "./contracts.js";
import { AuthenticatedHttp, categoryOf, IntegrationError, withAbort, type HttpOptions } from "./http.js";
import { serviceModelName, type ProjectConfig } from "./project-config.js";
import type { ServiceConfig } from "./service-config.js";

const MAX_CONCURRENT_REPORTS = 3;
const REPORT_TIMEOUT_MS = 5000;
const REPORT_BATCH_TIMEOUT_MS = 30000;

export type HealthState = "Healthy" | "Degraded" | "Unhealthy" | "Unknown";
export interface EvaluationRules {
  degradedRule: { operator: "LessThan" | "GreaterThan"; threshold: number };
  unhealthyRule: { operator: "LessThan" | "GreaterThan"; threshold: number };
}
export interface HealthReport {
  entityName: string;
  body: {
    signalName: string;
    healthState: HealthState;
    expiresInMinutes: number;
    additionalContext: string;
    value?: number;
    evaluationRules?: EvaluationRules;
  };
}
export interface HealthReportCycle { cycleId: string; signal?: AbortSignal }
export type HealthReportClientOptions = HttpOptions & { credential?: TokenCredential };
export type HealthReportPublisher = (reports: readonly HealthReport[], cycle: HealthReportCycle) => Promise<void>;

export function evaluateHealthState(value: number, rules: EvaluationRules): HealthState {
  const breaches = (rule: EvaluationRules["unhealthyRule"]) =>
    rule.operator === "LessThan" ? value < rule.threshold : value > rule.threshold;
  if (breaches(rules.unhealthyRule)) return "Unhealthy";
  if (breaches(rules.degradedRule)) return "Degraded";
  return "Healthy";
}

export function createHealthReportPublisher(
  project: ProjectConfig, service: ServiceConfig, telemetry: Telemetry, env: NodeJS.ProcessEnv,
  options: HealthReportClientOptions = {},
): HealthReportPublisher {
  if (!service.enabled) return async () => undefined;
  if (service.mode === "live" && service.healthReportAuthentication !== "managed-identity") {
    throw new ConfigurationError("Health report publication requires an explicitly selected managed identity");
  }
  const http = service.mode === "live" ? new AuthenticatedHttp(
    options.credential ?? createHealthReportCredential(env, "managed-identity"),
    "https://management.azure.com/.default", { ...options, attempts: 2, timeoutMs: REPORT_TIMEOUT_MS },
  ) : undefined;
  const policy = project.healthModel;
  const modelName = serviceModelName(project, service.type);
  const modelPath = `https://management.azure.com/subscriptions/${encodeURIComponent(policy.subscriptionId)}`
    + `/resourceGroups/${encodeURIComponent(policy.resourceGroup)}/providers/Microsoft.CloudHealth/healthmodels/${encodeURIComponent(modelName)}`;
  return async (reports, cycle) => {
    if (!http) {
      for (const report of reports) telemetry.emit("health-report-preview", { modelName, ...report });
      return;
    }
    const deadline = AbortSignal.timeout(REPORT_BATCH_TIMEOUT_MS);
    const signal = cycle.signal ? AbortSignal.any([cycle.signal, deadline]) : deadline;
    let nextReport = 0;
    let failures = 0;
    const sendNext = async () => {
      while (nextReport < reports.length) {
        const report = reports[nextReport++]!;
        const metadata = {
          cycleId: cycle.cycleId, modelName, entityName: report.entityName, signalName: report.body.signalName,
          healthState: report.body.healthState, ...(report.body.value === undefined ? {} : { value: report.body.value }),
        };
        try {
          await withAbort(signal, async () => {
            const response = await http.request(
              `${modelPath}/entities/${encodeURIComponent(report.entityName)}/ingestHealthReport?api-version=2026-05-01-preview`,
              { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report.body) },
              signal,
            );
            await response.body?.cancel();
            if (response.status !== 204) throw new IntegrationError("collector-failure", response.status);
          });
          telemetry.emit("health-report-published", { ...metadata, status: 204 });
        } catch (error) {
          failures++;
          telemetry.emit("health-report-failed", {
            ...metadata, category: categoryOf(error),
            ...(error instanceof IntegrationError ? { status: error.status } : {}),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_REPORTS, reports.length) }, sendNext));
    if (failures) throw new IntegrationError("collector-failure");
  };
}
