import { z } from "zod";
import { teamsJourneyDefinitions } from "../../teams/src/catalog.js";

export const scenarios = ["healthy", "slow", "failed", "timeout", "stale"] as const;
export type Scenario = (typeof scenarios)[number];
export const categories = [
  "authentication-failure", "permission-failure", "send-failure", "delivery-timeout",
  "read-failure", "cleanup-failure", "graph-throttling", "graph-unavailable",
  "collector-failure", "configuration-failure", "cancelled", "malformed-response",
] as const;
export type DiagnosticCategory = (typeof categories)[number];

export const testTypes = [
  "exchange-mail-flow", "exchange-draft", "exchange-attachment-reply", "exchange-distribution-list",
  "exchange-recurring-calendar", "exchange-meeting", "teams-channel-message", "teams-call",
  "onedrive-roundtrip", "onedrive-appfolder", "onedrive-versions",
] as const;
export type TestType = (typeof testTypes)[number];

export const probeServices = {
  "exchange-mail-flow": {
    service: "exchange", target: "Exchange Online", journey: "send-receive-mail", entityName: "exchange-global",
    steps: ["authenticate", "create-draft", "send", "confirm-delivery", "cleanup"],
  },
  ...teamsJourneyDefinitions,
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
  "onedrive-roundtrip": {
    service: "onedrive", target: "OneDrive for Business", journey: "user-drive-roundtrip", entityName: "onedrive-planned-user-drive-roundtrip",
    steps: ["authenticate", "create-folder-file", "reopen-file", "verify-file-hash", "delete-owned-artifacts", "cleanup"],
  },
  "onedrive-appfolder": {
    service: "onedrive", target: "OneDrive for Business", journey: "app-folder-lifecycle", entityName: "onedrive-planned-app-folder-lifecycle",
    steps: ["authenticate", "write-app-data", "read-app-data", "update-app-data", "delete-app-scratch", "cleanup"],
  },
  "onedrive-versions": {
    service: "onedrive", target: "OneDrive for Business", journey: "document-versions", entityName: "onedrive-planned-document-versions",
    steps: ["authenticate", "update-document", "list-versions", "read-prior-version", "restore-version", "cleanup"],
  },
} as const;

// These OneDrive entity IDs are already used by deployed health reports.
export const journeyStepEntities: Partial<Record<TestType, Readonly<Record<string, string>>>> = {
  "onedrive-roundtrip": { "create-folder-file": "step-1", "reopen-file": "step-2", "verify-file-hash": "step-3", "delete-owned-artifacts": "step-4" },
  "onedrive-appfolder": { "write-app-data": "step-1", "read-app-data": "step-2", "update-app-data": "step-3", "delete-app-scratch": "step-4" },
  "onedrive-versions": { "update-document": "step-1", "list-versions": "step-2", "read-prior-version": "step-3", "restore-version": "step-4" },
};

const isoDate = z.string().datetime({ offset: true });
export const stepNames = [
  "authenticate", "create-draft", "send", "confirm-delivery", "cleanup",
  "post-message", "confirm-publication", "update-draft", "read-draft", "post-reply", "confirm-reply",
  "place-call", "wait-for-answer", "verify-participants", "play-audio", "end-call",
  "read-initial-draft", "delete-draft", "send-attachment", "verify-attachment", "reply-mail", "confirm-reply-mail",
  "send-group-mail", "confirm-group-delivery", "create-event", "read-occurrence", "update-event", "verify-event", "delete-event",
  "create-meeting", "confirm-invitation", "verify-attendee-calendar", "accept-meeting", "confirm-acceptance", "cancel-meeting",
  "create-folder-file", "reopen-file", "verify-file-hash", "delete-owned-artifacts",
  "write-app-data", "read-app-data", "update-app-data", "delete-app-scratch",
  "update-document", "list-versions", "read-prior-version", "restore-version",
  "verify-meeting-metadata",
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
    reason: z.enum(["prerequisite-failed", "no-mutation", "cleanup-disabled", "variant-disabled"]),
  }).strict(),
]);
export type StepResult = z.infer<typeof stepResultSchema>;
export const resultSchema = z.object({
  schemaVersion: z.literal("2.0"),
  testType: z.enum(testTypes),
  testId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  cohort: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,78}[a-zA-Z0-9]$/).optional(),
  targetService: z.enum(["Exchange Online", "Microsoft Teams", "OneDrive for Business"]),
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
    region: z.string().max(80).optional(),
    testStage: z.enum(["simulated", "initialization", "authentication", "send", "poll", "delivery-confirmed", "download", "update", "read", "reply", "cleanup", "complete", "execution"]).optional(),
    cleanupSucceeded: z.boolean().optional(),
    authenticationDurationMs: z.number().finite().nonnegative().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  }).strict().default({}),
}).strict().superRefine((value, ctx) => {
  const allowedSteps: readonly string[] = probeServices[value.testType].steps;
  if (new Set(value.steps.map(step => step.name)).size !== value.steps.length ||
      value.steps.some(step => step.status === "skipped" && step.reason === "cleanup-disabled" &&
        (!["cleanup", "delete-draft"].includes(step.name) || !["teams", "exchange"].includes(probeServices[value.testType].service))) ||
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
