import { z } from "zod";
import { probeServices, stepNames, targetServices, testTypes, type StepName, type TestType } from "./catalog.js";
export { journeyStepEntities, probeServices, stepNames, testTypes } from "./catalog.js";
export type { StepName, TestType } from "./catalog.js";

export const scenarios = ["healthy", "slow", "failed", "timeout", "stale"] as const;
export type Scenario = (typeof scenarios)[number];
export const categories = [
  "authentication-failure", "permission-failure", "send-failure", "delivery-timeout",
  "read-failure", "cleanup-failure", "graph-throttling", "graph-unavailable",
  "collector-failure", "configuration-failure", "cancelled", "malformed-response",
] as const;
export type DiagnosticCategory = (typeof categories)[number];

/** Identifies worker/cleanup outcomes that cannot establish service success or failure. */
export function isInconclusiveCategory(category: DiagnosticCategory | null | undefined): boolean {
  return category === "cancelled" || category === "cleanup-failure";
}

export const maxServiceTargets = 1000;
export const maxOneDriveTargets = maxServiceTargets;
export const serviceProbeLimits = Object.fromEntries(
  (["exchange", "teams", "onedrive"] as const).map(service => [
    service, testTypes.filter(type => probeServices[type].service === service).length * maxServiceTargets,
  ]),
) as Record<"exchange" | "teams" | "onedrive", number>;
// Exchange journeys wait on several mailbox/calendar propagation delays inside their deadline, so they poll
// finely; a 2-second interval alone costs about a second per wait and left calendar journeys at the cap.
export const exchangePollIntervalMilliseconds = 500;
export const replySeedSchema = z.object({
  messageId: z.string().min(1),
  correlationId: z.string().uuid(),
}).strict();

const isoDate = z.string().datetime({ offset: true });
export type ReportedStepName = Exclude<StepName, "authenticate" | "cleanup">;
export function isReportedStep(name: StepName): name is ReportedStepName {
  return name !== "authenticate" && name !== "cleanup";
}
export const maxStepDetailLength = 200;
export const stepResultSchema = z.discriminatedUnion("status", [
  z.object({
    name: z.enum(stepNames), status: z.literal("succeeded"), observedAt: isoDate,
    durationMs: z.number().finite().nonnegative(),
  }).strict(),
  z.object({
    name: z.enum(stepNames), status: z.literal("failed"), observedAt: isoDate,
    durationMs: z.number().finite().nonnegative(), diagnosticCategory: z.enum(categories),
    // A short, value-free hint such as `schema:@odata.nextLink(too_big)`; never message or Graph content.
    detail: z.string().max(maxStepDetailLength).optional(),
  }).strict(),
  z.object({
    name: z.enum(stepNames), status: z.literal("skipped"), observedAt: isoDate,
    reason: z.enum(["prerequisite-failed", "no-mutation", "cleanup-disabled", "variant-disabled"]),
  }).strict(),
]);
export type StepResult = z.infer<typeof stepResultSchema>;
export const resultSchema = z.object({
  schemaVersion: z.literal("2.0"),
  testType: z.enum(testTypes),
  testId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  cohort: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,78}[a-zA-Z0-9]$/).optional(),
  targetService: z.enum(targetServices),
  success: z.boolean(),
  durationMs: z.number().finite().nonnegative(),
  sendDurationMs: z.number().finite().nonnegative().optional(),
  deliveryDurationMs: z.number().finite().nonnegative().optional(),
  publicationDurationMs: z.number().finite().nonnegative().optional(),
  call: z.object({
    callChainId: z.string().uuid().optional(),
    peerCallChainId: z.string().uuid().optional(),
    endedAt: isoDate.optional(),
    resultCodes: z.array(z.number().int()).max(12).default([]),
  }).strict().optional(),
  observedAt: isoDate,
  correlationId: z.string().uuid(),
  steps: z.array(stepResultSchema).max(12).default([]),
  diagnosticCategory: z.enum(categories).nullable().default(null),
  diagnosticContext: z.object({
    botPairId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(30).optional(),
    region: z.string().max(80).optional(),
    testStage: z.enum(["simulated", "initialization", "authentication", "send", "poll", "delivery-confirmed", "download", "update", "read", "reply", "cleanup", "complete", "execution"]).optional(),
    cleanupSucceeded: z.boolean().optional(),
    cleanupFailure: z.object({
      category: z.enum(categories),
      httpStatus: z.number().int().min(100).max(599).optional(),
      detail: z.string().max(maxStepDetailLength).optional(),
    }).strict().optional(),
    authenticationDurationMs: z.number().finite().nonnegative().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  }).strict().default({}),
}).strict().superRefine((value, ctx) => {
  const allowedSteps: readonly string[] = probeServices[value.testType].steps;
  if (new Set(value.steps.map(step => step.name)).size !== value.steps.length ||
      value.steps.some(step => step.status === "skipped" && step.reason === "cleanup-disabled" &&
        (step.name !== "cleanup" || !["teams", "exchange"].includes(probeServices[value.testType].service))) ||
      value.steps.some(step => step.status === "skipped" && step.reason === "variant-disabled" &&
        (value.testType !== "onedrive-versions" || step.name !== "restore-version")) ||
      value.steps.some((step, index) => !allowedSteps.includes(step.name) ||
        (index > 0 && allowedSteps.indexOf(step.name) <= allowedSteps.indexOf(value.steps[index - 1]!.name))) ||
      (value.success && value.steps.some(step => step.status === "failed"))) {
    ctx.addIssue({ code: "custom", message: "Inconsistent journey steps" });
  }
  const target = probeServices[value.testType].target;
  if (value.call && value.testType !== "teams-call") {
    ctx.addIssue({ code: "custom", message: "Call evidence belongs only to the Teams call journey" });
  }
  if (value.targetService !== target ||
      (value.success && (value.diagnosticCategory !== null || value.diagnosticContext.cleanupSucceeded === false))) {
    ctx.addIssue({ code: "custom", message: "Inconsistent synthetic result" });
  }
  if (value.deliveryDurationMs !== undefined &&
      (value.testType !== "exchange-mail-flow" || value.deliveryDurationMs > value.durationMs ||
       (!value.success && !isInconclusiveCategory(value.diagnosticCategory)))) {
    ctx.addIssue({ code: "custom", message: "Invalid delivery duration" });
  }
  if (value.sendDurationMs !== undefined &&
      ((value.testType !== "exchange-mail-flow" && probeServices[value.testType].service !== "teams") || value.sendDurationMs > value.durationMs ||
       (value.deliveryDurationMs !== undefined && value.sendDurationMs > value.deliveryDurationMs) ||
       (value.publicationDurationMs !== undefined && value.sendDurationMs > value.publicationDurationMs))) {
    ctx.addIssue({ code: "custom", message: "Invalid send duration" });
  }
  if (value.publicationDurationMs !== undefined &&
      (probeServices[value.testType].service !== "teams" || value.publicationDurationMs > value.durationMs ||
       (!value.success && !isInconclusiveCategory(value.diagnosticCategory)))) {
    ctx.addIssue({ code: "custom", message: "Invalid publication duration" });
  }
});
export type SyntheticResult = z.infer<typeof resultSchema>;

