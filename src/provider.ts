import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import type { HealthReport, HealthState, Telemetry } from "./contracts.js";
import { GraphClient } from "./graph.js";
import { categoryOf, IntegrationError } from "./http.js";

const issue = z.object({
  id: z.string().max(100),
  classification: z.string().max(100).optional(),
  feature: z.string().max(100).nullable().optional(),
  startDateTime: z.string().datetime({ offset: true }).optional(),
  lastModifiedDateTime: z.string().datetime({ offset: true }).optional(),
  endDateTime: z.string().datetime({ offset: true }).nullable().optional(),
});
export const serviceHealthSchema = z.object({
  value: z.array(z.object({ id: z.string(), service: z.string(), status: z.string(), issues: z.array(issue).optional() })),
});
const statusState: Readonly<Record<string, HealthState>> = {
  serviceOperational: "Healthy", serviceDegradation: "Degraded", serviceInterruption: "Unhealthy",
  investigating: "Unknown", restoringService: "Degraded", extendedRecovery: "Degraded",
  investigationSuspended: "Unknown", serviceRestored: "Healthy", postIncidentReviewPublished: "Healthy",
};
const files: Record<Config["PROVIDER_SCENARIO"], string> = {
  operational: "service-health-operational", degraded: "service-health-exchange-degraded",
  throttled: "graph-429-throttled", unauthorized: "graph-401-unauthorized", forbidden: "graph-403-forbidden",
  unavailable: "graph-503-unavailable", malformed: "malformed-response", stale: "stale-response",
};

export async function providerReport(config: Config, graph: GraphClient | undefined, cycleId: string, telemetry: Telemetry, signal: AbortSignal, now = Date.now()): Promise<HealthReport> {
  const report: HealthReport = {
    entity: "provider-context", signal: "provider-health", state: "Unknown",
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + config.REPORT_TTL_SECONDS * 1000).toISOString(),
    context: { cycleId, source: "provider" },
  };
  try {
    let raw: unknown;
    if (config.EXECUTION_MODE === "simulation") {
      const fixture = z.object({
        status: z.number().int(), ageSeconds: z.number().nonnegative().default(0),
        body: z.unknown(),
      }).parse(JSON.parse(await readFile(resolve("mocks", `${files[config.PROVIDER_SCENARIO]}.json`), "utf8")));
      if (fixture.ageSeconds >= config.REPORT_TTL_SECONDS) throw new IntegrationError("read-failure");
      if (fixture.status !== 200) throw new IntegrationError(
        fixture.status === 429 ? "graph-throttling" : fixture.status === 401 ? "authentication-failure" :
        fixture.status === 403 ? "permission-failure" : "graph-unavailable", fixture.status,
      );
      raw = fixture.body;
    } else {
      if (!graph) throw new IntegrationError("collector-failure");
      const response = await graph.request("/admin/serviceAnnouncement/healthOverviews?$expand=issues", signal);
      const serverTime = response.headers.get("date");
      if (serverTime && (!Number.isFinite(Date.parse(serverTime)) || Math.abs(now - Date.parse(serverTime)) >= config.REPORT_TTL_SECONDS * 1000)) {
        throw new IntegrationError("read-failure");
      }
      raw = await response.json();
    }
    const parsed = serviceHealthSchema.safeParse(raw);
    if (!parsed.success) throw new IntegrationError("malformed-response");
    const exchange = parsed.data.value.find(service => service.service === "Exchange Online");
    if (!exchange) throw new IntegrationError("malformed-response");
    report.state = statusState[exchange.status] ?? "Unknown";
    report.context.providerState = exchange.status;
    report.context.issueIds = (exchange.issues ?? []).slice(0, 5).map(item => item.id);
    telemetry.emit("provider-context", {
      cycleId, providerState: exchange.status,
      issues: (exchange.issues ?? []).map(({ id, classification, feature, startDateTime, lastModifiedDateTime, endDateTime }) =>
        ({ id, classification, feature, startDateTime, lastModifiedDateTime, endDateTime })),
    });
    if (report.state === "Unknown") telemetry.emit("provider-status-unknown", { cycleId, category: "unrecognized-or-indeterminate-status" });
  } catch (error) {
    report.context.reason = categoryOf(error);
    telemetry.emit("provider-query-failed", { cycleId, category: categoryOf(error), ...(error instanceof IntegrationError ? { httpStatus: error.status } : {}) });
  }
  return report;
}
