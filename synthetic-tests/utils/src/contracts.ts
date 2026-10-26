import { z } from "zod";

export const scenarios = ["healthy", "slow", "failed", "timeout", "stale"] as const;
export type Scenario = (typeof scenarios)[number];
export const categories = [
  "authentication-failure", "reauthentication-required", "permission-failure", "send-failure", "delivery-timeout",
  "read-failure", "cleanup-failure", "graph-throttling", "graph-unavailable",
  "collector-failure", "configuration-failure", "cancelled", "malformed-response",
] as const;
export type DiagnosticCategory = (typeof categories)[number];

export const testTypes = [
  "exchange-mail-flow", "exchange-draft", "exchange-attachment-reply", "exchange-distribution-list",
  "exchange-recurring-calendar", "exchange-meeting", "sharepoint-file", "sharepoint-rename",
  "teams-channel-message", "teams-channel-reply", "teams-call",
] as const;
export type TestType = (typeof testTypes)[number];

export const probeServices = {
  "exchange-mail-flow": {
    service: "exchange", target: "Exchange Online", journey: "send-receive-mail", entityName: "exchange-global",
    steps: ["authenticate", "create-draft", "send", "confirm-delivery", "cleanup"],
  },
  "sharepoint-file": {
    service: "sharepoint", target: "SharePoint Online", journey: "save-reopen-file", entityName: "sharepoint-global",
    steps: ["authenticate", "verify-drive", "upload-file", "read-file", "cleanup"],
  },
  "teams-channel-message": {
    service: "teams", target: "Microsoft Teams", journey: "publish-channel-message", entityName: "teams-global",
    steps: ["authenticate", "post-message", "confirm-publication", "cleanup"],
  },
  "exchange-draft": {
    service: "exchange", target: "Exchange Online", journey: "edit-reopen-draft", entityName: "exchange-draft",
    steps: ["authenticate", "create-draft", "read-initial-draft", "update-draft", "read-draft", "delete-draft", "cleanup"],
  },
  "exchange-attachment-reply": {
    service: "exchange", target: "Exchange Online", journey: "attachment-reply-mail", entityName: "exchange-attachment",
    steps: ["authenticate", "send-attachment", "verify-attachment", "reply-mail", "confirm-reply-mail", "cleanup"],
  },
  "exchange-distribution-list": {
    service: "exchange", target: "Exchange Online", journey: "distribution-list-mail", entityName: "exchange-distribution",
    steps: ["authenticate", "send-group-mail", "confirm-group-delivery", "cleanup"],
  },
  "exchange-recurring-calendar": {
    service: "exchange", target: "Exchange Online", journey: "recurring-calendar", entityName: "exchange-recurring",
    steps: ["authenticate", "create-event", "read-occurrence", "update-event", "verify-event", "delete-event", "cleanup"],
  },
  "exchange-meeting": {
    service: "exchange", target: "Exchange Online", journey: "meeting-invitation", entityName: "exchange-meeting",
    steps: ["authenticate", "create-meeting", "confirm-invitation", "verify-attendee-calendar", "accept-meeting", "confirm-acceptance", "cancel-meeting", "cleanup"],
  },
  "teams-channel-reply": {
    service: "teams", target: "Microsoft Teams", journey: "reply-channel-message", entityName: "teams-reply",
    steps: ["authenticate", "post-message", "post-reply", "confirm-reply", "cleanup"],
  },
  "teams-call": {
    service: "teams", target: "Microsoft Teams", journey: "call-test-user", entityName: "teams-call",
    steps: ["authenticate", "place-call", "wait-before-hangup", "end-call", "cleanup"],
  },
  "sharepoint-rename": {
    service: "sharepoint", target: "SharePoint Online", journey: "rename-reopen-file", entityName: "sharepoint-rename",
    steps: ["authenticate", "verify-drive", "upload-file", "rename-file", "read-file", "cleanup"],
  },
} as const;

