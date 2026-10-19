import { z } from "zod";

export const scenarios = ["healthy", "slow", "failed", "timeout", "stale"] as const;
export type Scenario = (typeof scenarios)[number];
export const categories = [
  "authentication-failure", "permission-failure", "send-failure", "delivery-timeout",
  "read-failure", "cleanup-failure", "graph-throttling", "graph-unavailable",
  "collector-failure", "cancelled", "malformed-response",
] as const;
export type DiagnosticCategory = (typeof categories)[number];

export const probeServices = {
  "exchange-mail-flow": {
    service: "exchange", target: "Exchange Online", journey: "send-receive-mail",
    steps: ["authenticate", "create-draft", "send", "confirm-delivery", "cleanup"],
  },
  "sharepoint-file": {
    service: "sharepoint", target: "SharePoint Online", journey: "save-reopen-file",
    steps: ["authenticate", "verify-drive", "upload-file", "read-file", "cleanup"],
  },
  "teams-channel-message": {
    service: "teams", target: "Microsoft Teams", journey: "publish-channel-message",
    steps: ["authenticate", "post-message", "confirm-publication", "cleanup"],
  },
} as const;

const isoDate = z.string().datetime({ offset: true });
export const stepNames = [
  "authenticate", "create-draft", "send", "confirm-delivery", "cleanup",
  "post-message", "confirm-publication", "verify-drive", "upload-file", "read-file",
] as const;
export type StepName = (typeof stepNames)[number];
export const stepResultSchema = z.discriminatedUnion("status", [
  z.object({
    name: z.enum(stepNames), status: z.literal("succeeded"), observedAt: isoDate,
    durationMs: z.number().finite().nonnegative(),
  }).strict(),
  z.object({
    name: z.enum(stepNames), status: z.literal("failed"), observedAt: isoDate,
    durationMs: z.number().finite().nonnegative(), diagnosticCategory: z.enum(categories),
  }).strict(),
  z.object({
    name: z.enum(stepNames), status: z.literal("skipped"), observedAt: isoDate,
    reason: z.enum(["prerequisite-failed", "no-mutation"]),
  }).strict(),
]);
export type StepResult = z.infer<typeof stepResultSchema>;
export const resultSchema = z.object({
  schemaVersion: z.literal("2.0"),
  testType: z.enum(["exchange-mail-flow", "sharepoint-file", "teams-channel-message"]),
  testId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  cohort: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,78}[a-zA-Z0-9]$/).optional(),
  targetService: z.enum(["Exchange Online", "SharePoint Online", "Microsoft Teams"]),
  success: z.boolean(),
  durationMs: z.number().finite().nonnegative(),
  sendDurationMs: z.number().finite().nonnegative().optional(),
  deliveryDurationMs: z.number().finite().nonnegative().optional(),
  publicationDurationMs: z.number().finite().nonnegative().optional(),
  uploadDurationMs: z.number().finite().nonnegative().optional(),
  readDurationMs: z.number().finite().nonnegative().optional(),
  observedAt: isoDate,
  correlationId: z.string().uuid(),
  steps: z.array(stepResultSchema).max(5).default([]),
  diagnosticCategory: z.enum(categories).nullable().default(null),
  diagnosticContext: z.object({
    region: z.string().max(80).optional(),
    testStage: z.enum(["simulated", "authentication", "send", "poll", "delivery-confirmed", "upload", "download", "cleanup", "complete", "execution"]).optional(),
    cleanupSucceeded: z.boolean().optional(),
    authenticationDurationMs: z.number().finite().nonnegative().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  }).strict().default({}),
}).strict().superRefine((value, ctx) => {
  const allowedSteps: readonly string[] = probeServices[value.testType].steps;
  if (new Set(value.steps.map(step => step.name)).size !== value.steps.length ||
      value.steps.some((step, index) => !allowedSteps.includes(step.name) ||
        (index > 0 && allowedSteps.indexOf(step.name) <= allowedSteps.indexOf(value.steps[index - 1]!.name))) ||
      (value.success && value.steps.some(step => step.status === "failed"))) {
    ctx.addIssue({ code: "custom", message: "Inconsistent journey steps" });
  }
  const target = probeServices[value.testType].target;
  if (value.targetService !== target ||
      (value.success && (value.diagnosticCategory !== null || value.diagnosticContext.cleanupSucceeded === false))) {
    ctx.addIssue({ code: "custom", message: "Inconsistent synthetic result" });
  }
  if (value.deliveryDurationMs !== undefined &&
      (value.testType !== "exchange-mail-flow" || value.deliveryDurationMs > value.durationMs ||
       (!value.success && value.diagnosticCategory !== "cleanup-failure"))) {
    ctx.addIssue({ code: "custom", message: "Invalid delivery duration" });
  }
  if (value.sendDurationMs !== undefined &&
      (value.testType === "sharepoint-file" || value.sendDurationMs > value.durationMs ||
       (value.deliveryDurationMs !== undefined && value.sendDurationMs > value.deliveryDurationMs) ||
       (value.publicationDurationMs !== undefined && value.sendDurationMs > value.publicationDurationMs))) {
    ctx.addIssue({ code: "custom", message: "Invalid send duration" });
  }
  if (value.publicationDurationMs !== undefined &&
      (value.testType !== "teams-channel-message" || value.publicationDurationMs > value.durationMs ||
       (!value.success && value.diagnosticCategory !== "cleanup-failure"))) {
    ctx.addIssue({ code: "custom", message: "Invalid publication duration" });
  }
  for (const duration of [value.uploadDurationMs, value.readDurationMs]) {
    if (duration !== undefined && (value.testType !== "sharepoint-file" || duration > value.durationMs)) {
      ctx.addIssue({ code: "custom", message: "Invalid document phase duration" });
    }
  }
});
export type SyntheticResult = z.infer<typeof resultSchema>;

export const probeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  type: z.enum(["exchange-mail-flow", "sharepoint-file", "teams-channel-message"]),
  cohort: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,78}[a-zA-Z0-9]$/),
  mailbox: z.string().email().optional(),
  siteId: z.string().min(1).optional(),
  driveId: z.string().min(1).optional(),
  folderId: z.string().min(1).optional(),
  tenantId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  channelId: z.string().min(1).max(300).optional(),
  serviceUrl: z.string().url().optional(),
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
