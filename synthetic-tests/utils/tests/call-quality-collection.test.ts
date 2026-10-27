import { describe, expect, it, vi, beforeEach } from "vitest";
import { GraphClient } from "../src/graph.js";
import { IntegrationError } from "../src/http.js";
import { baseResult } from "../src/probes.js";
import { collectAudioFeasibilityQuality, collectCycleCallQuality } from "../src/teams-call-quality-collection.js";
import { collectCallQuality, type CallQualityObservation } from "../src/teams-call-quality.js";

vi.mock("../src/teams-call-quality.js", async original => ({
  ...await original<typeof import("../src/teams-call-quality.js")>(),
  collectCallQuality: vi.fn(),
}));
const chainId = "11111111-1111-4111-8111-111111111111";
const observation: CallQualityObservation = {
  callChainId: chainId, version: 1, startDateTime: "2026-10-26T16:00:00.000Z",
  endDateTime: "2026-10-26T16:00:10.000Z", audioStreamCount: 1, codecs: ["opus"],
  streamDirections: ["callerToCallee"], metrics: { jitterMs: { value: 10, sampleCount: 1 } },
};
const graph = new GraphClient({
  getToken: async () => ({ token: "fake-token", expiresOnTimestamp: Date.now() + 60000 }),
});
const settings = { enabled: true, maxWaitSeconds: 3, pollIntervalSeconds: 1 };
function fixture(withChain = true) {
  const result = baseResult({ id: "bot-target", type: "teams-call", cohort: "teams-global" }, Date.now());
  result.success = true;
  if (withChain) result.call = { callChainId: chainId, resultCodes: [] };
  const telemetry = { emit: vi.fn() };
  let clock = 0;
  return {
    cycle: { cycleId: "test-cycle", results: [result] }, telemetry,
    now: () => clock, sleep: async (ms: number) => { clock += ms; },
  };
}
beforeEach(() => { vi.mocked(collectCallQuality).mockReset(); });

