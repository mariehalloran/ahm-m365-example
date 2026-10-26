import { describe, expect, it } from "vitest";
import { TeamsCallOperations } from "../../utils/src/teams-call-operations.js";

const callId = "57dab8b1-894c-409a-b240-bd8beae78896";
const operationId = "0fe0623f-d628-42ed-b4bd-8ac290072cc5";
const clientContext = "d45324c1-fcb5-430a-902c-f20af696537c";
const botClientId = "11111111-1111-4111-8111-111111111111";
const identity = { botClientId };
const operation = { "@odata.type": "#microsoft.graph.playPromptOperation" as const, id: operationId, clientContext, status: "running" as const };
function notification(options: {
  call?: string; operation?: string; context?: string; dataId?: string; resource?: string;
  type?: string; status?: string; code?: number; nullResultInfo?: boolean;
} = {}) {
  const resource = `/communications/calls/${options.call ?? callId}/operations/${options.operation ?? operationId}`;
  return { value: [{
    changeType: "deleted", resourceUrl: options.resource ?? resource,
    resourceData: {
      "@odata.type": options.type ?? operation["@odata.type"], "@odata.id": options.dataId ?? resource,
      status: options.status ?? "completed", clientContext: options.context ?? clientContext,
      resultInfo: options.nullResultInfo ? null : { code: options.code ?? 200 },
    },
  }] };
}

describe("ephemeral authenticated playPrompt correlation", () => {
  it("matches the documented compact uppercase GUID callback to the actual POST operation", () => {
    const store = new TeamsCallOperations();
    const attempt = store.register(callId, clientContext, 1000, botClientId);
    attempt.bind(operation);
    store.accept(notification({ call: callId.replaceAll("-", "").toUpperCase(), operation: operationId.replaceAll("-", "").toUpperCase() }), identity);
    expect(attempt.observation()?.status).toBe("completed");
    attempt.dispose();
    expect(attempt.observation()).toBeUndefined();
  });
  it("buffers only an active attempt before POST completion, then matches the actual returned ID", () => {
    const store = new TeamsCallOperations();
    const attempt = store.register(callId, clientContext, 1000, botClientId);
    store.accept(notification({ operation: "other-operation" }), identity);
    store.accept(notification(), identity);
    expect(attempt.observation()).toBeUndefined();
    attempt.bind(operation);
    expect(attempt.observation()?.status).toBe("completed");
    attempt.dispose();
  });
  it("accepts explicit null resultInfo as absent Graph data, but still requires a completed callback", () => {
    const store = new TeamsCallOperations();
    const attempt = store.register(callId, clientContext, 1000, botClientId);
    attempt.bind({ ...operation, resultInfo: null });
    expect(attempt.observation()).toBeUndefined();
    store.accept(notification({ status: "running", nullResultInfo: true }), identity);
    expect(attempt.observation()?.status).toBe("running");
    store.accept(notification({ status: "completed", nullResultInfo: true }), identity);
    expect(attempt.observation()?.status).toBe("completed");
    attempt.dispose();
  });
  it.each([
    { call: "other-call" }, { operation: "other-operation" },
    { context: "11111111-1111-4111-8111-111111111111" },
    { dataId: `/communications/calls/other-call/operations/${operationId}` },
    { type: "#microsoft.graph.recordOperation" }, { resource: `https://untrusted.invalid/communications/calls/${callId}/operations/${operationId}` },
    { call: "../other-call" }, { status: "unknownFutureValue" },
  ])("ignores nonmatching or unsupported callback %j", options => {
    const store = new TeamsCallOperations();
    const attempt = store.register(callId, clientContext, 1000, botClientId);
    attempt.bind(operation);
    store.accept(notification(options), identity);
    expect(attempt.observation()).toBeUndefined();
    attempt.dispose();
  });
  it("rejects a response with a different clientContext or a failed status", () => {
    const store = new TeamsCallOperations();
    const attempt = store.register(callId, clientContext, 1000, botClientId);
    expect(() => attempt.bind({ ...operation, clientContext: "11111111-1111-4111-8111-111111111111" })).toThrow();
    expect(() => attempt.bind({ ...operation, status: "failed" })).toThrow();
    attempt.dispose();
  });
  it("expires attempts, bounds capacity and never retains observations across disposal/cycles", () => {
    let now = 0;
    const store = new TeamsCallOperations(() => now);
    const attempt = store.register(callId, clientContext, 1000, botClientId);
    attempt.bind(operation);
    now = 1000;
    store.accept(notification(), identity);
    expect(attempt.observation()).toBeUndefined();
    const next = store.register(callId, clientContext, 1000, botClientId);
    next.bind(operation);
    expect(next.observation()).toBeUndefined();
    next.dispose();
    for (let index = 0; index < 32; index++) {
      store.register(callId, `d45324c1-fcb5-430a-902c-${String(index).padStart(12, "0")}`, 1000, botClientId);
    }
    expect(() => store.register(callId, clientContext, 1000, botClientId)).toThrow();
    store.shutdown();
    store.register(callId, clientContext, 1000, botClientId).dispose();
  });
  it("ignores notifications before registration and after a terminal result", () => {
    const store = new TeamsCallOperations();
    store.accept(notification(), identity);
    const attempt = store.register(callId, clientContext, 1000, botClientId);
    attempt.bind(operation);
    expect(attempt.observation()).toBeUndefined();
    store.accept(notification({ status: "failed", code: 500 }), identity);
    store.accept(notification(), identity);
    expect(attempt.observation()?.status).toBe("failed");
    attempt.dispose();
  });
  it.each([false, true])("requires the owning bot audience, including a callback arriving before bind=%s", beforeBind => {
    const store = new TeamsCallOperations();
    const attempt = store.register(callId, clientContext, 1000, botClientId);
    if (!beforeBind) attempt.bind(operation);
    store.accept(notification(), { botClientId: "22222222-2222-4222-8222-222222222222" });
    if (beforeBind) attempt.bind(operation);
    expect(attempt.observation()).toBeUndefined();
    store.accept(notification(), identity);
    expect(attempt.observation()?.status).toBe("completed");
    attempt.dispose();
  });
  it.each(["", "not-an-application", "https://graph.microsoft.com"])("rejects missing or invalid explicit operation audience %s", bot => {
    const store = new TeamsCallOperations();
    expect(() => store.register(callId, clientContext, 1000, bot)).toThrow("configuration-failure");
    store.shutdown();
  });
});
