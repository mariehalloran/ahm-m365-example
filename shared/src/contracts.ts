import { z } from "zod";

export const healthStates = ["Healthy", "Degraded", "Unhealthy", "Unknown"] as const;
export type HealthState = (typeof healthStates)[number];
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
  schemaVersion: z.literal("1.0"),
  testType: z.enum(["exchange-mail-flow", "sharepoint-file"]),
  testId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
  cohort: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,78}[a-zA-Z0-9]$/).optional(),
  targetService: z.enum(["Exchange Online", "SharePoint Online"]),
  success: z.boolean(),
  durationMs: z.number().finite().nonnegative().optional(),
  observedAt: isoDate,
  expiresAt: isoDate,
  correlationId: z.string().uuid(),
  diagnosticCategory: z.enum(categories).nullable().default(null),
  diagnosticContext: z.object({
    region: z.string().max(80).optional(),
    testStage: z.enum(["simulated", "authentication", "send", "poll", "delivery-confirmed", "upload", "download", "cleanup", "complete", "execution"]).optional(),
    cleanupSucceeded: z.boolean().optional(),
    authenticationDurationMs: z.number().nonnegative().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  }).strict().default({}),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)) {
    ctx.addIssue({ code: "custom", message: "Expiration must follow observation" });
  }
  const target = value.testType === "exchange-mail-flow" ? "Exchange Online" : "SharePoint Online";
  if (value.targetService !== target || (value.success && value.diagnosticCategory !== null)) {
    ctx.addIssue({ code: "custom", message: "Inconsistent synthetic result" });
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

export interface HealthReport {
  entity: string;
  signal: string;
  state: HealthState;
  observedAt: string;
  expiresAt: string;
  context: {
    cycleId: string;
    source: "synthetic" | "provider" | "pipeline";
    cohort?: string;
    sampleCount?: number;
    expectedCount?: number;
    successRate?: number;
    p95DurationMs?: number;
    correlationIds?: string[];
    providerState?: string;
    issueIds?: string[];
    reason?: string;
    executionMode?: "simulation" | "live";
    testType?: Probe["type"];
    durationMeaning?: "modeled-not-measured-latency" | "measured-probe-duration";
  };
}

export interface Telemetry {
  emit(event: string, data: Record<string, unknown>): void;
}
export const consoleTelemetry: Telemetry = {
  emit: (event, data) => console.log(JSON.stringify({ event, ...data })),
};