describe("bounded post-call enrichment", () => {
  function completedPilot() {
    const f = fixture();
    f.cycle.results[0]!.call!.endedAt = "2026-10-26T16:00:10.000Z";
    f.cycle.results[0]!.diagnosticContext.cleanupSucceeded = true;
    return f;
  }
  it("waits beyond the meeting deadline for a 404, an empty first version and a later populated version", async () => {
    const empty = { ...observation, audioStreamCount: 0, metrics: {} };
    vi.mocked(collectCallQuality).mockResolvedValueOnce(undefined).mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ ...observation, version: 2 });
    const f = completedPilot();
    const quality = await collectAudioFeasibilityQuality(f.cycle, graph, {
      acknowledgeTenantWideCallRecords: true, maxWaitSeconds: 240, pollIntervalSeconds: 60,
    }, f.telemetry, new AbortController().signal, f.now, f.sleep);
    expect(quality.callQuality).toEqual([{ status: "available", observation: { ...observation, version: 2 } }]);
    expect(f.now()).toBe(120000);
    expect(collectCallQuality).toHaveBeenCalledTimes(3);
    expect(f.telemetry.emit).toHaveBeenCalledWith("teams-call-quality-record-empty", expect.objectContaining({ version: 1 }));
  });
  it("requires tenant-wide acknowledgement and verified two-leg cleanup before any pilot read", async () => {
    const f = completedPilot();
    await expect(collectAudioFeasibilityQuality(f.cycle, graph, { acknowledgeTenantWideCallRecords: false },
      f.telemetry, new AbortController().signal, f.now, f.sleep)).rejects.toThrow("tenant-wide");
    delete f.cycle.results[0]!.call!.endedAt;
    await expect(collectAudioFeasibilityQuality(f.cycle, graph, { acknowledgeTenantWideCallRecords: true },
      f.telemetry, new AbortController().signal, f.now, f.sleep)).rejects.toThrow("both calls ended");
    expect(collectCallQuality).not.toHaveBeenCalled();
  });
  it("does not mistake an empty initial record for a successful measurement at the pilot deadline", async () => {
    vi.mocked(collectCallQuality).mockResolvedValue({ ...observation, audioStreamCount: 0, metrics: {} });
    const f = completedPilot();
    const quality = await collectAudioFeasibilityQuality(f.cycle, graph, {
      acknowledgeTenantWideCallRecords: true, maxWaitSeconds: 3, pollIntervalSeconds: 1,
    }, f.telemetry, new AbortController().signal, f.now, f.sleep);
    expect(quality.callQuality).toMatchObject([{ status: "available", observation: { audioStreamCount: 0, metrics: {} } }]);
    expect(collectCallQuality).toHaveBeenCalledTimes(3);
    expect(f.now()).toBe(3000);
  });
  it("retries only an explicitly pending record and never re-runs or changes the journey", async () => {
    vi.mocked(collectCallQuality).mockResolvedValueOnce(undefined).mockResolvedValueOnce(observation);
    const f = fixture();
    const quality = await collectCycleCallQuality(f.cycle, graph, settings, f.telemetry,
      new AbortController().signal, f.now, f.sleep);
    expect(quality.callQuality).toEqual([{ status: "available", observation }]);
    expect(collectCallQuality).toHaveBeenCalledTimes(2);
    expect(f.cycle.results[0]?.success).toBe(true);
  });
  it("returns pending at its deadline without converting absent audio into zero or failure", async () => {
    vi.mocked(collectCallQuality).mockResolvedValue(undefined);
    const f = fixture();
    const quality = await collectCycleCallQuality(f.cycle, graph, settings, f.telemetry,
      new AbortController().signal, f.now, f.sleep);
    expect(quality.callQuality).toEqual([{ status: "pending", callChainId: chainId }]);
    expect(collectCallQuality).toHaveBeenCalledTimes(3);
    expect(f.now()).toBe(3000);
  });
  it("surfaces permission failures separately without repairing or failing the completed journey", async () => {
    vi.mocked(collectCallQuality).mockRejectedValue(new IntegrationError("permission-failure", 403));
    const f = fixture();
    const quality = await collectCycleCallQuality(f.cycle, graph, settings, f.telemetry,
      new AbortController().signal, f.now, f.sleep);
    expect(quality.callQuality).toEqual([{ status: "failed", callChainId: chainId, category: "permission-failure", httpStatus: 403 }]);
    expect(f.telemetry.emit).toHaveBeenCalledWith("teams-call-quality-failed", expect.objectContaining({ category: "permission-failure" }));
    expect(f.cycle.results[0]?.success).toBe(true);
    expect(collectCallQuality).toHaveBeenCalledTimes(1);
  });
  it("does not fetch tenant-wide calls when no correlated call chain was returned", async () => {
    const f = fixture(false);
    const quality = await collectCycleCallQuality(f.cycle, graph, settings, f.telemetry,
      new AbortController().signal, f.now, f.sleep);
    expect(quality.callQuality).toEqual([{ status: "unavailable" }]);
    expect(collectCallQuality).not.toHaveBeenCalled();
  });
  it("deduplicates call records and honors external cancellation", async () => {
    const f = fixture();
    f.cycle.results[0]!.call!.peerCallChainId = chainId;
    f.cycle.results.push(f.cycle.results[0]!);
    vi.mocked(collectCallQuality).mockResolvedValue(observation);
    const quality = await collectCycleCallQuality(f.cycle, graph, settings, f.telemetry,
      new AbortController().signal, f.now, f.sleep);
    expect(quality.callQuality).toHaveLength(1);
    expect(collectCallQuality).toHaveBeenCalledTimes(1);
    await expect(collectCycleCallQuality(f.cycle, graph, settings, f.telemetry, AbortSignal.abort(), f.now, f.sleep)).rejects.toThrow();
  });
  it("can enrich only a known peer chain when the primary chain was not returned", async () => {
    const f = fixture(false);
    f.cycle.results[0]!.call = { peerCallChainId: chainId, resultCodes: [] };
    vi.mocked(collectCallQuality).mockResolvedValue(observation);
    const quality = await collectCycleCallQuality(f.cycle, graph, settings, f.telemetry,
      new AbortController().signal, f.now, f.sleep);
    expect(quality.callQuality).toEqual([{ status: "available", observation }]);
    expect(collectCallQuality).toHaveBeenCalledExactlyOnceWith(graph, chainId, expect.any(AbortSignal));
  });
});
