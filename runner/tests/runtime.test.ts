import { beforeEach, describe, expect, it, vi } from "vitest";
import { AhmSink, RecordingSink } from "../../health-model/src/ahm.js";
import { GraphClient } from "../../shared/src/graph.js";
import { createLiveGraphClient, serviceRuntime } from "../src/runtime.js";
import { parseServiceConfig, serviceSettings } from "../src/service-config.js";
import { BlobStateStore, FileStateStore } from "../src/state.js";

const credentials = vi.hoisted(() => ({ certificate: vi.fn(), managed: vi.fn(), default: vi.fn() }));
vi.mock("@azure/identity", () => ({
  ClientCertificateCredential: vi.fn(function () { credentials.certificate(); }),
  ManagedIdentityCredential: vi.fn(function () { credentials.managed(); }),
  DefaultAzureCredential: vi.fn(function () { credentials.default(); }),
}));
beforeEach(() => vi.clearAllMocks());

describe("app-only Graph identity", () => {
  it("does not fall back to a developer's Azure CLI credentials or client secret", () => {
    expect(() => createLiveGraphClient({})).toThrow("app-only certificate");
    expect(() => createLiveGraphClient({
      AZURE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
      AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
      AZURE_CLIENT_SECRET: "not-used",
    })).toThrow("AZURE_CLIENT_CERTIFICATE_PATH");
  });

  describe("offline-safe, isolated service runtime", () => {
    const telemetry = { emit: vi.fn() };
    const raw = {
      type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation",
      cohort: "exchange-global", targets: [{ id: "ex-001" }],
    };
    const model = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/test/providers/Microsoft.CloudHealth/healthmodels/test-model";
    it("does not construct Azure credentials or cloud state for non-reporting simulation", () => {
      const service = parseServiceConfig(raw);
      const config = serviceSettings(service, { STATE_STORAGE_URL: "https://state.blob.core.windows.net" });
      const result = serviceRuntime(service, config, telemetry, { WEBSITE_INSTANCE_ID: "hosted" });
      expect(result.sink).toBeInstanceOf(RecordingSink);
      expect(result.state).toBeInstanceOf(FileStateStore);
      expect(result.graph).toBeUndefined();
      for (const credential of Object.values(credentials)) expect(credential).not.toHaveBeenCalled();
    });
    it("uses real app-certificate Graph handlers without ARM identity or service-health queries when not reporting", () => {
      const service = parseServiceConfig({ ...raw, mode: "live", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }] });
      const result = serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), telemetry, {
        AZURE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
        AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
        AZURE_CLIENT_CERTIFICATE_PATH: "certificate.pem",
      });
      expect(result.sink).toBeInstanceOf(RecordingSink);
      expect(result.graph).toBeInstanceOf(GraphClient);
      expect(credentials.certificate).toHaveBeenCalledOnce();
      expect(credentials.managed).not.toHaveBeenCalled();
      expect(credentials.default).not.toHaveBeenCalled();
    });
    it("requires explicit certificate settings for ACA-style hosting without WEBSITE_INSTANCE_ID", () => {
      const service = parseServiceConfig({ ...raw, mode: "live", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }] });
      expect(() => serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), telemetry, {
        CONTAINER_APP_NAME: "not-a-functions-host",
      })).toThrow("app-only certificate");
      expect(credentials.managed).not.toHaveBeenCalled();
    });
    it("does not equate simulation with no Azure reporting when reporting is explicit", () => {
      const service = parseServiceConfig({ ...raw, reportToHealthModel: true });
      const result = serviceRuntime(service, serviceSettings(service, {
        AHM_MODEL_ID: model, STATE_STORAGE_URL: "https://state.blob.core.windows.net",
      }), telemetry, {});
      expect(result.sink).toBeInstanceOf(AhmSink);
      expect(result.state).toBeInstanceOf(BlobStateStore);
      expect(result.graph).toBeUndefined();
      expect(credentials.default).toHaveBeenCalledOnce();
      expect(credentials.certificate).not.toHaveBeenCalled();
    });
  });
  it("validates certificate settings without including supplied values in errors", () => {
    expect(() => createLiveGraphClient({
      AZURE_TENANT_ID: "private-invalid-value", AZURE_CLIENT_ID: "also-invalid", AZURE_CLIENT_CERTIFICATE_PATH: " ",
    })).toThrow("AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_CERTIFICATE_PATH");
  });
});