/** Removes internal action measurements while retaining cleanup diagnostics on the journey. */
export function reportedResult(result: SyntheticResult): SyntheticResult {
  const { authenticationDurationMs, ...diagnosticContext } = result.diagnosticContext;
  if (diagnosticContext.testStage === "authentication" || diagnosticContext.testStage === "cleanup") {
    diagnosticContext.testStage = "execution";
  }
  return { ...result, steps: result.steps.filter(step => isReportedStep(step.name)), diagnosticContext };
}

export const probeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  type: z.enum(testTypes),
  cohort: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,78}[a-zA-Z0-9]$/),
  mailbox: z.string().email().optional(),
  replySeed: replySeedSchema.optional(),
  driveId: z.string().min(1).optional(),
  folderId: z.string().min(1).optional(),
  tenantId: z.string().uuid().optional(),
  userPrincipalName: z.string().email().optional(),
  userId: z.string().uuid().optional(),
  folderName: z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/).optional(),
  restoreVersion: z.boolean().optional(),
  teamId: z.string().uuid().optional(),
  channelId: z.string().min(1).max(300).optional(),
  serviceUrl: z.string().url().optional(),
  meetingThreadId: z.string().min(1).max(300).regex(/^19:meeting_[^\s]+@thread\.v2$/).optional(),
  organizerUserId: z.string().uuid().optional(),
  botPairId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(30).optional(),
  botClientId: z.string().uuid().optional(),
  peerBotClientId: z.string().uuid().optional(),
  region: z.string().max(80).optional(),
  scenario: z.enum(scenarios).optional(),
}).strict();
export type Probe = z.infer<typeof probeSchema>;

export interface Telemetry {
  emit(event: string, data: Record<string, unknown>): void;
}
export const consoleTelemetry: Telemetry = {
  emit: (event, data) => console.log(JSON.stringify({ event, ...data })),
};
