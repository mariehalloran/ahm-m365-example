import { describe, expect, it } from "vitest";
import { AzureMonitorLogExporter, AzureMonitorMetricExporter } from "@azure/monitor-opentelemetry-exporter";
import { createProbeTelemetry, type AzureExporterFactory } from "../src/azure-monitor.js";
import { baseResult } from "../src/probes.js";
import type { ProviderDiagnostic } from "../src/provider-diagnostics.js";

describe("provider diagnostics through actual Azure Monitor SDK exporters", () => {
  it("exports flat MessageData without adding provider snapshots to synthetic/step metrics, and flushes before shutdown", async () => {
    const envelopes: any[] = [];
    const httpClient = {
      async sendRequest(request: any) {
        envelopes.push(...JSON.parse(String(request.body)));
        return { request, status: 200, headers: request.headers, bodyAsText: "{}" };
      },
    };
    const factory: AzureExporterFactory = {
      logs: options => new AzureMonitorLogExporter({ ...options, httpClient }),
      metrics: options => new AzureMonitorMetricExporter({ ...options, httpClient }),
    };
    const telemetry = await createProbeTelemetry("azure-monitor", { emit: () => undefined }, {
      APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=11111111-1111-4111-8111-111111111111;IngestionEndpoint=https://telemetry.example.invalid",
    }, factory);
    const collectedAt = "2026-10-19T12:00:00.000Z";
    const records: ProviderDiagnostic[] = [
      { kind: "overview", service: "exchange", collectedAt, serviceId: "Exchange", serviceName: "Exchange Online", status: "serviceDegradation" },
      { kind: "issue", service: "exchange", collectedAt, issueId: "EX123", serviceName: "Exchange Online", status: "serviceDegradation", metadata: '{"title":"Approved announcement","truncated":false}', truncated: false },
      { kind: "activity", service: "exchange", collectedAt, function: "getConnectivityMetricsForExchange", intervalStart: "2026-10-19T11:30:00.000Z", intervalEnd: "2026-10-19T11:45:00.000Z", aggregationIntervalMinutes: 15, percentage: 99.5 },
      { kind: "activity", service: "teams", collectedAt, function: "getMessageVolumeMetricsForTeamsChat", intervalStart: "2026-10-19T11:30:00.000Z", intervalEnd: "2026-10-19T11:45:00.000Z", aggregationIntervalMinutes: 15, value: 42 },
      { kind: "failure", service: "exchange", collectedAt, source: "serviceAnnouncement.issues", apiVersion: "v1.0", category: "permission-failure", httpStatus: 403 },
    ];
    try {
      for (const record of records) telemetry.recordDiagnostic(record);
      await telemetry.forceFlush();
      expect(envelopes).toHaveLength(5);
      expect(envelopes.every(envelope => envelope.data.baseType === "MessageData")).toBe(true);
      const overview = envelopes.find(envelope => envelope.data.baseData.message === "m365-service-health-overview");
      expect(overview.time).toBe(collectedAt);
      expect(overview.data.baseData.properties).toMatchObject({
        "provider.service": "exchange", "provider.mode": "live", "provider.api_version": "v1.0",
        "provider.collected_at": collectedAt, "provider.status": "serviceDegradation",
        "provider.source": "serviceAnnouncement.healthOverviews", "provider.service_id": "Exchange",
        "provider.service_name": "Exchange Online",
      });
      const beta = envelopes.filter(envelope => envelope.data.baseData.message === "m365-service-activity");
      expect(beta).toHaveLength(2);
      expect(beta.every(envelope => envelope.data.baseData.properties["provider.api_version"] === "beta" &&
        !("provider.status" in envelope.data.baseData.properties))).toBe(true);
      expect(String(beta[0].data.baseData.properties["provider.percentage"])).toBe("99.5");
      expect(String(beta[1].data.baseData.properties["provider.value"])).toBe("42");
      const sample = {
        ...baseResult({ id: "one", type: "exchange-mail-flow", cohort: "exchange-global" }, Date.parse(collectedAt)),
        success: true, durationMs: 100,
        steps: [{ name: "create-draft" as const, status: "succeeded" as const, observedAt: collectedAt, durationMs: 10 }],
      };
      telemetry.record(sample, "live");
      telemetry.record({ ...sample, success: false, diagnosticCategory: "read-failure", steps: [] }, "live");
      // Repeated historical snapshots still cannot create new metric observations.
      for (const record of records) telemetry.recordDiagnostic(record);
      await telemetry.forceFlush();
      const metrics = envelopes.filter(envelope => envelope.data.baseType === "MetricData");
      const success = metrics.filter(envelope => envelope.data.baseData.metrics[0]?.name === "synthetic.probe.success");
      expect(success.map(envelope => envelope.data.baseData.metrics[0]).sort((a, b) => a.value - b.value))
        .toEqual([expect.objectContaining({ value: 0, count: 1 }), expect.objectContaining({ value: 1, count: 1 })]);
      const step = metrics.filter(envelope => envelope.data.baseData.metrics[0]?.name === "synthetic.step.success");
      expect(step).toHaveLength(1);
      expect(step[0].data.baseData.metrics[0]).toMatchObject({ value: 1, count: 1 });
      expect(JSON.stringify(metrics)).not.toContain("provider.");
    } finally { await telemetry.shutdown(); }
  });
});
