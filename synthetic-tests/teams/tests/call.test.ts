import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../../utils/src/graph.js";
import { AuthenticatedHttp } from "../../utils/src/http.js";
import { resultSchema, reportedResult, type Probe } from "../../utils/src/contracts.js";
import { teamsCallProbe } from "../src/call.js";
import { simulate } from "../../utils/src/probes.js";

const probe: Probe = {
  id: "teams-test-call", type: "teams-call", cohort: "teams-global",
  tenantId: "11111111-1111-4111-8111-111111111111",
  callUserId: "22222222-2222-4222-8222-222222222222",
};
function fixture(options: {
  uncertainCreate?: boolean; earlyTermination?: boolean; deleteFailure?: boolean;
  terminateFailure?: boolean; abortOnRead?: boolean; established?: boolean; failFirstDelete?: boolean;
} = {}) {
  let clock = 0, deleted = false;
  let deleteAttempts = 0;
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/communications\/calls(?:\/owned-call)?$/);
    if (init?.method === "POST") {
      if (options.uncertainCreate) throw new Error("ambiguous network outcome");
      return Response.json({ id: "owned-call", state: "establishing" }, { status: 201 });
    }
    if (init?.method === "DELETE") {
      deleteAttempts++;
      expect(init.signal?.aborted).toBe(false);
      if (options.deleteFailure || (options.failFirstDelete && deleteAttempts === 1)) return new Response(null, { status: 403 });
      deleted = true;
      return new Response(null, { status: 204 });
    }
    if (options.abortOnRead && !deleted) controller.abort();
    return Response.json({
      id: "owned-call",
      state: deleted ? options.terminateFailure ? "established" : "terminated"
        : options.earlyTermination ? "terminated" : options.established ? "established" : "establishing",
    });
  });
  const graph = new GraphClient(new AuthenticatedHttp({
    getToken: async () => ({ token: "fake-bot-token", expiresOnTimestamp: Date.now() + 60000 }),
  }, "00000003-0000-0000-c000-000000000000/.default", { fetch: fetcher, attempts: 1 }));
  const context = {
    config: {
      SYNTHETIC_SCENARIO: "healthy" as const, PROBE_TIMEOUT_MS: 15000, POLL_INTERVAL_MS: 250,
      TEAMS_CALLING_WAIT_SECONDS: 10,
      TEAMS_CLEANUP_ENABLED: "false" as const, TEAMS_CALLING_CALLBACK_URL: "https://approved.example.invalid/api/calls",
    },
    teamsCalling: graph, signal: controller.signal, telemetry: { emit: vi.fn() },
    now: () => clock, sleep: async (ms: number) => { clock += ms; },
  };
  return { context, fetcher };
}

describe("service-hosted individual call placement, wait and hang-up", () => {
  it("uses official individual call JSON, configured dwell and verified hang-up despite message retention", async () => {
    const { context, fetcher } = fixture();
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(true);
    expect(reportedResult(result).steps.map(step => step.name)).toEqual(["place-call", "wait-before-hangup", "end-call"]);
    expect(result.durationMs).toBe(10000);
    expect(result.steps.find(step => step.name === "wait-before-hangup")).toMatchObject({ status: "succeeded", durationMs: 10000 });
    expect(result.sendDurationMs).toBeUndefined();
    expect(result.publicationDurationMs).toBeUndefined();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe("GET");
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      "@odata.type": "#microsoft.graph.call",
      callbackUri: context.config.TEAMS_CALLING_CALLBACK_URL, requestedModalities: ["audio"],
      mediaConfig: { "@odata.type": "#microsoft.graph.serviceHostedMediaConfig" },
      targets: [{ identity: { user: { id: probe.callUserId } } }],
      tenantId: probe.tenantId,
    });
    expect(context.telemetry.emit.mock.calls.some(([event]) => event === "teams-cleanup-disabled")).toBe(false);
    expect(context.telemetry.emit.mock.calls.some(([event]) => event.includes("ringing"))).toBe(false);
  });
  it.each(["earlyTermination", "abortOnRead"] as const)(
    "records actual business hang-up using an independent signal after %s wait failure", async failure => {
      const { context, fetcher } = fixture({ [failure]: true });
      const result = resultSchema.parse(await teamsCallProbe(probe, context));
      expect(result.success).toBe(false);
      expect(result.steps.find(step => step.name === "wait-before-hangup")?.status).toBe("failed");
      expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
      expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
      expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
    },
  );
  it.each(["deleteFailure", "terminateFailure"] as const)(
    "fails business hang-up and attempts bounded final cleanup after %s", async failure => {
      const { context, fetcher } = fixture({ [failure]: true });
      const result = resultSchema.parse(await teamsCallProbe(probe, context));
      expect(result.success).toBe(false);
      expect(result.steps.find(step => step.name === "wait-before-hangup")?.status).toBe("succeeded");
      expect(result.steps.find(step => step.name === "end-call")?.status).toBe("failed");
      expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
      expect(result.durationMs).toBeLessThanOrEqual(20000);
    },
  );
  it("never retries uncertain creation or guesses a call ID for cleanup", async () => {
    const { context, fetcher } = fixture({ uncertainCreate: true });
    const result = await teamsCallProbe(probe, context);
    expect(result.success).toBe(false);
    expect(result.diagnosticContext.cleanupSucceeded).toBe(false);
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("skipped");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(context.telemetry.emit).toHaveBeenCalledWith("teams-call-unknown-creation-outcome", expect.anything());
  });
  it("keeps failed business hang-up unhealthy when independent fallback cleanup succeeds", async () => {
    const { context, fetcher } = fixture({ failFirstDelete: true });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(false);
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("failed");
    expect(result.diagnosticContext.cleanupSucceeded).toBe(true);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
    expect(context.telemetry.emit).toHaveBeenCalledWith("teams-call-disconnected", expect.objectContaining({ phase: "cleanup" }));
  });
  it("never uses an observer/delegated Graph client as a calling fallback", async () => {
    const { context, fetcher } = fixture();
    const { teamsCalling, ...withoutCalling } = context;
    const result = await teamsCallProbe(probe, { ...withoutCalling, graph: teamsCalling });
    expect(result.diagnosticCategory).toBe("configuration-failure");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("simulates placement/wait/end without network or recipient-receipt claims", async () => {
    const { context, fetcher } = fixture();
    const result = resultSchema.parse(await simulate(probe, context));
    expect(result.success).toBe(true);
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not treat an established/possibly answered call as proof of receipt or skip the dwell", async () => {
    const { context } = fixture({ established: true });
    const result = resultSchema.parse(await teamsCallProbe(probe, context));
    expect(result.success).toBe(true);
    expect(result.durationMs).toBe(10000);
    expect(context.telemetry.emit.mock.calls.some(([event]) => event.includes("ringing"))).toBe(false);
  });
  it("bounds repeated state diagnostics and separates wait from end state", async () => {
    const { context } = fixture();
    const result = await teamsCallProbe(probe, context);
    expect(result.success).toBe(true);
    const events = context.telemetry.emit.mock.calls.filter(([event]) => event === "teams-call-state-observed");
    expect(events).toHaveLength(2);
    expect(events.map(([, data]) => data.phase)).toEqual(["wait", "end"]);
  });
  it("ends the created call even if configuration leaves insufficient wait budget", async () => {
    const { context, fetcher } = fixture();
    context.config.PROBE_TIMEOUT_MS = 5000;
    const result = await teamsCallProbe(probe, context);
    expect(result.success).toBe(false);
    expect(result.steps.find(step => step.name === "end-call")?.status).toBe("succeeded");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });
});
