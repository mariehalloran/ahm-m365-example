import { createHash } from "node:crypto";
import { z } from "zod";
import { categories, isInconclusiveCategory, probeServices, reportedResult } from "../contracts.js";
import { executionLanes } from "../execution/execution-lanes.js";
import { resultContext } from "../configuration/groups.js";
import type { ProjectConfig } from "../configuration/project-config.js";
import type { CycleResults } from "./results.js";
import type { ServiceConfig } from "../configuration/service-config.js";
import { resultMeasurements } from "./measurements.js";

const syntheticDimensions = z.object({
  service: z.string().min(1).max(80),
  journey: z.string().min(1).max(120),
  step: z.string().max(120),
  kind: z.enum(["journey", "step", "call-phase"]),
  mode: z.enum(["live", "simulation"]),
  tenantId: z.string().uuid(),
  tenantAlias: z.string().min(1).max(40),
  testAccountId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  syntheticUser: z.string().email().optional(),
  durationMs: z.number().finite().nonnegative(),
  runId: z.string().uuid(),
  correlationId: z.string().uuid(),
  reportingGroupIds: z.array(z.string()),
  reportingGroupNames: z.array(z.string()),
  failureCategory: z.enum(categories).optional(),
  outcome: z.enum(["success", "failure", "unknown"]).optional(),
}).passthrough();

export const observationSchema = z.object({
  eventId: z.string().regex(/^[a-f0-9]{64}$/),
  timestamp: z.string().datetime({ offset: true }),
  category: z.string().min(1).max(80),
  subject: z.string().min(1).max(260),
  period: z.string().regex(/^[1-9]\d*[smh]$/),
  unit: z.string().min(1).max(40),
  version: z.literal("1"),
  value: z.number().finite().nullable(),
  dimensions: z.record(z.unknown()),
}).strict().superRefine((value, context) => {
  if (value.unit === "success" && value.value !== null && value.value !== 0 && value.value !== 1) {
    context.addIssue({ code: "custom", path: ["value"], message: "Success observations must be 0, 1 or explicitly unavailable" });
  }
  if (value.category !== "M365Synthetic") {
    if (value.value === null) context.addIssue({ code: "custom", path: ["value"], message: "Unavailable values require synthetic diagnostics" });
    return;
  }
  const parsed = syntheticDimensions.safeParse(value.dimensions);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) context.addIssue({ ...issue, path: ["dimensions", ...issue.path] });
  } else {
    const inconclusive = isInconclusiveCategory(parsed.data.failureCategory);
    if (value.value === null && (!inconclusive || value.unit !== "success")) {
      context.addIssue({ code: "custom", path: ["value"], message: "Unavailable samples require cancellation or cleanup-failure diagnostics" });
    }
    // Older events may contain 0 for an inconclusive outcome; ingestion and queries normalize those rows.
    const outcome = inconclusive ? "unknown" : value.value === 1 ? "success" : "failure";
    if (parsed.data.outcome !== undefined && parsed.data.outcome !== outcome) {
      context.addIssue({ code: "custom", path: ["dimensions", "outcome"], message: "Outcome does not match the observed evidence" });
    }
    if (parsed.data.reportingGroupIds.length !== parsed.data.reportingGroupNames.length ||
        (parsed.data.kind !== "journey" && parsed.data.step === "")) {
      context.addIssue({ code: "custom", path: ["dimensions"], message: "Invalid step or reporting group dimensions" });
    }
  }
});
export type Observation = z.infer<typeof observationSchema>;
/** Formats the lane cadence as the observation period. */
const period = (seconds: number) => seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;

/** Serializes conclusive binary samples and explicit no-sample diagnostics for each executed action. */
export function cycleObservations(project: ProjectConfig, service: ServiceConfig, cycle: CycleResults): Observation[] {
  const lanes = executionLanes(service);
  return cycle.results.flatMap(raw => {
    const result = reportedResult(raw);
    const definition = probeServices[result.testType];
    if (definition.service !== service.type) throw new Error("Observation service does not match its execution lane");
    const lane = lanes.find(lane => lane.journeys.includes(definition.journey));
    if (!lane) throw new Error("Observation has no configured execution cadence");
    const context = resultContext(project, result);
    const groups = context.groups ?? [];
    const dimensions = {
      service: service.type, journey: definition.journey, testType: result.testType,
      tenantId: project.tenant.tenantId, tenantAlias: project.tenant.id,
      testAccountId: result.testId, syntheticUser: context.user,
      botPairId: result.diagnosticContext.botPairId,
      reportingGroupIds: groups.map(group => group.id),
      reportingGroupNames: groups.map(group => group.displayName),
      region: result.diagnosticContext.region,
      executionRegion: project.deployment?.location,
      mode: service.mode, runId: cycle.cycleId, correlationId: result.correlationId,
      authenticationMethod: service.type === "teams" ? "managed-identity-bot" : service.graphAuthentication,
      testVersion: result.schemaVersion,
    };
    return resultMeasurements(result).map(({
      kind, step, success, durationMs, observedAt, diagnosticCategory: failureCategory, cleanupFailed, cleanupFailure, detail,
    }) => observationSchema.parse({
      eventId: createHash("sha256").update([
        project.tenant.id, service.type, cycle.cycleId, result.correlationId, result.testType, result.testId, kind, step,
      ].join("\0")).digest("hex"),
      timestamp: observedAt, category: "M365Synthetic",
      subject: `${service.type}.${definition.journey}${step ? `.${step}` : ""}`,
      period: period(lane.intervalSeconds), unit: "success", version: "1", value: success === null ? null : success ? 1 : 0,
      dimensions: {
        ...dimensions, kind, step, durationMs, outcome: success === null ? "unknown" : success ? "success" : "failure",
        ...(cleanupFailed ? { cleanupSucceeded: false } : {}),
        ...(cleanupFailure ? { cleanupFailure } : {}),
        ...(failureCategory ? { failureCategory } : {}),
        ...(failureCategory ? {
          errorMessage: detail ?? `${failureCategory} during ${service.type}.${definition.journey}${step ? `.${step}` : ""}`,
        } : {}),
        ...(result.diagnosticContext.httpStatus ? { httpStatus: result.diagnosticContext.httpStatus } : {}),
        ...(result.call ? {
          callChainId: result.call.callChainId, peerCallChainId: result.call.peerCallChainId,
          resultCodes: result.call.resultCodes,
        } : {}),
      },
    }));
  });
}
