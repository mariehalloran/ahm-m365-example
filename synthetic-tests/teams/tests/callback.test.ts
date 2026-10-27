import { afterEach, describe, expect, it, vi } from "vitest";
import { startTeamsCallingCallback } from "../../utils/src/teams-calling-callback.js";

const servers: Awaited<ReturnType<typeof startTeamsCallingCallback>>[] = [];
const identity = { botClientId: "11111111-1111-4111-8111-111111111111" };
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.shutdown())); });

async function fixture(accept = true) {
  const verify = vi.fn(async (_token: string) => {
    if (!accept) throw new Error("private verification details");
    return identity;
  });
  const server = await startTeamsCallingCallback({ port: 0, host: "127.0.0.1", verify });
  servers.push(server);
  return { verify, url: `http://127.0.0.1:${server.port}` };
}
const post = (url: string, body: string, token = "test-only") => fetch(`${url}/api/calls`, {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
});

describe("bounded Teams-only callback listener", () => {
  it("fails an occupied callback port rather than borrowing another worker's listener", async () => {
    const { url } = await fixture();
    await expect(startTeamsCallingCallback({
      port: Number(new URL(url).port), host: "127.0.0.1", verify: async () => identity,
    })).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(await (await fetch(`${url}/healthz`)).text()).toBe("ready\n");
  });
  it.each([
    "/media/test-tone.wav", "/media/test-tone.wav?file=other",
    "/media/other.wav", "/media/test-tone.wav/extra",
  ])("does not expose the retired media endpoint %s", async path => {
    const { url, verify } = await fixture();
    expect((await fetch(`${url}${path}`)).status).toBe(404);
    expect((await fetch(`${url}${path}`, { method: "POST" })).status).toBe(404);
    expect(verify).not.toHaveBeenCalled();
  });
  it("dispatches call notifications only after verifying their signed identity", async () => {
    const listener = vi.fn();
    const server = await startTeamsCallingCallback({
      port: 0, host: "127.0.0.1", verify: async token => {
        if (token !== "approved") throw new Error("denied");
        return identity;
      },
      onNotification: listener,
    });
    servers.push(server);
    const resource = "/communications/calls/owned-call";
    const body = JSON.stringify({ value: [{
      changeType: "updated", resourceUrl: resource,
      resourceData: { "@odata.type": "#microsoft.graph.call", id: "owned-call", state: "established" },
    }] });
    const url = `http://127.0.0.1:${server.port}`;
    expect((await post(url, body, "unapproved")).status).toBe(401);
    expect(listener).not.toHaveBeenCalled();
    expect((await post(url, body, "approved")).status).toBe(200);
    expect(listener).toHaveBeenCalledExactlyOnceWith(JSON.parse(body), identity);
  });
  it("reports only bounded rejection status/stage metadata, never authentication or notification contents", async () => {
    const onRejected = vi.fn();
    const server = await startTeamsCallingCallback({
      port: 0, host: "127.0.0.1",
      verify: async () => { throw new Error("PRIVATE verification message"); }, onRejected,
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}`;
    for (let request = 0; request < 12; request++) {
      expect((await post(url, '{"private":"PRIVATE notification contents"}', "PRIVATE-token")).status).toBe(401);
    }
    expect(onRejected).toHaveBeenCalledTimes(10);
    expect(onRejected.mock.calls.every(call => call[0] === 401 && call[1] === "verification")).toBe(true);
    expect(onRejected.mock.calls[0]?.[2]).toEqual({ authErrorCode: "AUTHENTICATION_FAILED" });
    expect(JSON.stringify(onRejected.mock.calls)).not.toContain("PRIVATE");
  });
  it("bounds positive authenticated callback diagnostics independently from rejection diagnostics", async () => {
    const onAccepted = vi.fn();
    const server = await startTeamsCallingCallback({
      port: 0, host: "127.0.0.1", verify: async () => identity, onAccepted,
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}`;
    for (let request = 0; request < 12; request++) {
      expect((await post(url, '{"private":"never-log-or-echo"}')).status).toBe(200);
    }
    expect(onAccepted).toHaveBeenCalledTimes(10);
    expect(onAccepted.mock.calls.every(call => call.length === 0)).toBe(true);
  });
  it("serves static app metadata and readiness without exposing tenant/identity/config/notification data", async () => {
    const { url, verify } = await fixture();
    const about = await fetch(`${url}/about`);
    expect(about.status).toBe(200);
    expect(about.headers.get("content-type")).toContain("text/plain");
    const text = await about.text();
    expect(text).toContain("Dedicated test resources only");
    expect(text).toContain("no user token cache");
    expect(text).toContain("Not for production");
    expect(await (await fetch(`${url}/healthz`)).text()).toBe("ready\n");
    expect(verify).not.toHaveBeenCalled();
  });
  it("authenticates before acknowledging notifications and returns no payload", async () => {
    const { url, verify } = await fixture();
    const response = await post(url, JSON.stringify({ value: [{ privateContent: "never-echo-this" }] }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(verify).toHaveBeenCalledExactlyOnceWith("test-only");
  });
  it("fails closed for missing/invalid authentication without error or payload disclosure", async () => {
    const { url, verify } = await fixture(false);
    expect((await fetch(`${url}/api/calls`, { method: "POST" })).status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
    const denied = await post(url, '{"private":"never-echo"}');
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe("");
  });
  it("bounds body size and rejects malformed JSON and unsupported media types", async () => {
    const { url } = await fixture();
    expect((await post(url, "{")).status).toBe(400);
    expect((await post(url, "[]")).status).toBe(400);
    expect((await post(url, JSON.stringify({ padding: "x".repeat(65536) }))).status).toBe(413);
    expect((await fetch(`${url}/api/calls`, {
      method: "POST", headers: { Authorization: "Bearer test-only", "Content-Type": "text/plain" }, body: "{}",
    })).status).toBe(415);
  });
  it("does not expose alternate callback paths or methods", async () => {
    const { url } = await fixture();
    expect((await fetch(`${url}/api/calls`)).status).toBe(404);
    expect((await fetch(`${url}/about?config=true`)).status).toBe(404);
    expect((await fetch(`${url}/unknown`, { method: "POST" })).status).toBe(404);
  });
});