const isoDate = z.string().datetime({ offset: true });
export const stepNames = [
  "authenticate", "create-draft", "send", "confirm-delivery", "cleanup",
  "post-message", "confirm-publication", "verify-drive", "upload-file", "read-file",
  "update-draft", "read-draft", "post-reply", "confirm-reply", "rename-file",
  "place-call", "wait-before-hangup", "end-call",
  "read-initial-draft", "delete-draft", "send-attachment", "verify-attachment", "reply-mail", "confirm-reply-mail",
  "send-group-mail", "confirm-group-delivery", "create-event", "read-occurrence", "update-event", "verify-event", "delete-event",
  "create-meeting", "confirm-invitation", "verify-attendee-calendar", "accept-meeting", "confirm-acceptance", "cancel-meeting",
] as const;
export type StepName = (typeof stepNames)[number];
export type ReportedStepName = Exclude<StepName, "authenticate" | "cleanup">;
export function isReportedStep(name: StepName): name is ReportedStepName {
  return name !== "authenticate" && name !== "cleanup";
}
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
    reason: z.enum(["prerequisite-failed", "no-mutation", "cleanup-disabled"]),
  }).strict(),
]);
export type StepResult = z.infer<typeof stepResultSchema>;
export const resultSchema = z.object({
  schemaVersion: z.literal("2.0"),
  testType: z.enum(testTypes),
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
  steps: z.array(stepResultSchema).max(12).default([]),
  diagnosticCategory: z.enum(categories).nullable().default(null),
  diagnosticContext: z.object({
    region: z.string().max(80).optional(),
    testStage: z.enum(["simulated", "initialization", "authentication", "send", "poll", "delivery-confirmed", "upload", "download", "update", "read", "reply", "rename", "cleanup", "complete", "execution"]).optional(),
    cleanupSucceeded: z.boolean().optional(),
    authenticationDurationMs: z.number().finite().nonnegative().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  }).strict().default({}),
}).strict().superRefine((value, ctx) => {
  const allowedSteps: readonly string[] = probeServices[value.testType].steps;
  if (new Set(value.steps.map(step => step.name)).size !== value.steps.length ||
      value.steps.some(step => step.status === "skipped" && step.reason === "cleanup-disabled" &&
        (!["cleanup", "delete-draft"].includes(step.name) || !["teams", "exchange"].includes(probeServices[value.testType].service))) ||
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
      ((value.testType !== "exchange-mail-flow" && probeServices[value.testType].service !== "teams") || value.sendDurationMs > value.durationMs ||
       (value.deliveryDurationMs !== undefined && value.sendDurationMs > value.deliveryDurationMs) ||
       (value.publicationDurationMs !== undefined && value.sendDurationMs > value.publicationDurationMs))) {
    ctx.addIssue({ code: "custom", message: "Invalid send duration" });
  }
  if (value.publicationDurationMs !== undefined &&
      (probeServices[value.testType].service !== "teams" || value.publicationDurationMs > value.durationMs ||
       (!value.success && value.diagnosticCategory !== "cleanup-failure"))) {
    ctx.addIssue({ code: "custom", message: "Invalid publication duration" });
  }
  for (const duration of [value.uploadDurationMs, value.readDurationMs]) {
    if (duration !== undefined && (probeServices[value.testType].service !== "sharepoint" || duration > value.durationMs)) {
      ctx.addIssue({ code: "custom", message: "Invalid document phase duration" });
    }
  }
});
export type SyntheticResult = z.infer<typeof resultSchema>;

export function reportedResult(result: SyntheticResult): SyntheticResult {
  const { authenticationDurationMs, cleanupSucceeded, ...diagnosticContext } = result.diagnosticContext;
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
  recipientMailbox: z.string().email().optional(),
  distributionList: z.object({
    address: z.string().email(),
    expectedRecipients: z.array(z.string().email()).min(1).max(30),
  }).strict().optional(),
  siteId: z.string().min(1).optional(),
  driveId: z.string().min(1).optional(),
  folderId: z.string().min(1).optional(),
  tenantId: z.string().uuid().optional(),
  userPrincipalName: z.string().email().optional(),
  teamId: z.string().uuid().optional(),
  channelId: z.string().min(1).max(300).optional(),
  serviceUrl: z.string().url().optional(),
  callUserId: z.string().uuid().optional(),
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
