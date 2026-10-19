import { z } from "zod";
import { healthStates, resultSchema, type HealthReport, type HealthState, type Probe, type SyntheticResult, type Telemetry } from "../../shared/src/contracts.js";

export const historySchema = z.record(z.object({
  state: z.enum(healthStates),
  failures: z.number().int().nonnegative(),
  recoveries: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
}).strict());
export type History = z.infer<typeof historySchema>;
export interface Policy {
  MIN_FRESH_SAMPLES: number;
  MIN_FRESH_COVERAGE: number;
  HEALTHY_SUCCESS_RATE: number;
  DEGRADED_SUCCESS_RATE: number;
  HEALTHY_LATENCY_MS: number;
  UNHEALTHY_LATENCY_MS: number;
  CONSECUTIVE_FAILURES: number;
  CONSECUTIVE_RECOVERIES: number;
  REPORT_TTL_SECONDS: number;
}

const unexecutable = new Set(["authentication-failure", "permission-failure", "graph-throttling", "graph-unavailable", "collector-failure", "cancelled", "malformed-response"]);
export function individualState(raw: unknown, policy: Policy, now: number): HealthState {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return "Unknown";
  const result = parsed.data;
  if (Date.parse(result.expiresAt) <= now || Date.parse(result.observedAt) > now + 60000 ||
      now - Date.parse(result.observedAt) >= policy.REPORT_TTL_SECONDS * 1000 ||
      (result.diagnosticCategory && unexecutable.has(result.diagnosticCategory))) return "Unknown";
  if (!result.success || (result.durationMs ?? 0) > policy.UNHEALTHY_LATENCY_MS) return "Unhealthy";
  return (result.durationMs ?? 0) > policy.HEALTHY_LATENCY_MS ? "Degraded" : "Healthy";
}

function stabilize(state: HealthState, previous: History[string] | undefined, policy: Policy, now: number) {
  if (state === "Unknown") return { state, failures: 0, recoveries: 0 };
  const fresh = previous && Date.parse(previous.expiresAt) > now && previous.state !== "Unknown" ? previous : undefined;
  const failures = state === "Unhealthy" ? (fresh?.failures ?? 0) + 1 : 0;
  const recoveries = state === "Healthy" ? (fresh?.recoveries ?? 0) + 1 : 0;
  let effective = state;
  if (state === "Unhealthy" && failures < policy.CONSECUTIVE_FAILURES) effective = "Degraded";
  if (state === "Healthy" && fresh && fresh.state !== "Healthy" && recoveries < policy.CONSECUTIVE_RECOVERIES) effective = "Degraded";
  return { state: effective, failures, recoveries };
}

export function aggregate(
  probes: readonly Probe[], rawResults: readonly unknown[], policy: Policy, history: History,
  now: number, cycleId: string, telemetry: Telemetry,
): { reports: HealthReport[]; history: History } {
  const results = new Map<string, SyntheticResult>();
  const configured = new Map(probes.map(probe => [probe.id, probe]));
  const duplicates = new Set<string>();
  for (const raw of rawResults) {
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success) { telemetry.emit("invalid-result", { category: "malformed-response" }); continue; }
    const result = parsed.data;
    const probe = configured.get(result.testId);
    if (!probe || (result.cohort !== undefined && result.cohort !== probe.cohort) || result.testType !== probe.type) {
      telemetry.emit("invalid-result", { category: "unconfigured-result" }); continue;
    }
    if (results.has(result.testId)) duplicates.add(result.testId);
    results.set(result.testId, { ...result, cohort: probe.cohort });
  }
  for (const id of duplicates) {
    results.delete(id);
    telemetry.emit("invalid-result", { testId: id, category: "duplicate-result" });
  }
  const next: History = {};
  const reports: HealthReport[] = [];
  for (const cohort of new Set(probes.map(probe => probe.cohort))) {
    const members = probes.filter(probe => probe.cohort === cohort);
    const samples = members.flatMap(probe => {
      const result = results.get(probe.id);
      return result && individualState(result, policy, now) !== "Unknown" ? [result] : [];
    });
    const successRate = samples.length ? samples.filter(sample => sample.success).length / samples.length : 0;
    const durations = samples.flatMap(sample => sample.durationMs === undefined ? [] : [sample.durationMs]).sort((a, b) => a - b);
    const p95DurationMs = durations[Math.ceil(durations.length * 0.95) - 1] ?? 0;
    const insufficient = samples.length < policy.MIN_FRESH_SAMPLES || samples.length / members.length < policy.MIN_FRESH_COVERAGE;
    const rawState: HealthState = insufficient ? "Unknown"
      : successRate < policy.DEGRADED_SUCCESS_RATE || p95DurationMs > policy.UNHEALTHY_LATENCY_MS ? "Unhealthy"
      : successRate < policy.HEALTHY_SUCCESS_RATE || p95DurationMs > policy.HEALTHY_LATENCY_MS ? "Degraded" : "Healthy";
    const stabilized = stabilize(rawState, history[cohort], policy, now);
    const sampleExpirations = samples.map(sample =>
      Math.min(Date.parse(sample.expiresAt), Date.parse(sample.observedAt) + policy.REPORT_TTL_SECONDS * 1000));
    const expiresAt = new Date(Math.min(now + policy.REPORT_TTL_SECONDS * 1000, ...sampleExpirations)).toISOString();
    next[cohort] = { ...stabilized, expiresAt };
    reports.push({
      entity: cohort, signal: "synthetic-health", state: stabilized.state,
      observedAt: new Date(now).toISOString(), expiresAt,
      context: {
        cycleId, source: "synthetic", cohort, sampleCount: samples.length, expectedCount: members.length,
        successRate, p95DurationMs,
        correlationIds: samples.filter(sample => !sample.success).slice(0, 5).map(sample => sample.correlationId),
        reason: insufficient ? "insufficient-fresh-samples" : rawState !== stabilized.state ? "consecutive-cycle-policy" : "cohort-policy",
      },
    });
  }
  return { reports, history: next };
}
