import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphClient } from "../../shared/src/graph.js";
import { createLiveGraphClient, serviceRuntime } from "../src/runtime.js";
import { parseServiceConfig, serviceSettings } from "../src/service-config.js";

const credentials = vi.hoisted(() => ({ certificate: vi.fn(), managed: vi.fn(), default: vi.fn() }));
vi.mock("@azure/identity", () => ({
  ClientCertificateCredential: vi.fn(function () { credentials.certificate(); }),
  ManagedIdentityCredential: vi.fn(function () { credentials.managed(); }),
  DefaultAzureCredential: vi.fn(function () { credentials.default(); }),
}));
beforeEach(() => vi.clearAllMocks());
const output = { emit: vi.fn() };
const raw = {
  type: "exchange", enabled: true, intervalSeconds: 60, timeoutSeconds: 45, mode: "simulation",
  cohort: "exchange-global", targets: [{ id: "ex-001" }],
};
const certificate = {
  AZURE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
  AZURE_CLIENT_CERTIFICATE_PATH: "certificate.pem",
};

describe("stateless service runtime", () => {
  it("does not construct Azure credentials, Graph, ARM clients or state for console simulation", async () => {
    const service = parseServiceConfig(raw);
    const runtime = await serviceRuntime(service, serviceSettings(service, {}), output, {});
    try {
      expect(Object.keys(runtime).sort()).toEqual(["results", "telemetry"]);
      for (const credential of Object.values(credentials)) expect(credential).not.toHaveBeenCalled();
    } finally { await runtime.results.shutdown(); }
  });
  it("uses app-certificate Graph identity, not ARM/Blob identity, for live probes", async () => {
    const service = parseServiceConfig({ ...raw, mode: "live", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }] });
    const runtime = await serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, certificate);
    try {
      expect(runtime.graph).toBeInstanceOf(GraphClient);
      expect(credentials.certificate).toHaveBeenCalledOnce();
      expect(credentials.managed).not.toHaveBeenCalled();
      expect(credentials.default).not.toHaveBeenCalled();
    } finally { await runtime.results.shutdown(); }
  });
  it("validates Azure telemetry before constructing a live Graph client", async () => {
    const service = parseServiceConfig({ ...raw, telemetry: "azure-monitor", mode: "live", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }] });
    await expect(serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, certificate))
      .rejects.toThrow("APPLICATIONINSIGHTS_CONNECTION_STRING");
    expect(credentials.certificate).not.toHaveBeenCalled();
  });
  it("does not use a developer's CLI credentials, client secret, or host identity as a Graph fallback", () => {
    expect(() => createLiveGraphClient({})).toThrow("app-only certificate");
    expect(() => createLiveGraphClient({
      ...certificate, AZURE_CLIENT_CERTIFICATE_PATH: "", AZURE_CLIENT_SECRET: "private-secret", CONTAINER_APP_NAME: "host",
    })).toThrow("AZURE_CLIENT_CERTIFICATE_PATH");
    expect(credentials.default).not.toHaveBeenCalled();
    expect(credentials.managed).not.toHaveBeenCalled();
  });
  it("shuts down initialized providers when live Graph startup fails", async () => {
    const service = parseServiceConfig({ ...raw, mode: "live", targets: [{ id: "ex-001", mailbox: "dedicated@example.invalid" }] });
    await expect(serviceRuntime(service, serviceSettings(service, { ENABLE_LIVE_M365: "true" }), output, {})).rejects.toThrow("app-only certificate");
  });
  it("does not echo supplied values in configuration errors", () => {
    expect(() => createLiveGraphClient({ AZURE_TENANT_ID: "private-value", AZURE_CLIENT_ID: "private-value", AZURE_CLIENT_CERTIFICATE_PATH: " " }))
      .toThrow("AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_CERTIFICATE_PATH");
  });
});
