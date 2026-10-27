import { describe, expect, it } from "vitest";
import { playPromptOperationSchema, promptOperationFailed, TeamsCallOperations } from "../../utils/src/teams-call-operations.js";
import { startTeamsCallingCallback } from "../../utils/src/teams-calling-callback.js";

const callId = "57dab8b1-894c-409a-b240-bd8beae78896";
const operationId = "0fe0623f-d628-42ed-b4bd-8ac290072cc5";
const clientContext = "d45324c1-fcb5-430a-902c-f20af696537c";
const botClientId = "11111111-1111-4111-8111-111111111111";
const identity = { botClientId };
const operation = playPromptOperationSchema.parse({
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#communications/calls/operations/$entity",
  id: operationId, clientContext, status: "Running", resultInfo: null,
});
function notification(overrides: {
  call?: string; operation?: string; context?: string; status?: string; code?: unknown; dataId?: string; type?: string;
} = {}) {
  const resource = `/communications/calls/${overrides.call ?? callId}/operations/${overrides.operation ?? operationId}`;
  return { value: [{
    changeType: "deleted", resourceUrl: resource,
    resourceData: {
      "@odata.type": overrides.type ?? "#microsoft.graph.playPromptOperation",
      "@odata.id": overrides.dataId ?? resource, clientContext: overrides.context ?? clientContext,
      status: overrides.status ?? "Completed", resultInfo: overrides.code === undefined ? null : { code: overrides.code },
    },
  }] };
}

describe("pilot-only authenticated operation completion", () => {
  it("accepts OData context/PascalCase/nullable results and correlates an early compact-GUID callback, never HTTP acceptance alone", () => {
    const store = new TeamsCallOperations();
    const attempt = store.register(callId, clientContext, 1000, botClientId);
    store.accept(notification({ operation: "other-operation" }), identity);
    store.accept(notification({
      call: callId.replaceAll("-", "").toUpperCase(), operation: operationId.replaceAll("-", "").toUpperCase(),
    }), identity);
    expect(attempt.observation()).toBeUndefined();
    attempt.bind(operation);
    expect(attempt.observation()?.status).toBe("completed");
    attempt.dispose();
    const next = store.register(callId, clientContext, 1000, botClientId);
    next.bind(operation);
    expect(next.observation()).toBeUndefined();
    next.dispose();
  });
  it.each([
    { call: "foreign-call" }, { operation: "foreign-operation" },
    { context: "22222222-2222-4222-8222-222222222222" },
    { dataId: `/communications/calls/foreign-call/operations/${operationId}` },
    { dataId: `https://graph.microsoft.com/v1.0/communications/calls/${callId}/operations/${operationId}` },
    { type: "#microsoft.graph.recordOperation" }, { status: "unknownFutureValue" }, { code: "200" },
  ])("ignores malformed or mismatched completion %j", overrides => {
    const store = new TeamsCallOperations();
    const attempt = store.register(callId, clientContext, 1000, botClientId);
    attempt.bind(operation);
    store.accept(notification(overrides), identity);
    expect(attempt.observation()).toBeUndefined();
    attempt.dispose();
  });
  it.each([{ status: "Failed" }, { status: "Completed", code: 500 }])("preserves terminal failure %j", overrides => {
    const store = new TeamsCallOperations();
    const attempt = store.register(callId, clientContext, 1000, botClientId);
    attempt.bind(operation);
    store.accept(notification(overrides), identity);
    store.accept(notification(), identity);
    expect(promptOperationFailed(attempt.observation()!)).toBe(true);
    attempt.dispose();
  });
  it("rejects a response for another context and ignores expired/disposed attempts", () => {
    let clock = 0;
    const store = new TeamsCallOperations(() => clock);
    const attempt = store.register(callId, clientContext, 1000, botClientId);
    expect(() => attempt.bind({ ...operation, clientContext: botClientId })).toThrow("read-failure");
    attempt.bind(operation);
    clock = 1000;
    store.accept(notification(), identity);
    expect(attempt.observation()).toBeUndefined();
    store.shutdown();
  });
  it("accepts completion only through the verified primary-audience listener, not unsigned/rejected/peer callbacks", async () => {
    const store = new TeamsCallOperations();
    const attempt = store.register(callId, clientContext, 10000, botClientId);
    attempt.bind(operation);
    const server = await startTeamsCallingCallback({
      port: 0, host: "127.0.0.1",
      verify: async token => {
        if (token === "primary") return identity;
        if (token === "peer") return { botClientId: "22222222-2222-4222-8222-222222222222" };
        throw new Error("invalid signature or tenant");
      },
      onNotification: (body, identity) => store.accept(body, identity),
    });
    const send = (token?: string) => fetch(`http://127.0.0.1:${server.port}/api/calls`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(notification()),
    });
    try {
      expect((await send()).status).toBe(401);
      expect((await send("invalid")).status).toBe(401);
      expect((await send("peer")).status).toBe(200);
      expect(attempt.observation()).toBeUndefined();
      expect((await send("primary")).status).toBe(200);
      expect(attempt.observation()?.status).toBe("completed");
    } finally { attempt.dispose(); await server.shutdown(); }
  });
});
