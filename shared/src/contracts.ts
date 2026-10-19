import { z } from "zod";

export const scenarios = ["healthy", "slow", "failed", "timeout", "stale"] as const;
export type Scenario = (typeof scenarios)[number];
export const categories = [
  "authentication-failure", "permission-failure", "send-failure", "delivery-timeout",
  "read-failure", "cleanup-failure", "graph-throttling", "graph-unavailable",
  "collector-failure", "cancelled", "malformed-response",
] as const;
export type DiagnosticCategory = (typeof categories)[number];

const isoDate = z.string().datetime({ offset: true });
export const resultSchema = z.object({
  schemaVersion: z.literal("2.0"),
  testType: z.enum(["exchange-mail-flow", "sharepoint-file"]),
  testId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  cohort: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,78}[a-zA-Z0-9]$/).optional(),
  targetService: z.enum(["Exchange Online", "SharePoint Online"]),
  success: z.boolean(),
  durationMs: z.number().finite().nonnegative(),
  deliveryDurationMs: z.number().finite().nonnegative().optional(),
  observedAt: isoDate,
  correlationId: z.string().uuid(),
  diagnosticCategory: z.enum(categories).nullable().default(null),
  diagnosticContext: z.object({
    region: z.string().max(80).optional(),
    testStage: z.enum(["simulated", "authentication", "send", "poll", "delivery-confirmed", "upload", "download", "cleanup", "complete", "execution"]).optional(),
    cleanupSucceeded: z.boolean().optional(),
    authenticationDurationMs: z.number().finite().nonnegative().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  }).strict().default({}),
}).strict().superRefine((value, ctx) => {
  const target = value.testType === "exchange-mail-flow" ? "Exchange Online" : "SharePoint Online";
  if (value.targetService !== target ||
      (value.success && (value.diagnosticCategory !== null || value.diagnosticContext.cleanupSucceeded === false))) {
    ctx.addIssue({ code: "custom", message: "Inconsistent synthetic result" });
  }
  if (value.deliveryDurationMs !== undefined &&
      (value.testType !== "exchange-mail-flow" || value.deliveryDurationMs > value.durationMs ||
       (!value.success && value.diagnosticCategory !== "cleanup-failure"))) {
    ctx.addIssue({ code: "custom", message: "Invalid delivery duration" });
  }
});
export type SyntheticResult = z.infer<typeof resultSchema>;

export const probeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  type: z.enum(["exchange-mail-flow", "sharepoint-file"]),
  cohort: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,78}[a-zA-Z0-9]$/),
  mailbox: z.string().email().optional(),
  siteId: z.string().min(1).optional(),
  driveId: z.string().min(1).optional(),
  folderId: z.string().min(1).optional(),
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
