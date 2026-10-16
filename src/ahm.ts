import type { HealthReport } from "./contracts.js";
import { AuthenticatedHttp, IntegrationError } from "./http.js";

export interface ReportSink { submit(report: HealthReport, signal: AbortSignal): Promise<void> }
export class RecordingSink implements ReportSink {
  readonly reports: HealthReport[] = [];
  async submit(report: HealthReport): Promise<void> { this.reports.push(structuredClone(report)); }
}
export class AhmSink implements ReportSink {
  constructor(private readonly modelId: string, private readonly apiVersion: string, private readonly http: AuthenticatedHttp, private readonly now = Date.now) {
    if (!/^\/subscriptions\/[a-fA-F0-9-]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CloudHealth\/healthmodels\/[a-zA-Z0-9-]+$/.test(modelId)) {
      throw new Error("Invalid AHM model ARM resource ID");
    }
  }
  async submit(report: HealthReport, signal: AbortSignal): Promise<void> {
    const remaining = Date.parse(report.expiresAt) - this.now();
    if (!Number.isFinite(remaining) || !Number.isFinite(Date.parse(report.observedAt))) throw new Error("Invalid health report timestamps");
    // Reserve the request budget as ARM starts its relative TTL when it accepts the report.
    const ttl = Math.floor((remaining - 15000) / 60000);
    const state = ttl < 1 ? "Unknown" : report.state;
    const body = {
      signalName: report.signal,
      healthState: state,
      expiresInMinutes: state === "Unknown" ? 1 : Math.min(ttl, 10080),
      additionalContext: JSON.stringify({ ...report.context, observedAt: report.observedAt, expiresAt: report.expiresAt }),
    };
    if (Buffer.byteLength(body.additionalContext) > 4096) throw new Error("AHM diagnostic context exceeds 4096 bytes");
    const url = `https://management.azure.com${this.modelId}/entities/${encodeURIComponent(report.entity)}/ingestHealthReport?api-version=${encodeURIComponent(this.apiVersion)}`;
    const response = await this.http.request(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, signal);
    if (response.status !== 204) throw new IntegrationError("collector-failure", response.status);
  }
}
