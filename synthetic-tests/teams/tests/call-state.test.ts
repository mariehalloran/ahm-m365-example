import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../../utils/src/graph.js";
import { AuthenticatedHttp } from "../../utils/src/http.js";
import { leaveCall, waitBeforeHangup } from "../src/call-steps.js";

function fixture(responses: Response[]) {
  let now = 0;
  const fetcher = vi.fn<typeof fetch>(async () => responses.shift() ?? Response.json({ id: "owned-call", state: "establishing" }));
  const graph = new GraphClient(new AuthenticatedHttp({
    getToken: async () => ({ token: "fake-test", expiresOnTimestamp: Date.now() + 60000 }),
  }, "unused", { fetch: fetcher, attempts: 1 }));
  return { graph, fetcher, now: () => now, sleep: async (ms: number) => { now += ms; } };
}
const call = (state: string, id = "owned-call") => Response.json({ id, state });
const signal = () => new AbortController().signal;

describe("owned call placement dwell and verified disconnection", () => {
  it.each(["establishing", "ringing", "established", "hold"])(
    "waits the configured duration in %s without claiming recipient receipt", async state => {
      const current = fixture(Array.from({ length: 3 }, () => call(state)));
      await waitBeforeHangup(current.graph, "owned-call", signal(), 30, 10, current.now, current.sleep);
      expect(current.now()).toBe(30);
      expect(current.fetcher).toHaveBeenCalledTimes(3);
    },
  );
  it.each(["terminated", "404"])("DELETE acceptance requires subsequent GET proof: %s", async state => {
    const current = fixture([
      new Response(null, { status: 202 }), call("terminating"),
      state === "404" ? new Response(null, { status: 404 }) : call("terminated"),
    ]);
    await leaveCall(current.graph, "owned-call", signal(), 100, 10, current.now, current.sleep);
    expect(current.fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["DELETE", "GET", "GET"]);
  });
  it("does not count DELETE 204 as successful hang-up when GET still shows established", async () => {
    const current = fixture([new Response(null, { status: 204 }), ...Array.from({ length: 10 }, () => call("established"))]);
    await expect(leaveCall(current.graph, "owned-call", signal(), 30, 10, current.now, current.sleep))
      .rejects.toMatchObject({ category: "delivery-timeout" });
  });
  it.each([call("terminated"), call("terminating"), new Response(null, { status: 404 }), call("established", "other-call")])(
    "fails dwell honestly on early termination, missing or mismatched call", async response => {
      const current = fixture([response]);
      await expect(waitBeforeHangup(current.graph, "owned-call", signal(), 30, 10, current.now, current.sleep))
        .rejects.toMatchObject({ category: "read-failure" });
    },
  );
  it.each(["", ".", "..", " owned-call", "bad\u0000id"])("rejects invalid call IDs before HTTP: %s", async id => {
    const current = fixture([]);
    await expect(leaveCall(current.graph, id, signal(), 30, 10, current.now, current.sleep)).rejects.toThrow();
    expect(current.fetcher).not.toHaveBeenCalled();
  });
  it("exposes only allowlisted state and numeric terminal codes, never response bodies or messages", async () => {
    const current = fixture([Response.json({
      id: "owned-call", state: "terminated",
      resultInfo: { code: 480, subcode: 12345, message: "PRIVATE account identity" },
      targets: [{ identity: { user: { id: "PRIVATE-USER-ID" } } }],
    })]);
    const onState = vi.fn();
    await expect(waitBeforeHangup(current.graph, "owned-call", signal(), 30, 10,
      current.now, current.sleep, onState)).rejects.toMatchObject({ category: "read-failure" });
    expect(onState).toHaveBeenCalledExactlyOnceWith("terminated", 480, 12345);
    expect(JSON.stringify(onState.mock.calls)).not.toContain("PRIVATE");
  });
  it("fails a numeric service failure even before terminal state", async () => {
    const current = fixture([Response.json({
      id: "owned-call", state: "establishing", resultInfo: { code: 500, subcode: 42 },
    })]);
    await expect(waitBeforeHangup(current.graph, "owned-call", signal(), 30, 10, current.now, current.sleep))
      .rejects.toMatchObject({ category: "read-failure" });
  });
  it("does not echo unknown state strings or malformed numeric diagnostics", async () => {
    const current = fixture([Response.json({
      id: "owned-call", state: "PRIVATE-UNRECOGNIZED-STATE",
      resultInfo: { code: "PRIVATE-MESSAGE", subcode: 12 },
    }), call("establishing")]);
    const onState = vi.fn();
    await waitBeforeHangup(current.graph, "owned-call", signal(), 20, 10,
      current.now, current.sleep, onState);
    expect(onState.mock.calls).toEqual([["unknown", undefined, undefined], ["establishing", undefined, undefined]]);
  });
});
