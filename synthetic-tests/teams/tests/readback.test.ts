import { describe, expect, it, vi } from "vitest";
import { GraphClient, graphBase } from "../../utils/src/graph.js";
import { confirmReply, type ChannelReplyAttempt } from "../src/steps.js";

const applicationId = "22222222-2222-4222-8222-222222222222";
const messagesPath = "/teams/team/channels/19%3Atest%40thread.tacv2/messages";
const rootId = "graph/root?owned";
const repliesPath = `${messagesPath}/${encodeURIComponent(rootId)}/replies`;

function fixture(read?: (path: string, count: number, marker: string) => Response) {
  let clock = 0;
  let reads = 0;
  const controller = new AbortController();
  const attempt: ChannelReplyAttempt = {
    serviceUrl: "", tenantId: "tenant", teamId: "team", channelId: "19:test@thread.tacv2",
    graphRootId: rootId, mutationAttempted: true, replyMutationAttempted: true,
    marker: "unique root marker", replyMarker: "unique reply marker",
    created: { conversationId: "bot-conversation", activityId: "bot-root" }, reply: { activityId: "bot-reply" },
  };
  const fetcher = vi.fn<typeof fetch>(async input => {
    const path = String(input).slice(graphBase.length);
    const marker = path.startsWith(`${repliesPath}?`) ? attempt.replyMarker : attempt.marker;
    return read?.(path, ++reads, marker) ?? Response.json({ value: [message(marker)] });
  });
  const graph = new GraphClient({
    getToken: async () => ({ token: "fake-unit-test", expiresOnTimestamp: Date.now() + 60000 }),
  }, { fetch: fetcher, attempts: 1 });
  const confirm = () => confirmReply(graph, applicationId, attempt, controller.signal, 100, 10,
    () => clock, async ms => { clock += ms; });
  return { confirm, attempt, controller, fetcher, advance: (ms: number) => { clock += ms; } };
}

function message(marker: string) {
  return {
    id: "graph-reply", deletedDateTime: null as string | null,
    body: { contentType: "html", content: `<p>${marker}</p>` },
    from: { application: { id: applicationId } },
  };
}

describe("bot thread readback", () => {
  it("uses only the Graph-confirmed root, not a Bot Connector activity ID or a delegated endpoint", async () => {
    const { confirm, fetcher } = fixture();
    await expect(confirm()).resolves.toBeUndefined();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${graphBase}${repliesPath}?$top=50`]);
  });

  it("requires root author/correlation evidence first if it was not already confirmed", async () => {
    const f = fixture((path, _count, marker) => Response.json({
      value: [{ ...message(marker), from: { application: { id: path.startsWith(`${messagesPath}?`) ? "wrong-author" : applicationId } } }],
    }));
    delete f.attempt.graphRootId;
    await expect(f.confirm()).rejects.toMatchObject({ category: "delivery-timeout" });
    expect(f.fetcher.mock.calls.every(([url]) => String(url) === `${graphBase}${messagesPath}?$top=50`)).toBe(true);
  });

  it.each(["author", "correlation", "deleted", "html", "human"] as const)("does not confirm mismatched reply %s", async mismatch => {
    const { confirm } = fixture((_path, _count, marker) => {
      const item = message(marker);
      if (mismatch === "author") item.from.application.id = "other-bot";
      if (mismatch === "correlation") item.body.content += " extra";
      if (mismatch === "deleted") item.deletedDateTime = "2026-10-23T00:00:00Z";
      if (mismatch === "html") item.body.content = `<script>${marker}</script>`;
      return Response.json({ value: [{ ...item, ...(mismatch === "human" ? { from: { user: { id: applicationId } } } : {}) }] });
    });
    await expect(confirm()).rejects.toMatchObject({ category: "delivery-timeout" });
  });

  it("follows only a continuation for the exact confirmed thread", async () => {
    const { confirm, fetcher } = fixture((_path, count, marker) => Response.json(count === 1
      ? { value: [], "@odata.nextLink": `${graphBase}${repliesPath}?$skiptoken=second` }
      : { value: [message(marker)] }));
    await expect(confirm()).resolves.toBeUndefined();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${graphBase}${repliesPath}?$top=50`, `${graphBase}${repliesPath}?$skiptoken=second`,
    ]);
  });

  it.each([
    `https://attacker.invalid/v1.0${repliesPath}?$skiptoken=x`,
    `${graphBase}${messagesPath}/another-root/replies?$skiptoken=x`,
    `${graphBase}${messagesPath}?$skiptoken=x`,
    `${graphBase}${repliesPath}?$expand=anything&$skiptoken=x`,
    `${graphBase}${repliesPath}?$skiptoken=x&$skiptoken=y`,
  ])("never follows an unapproved reply continuation %s", async next => {
    const { confirm, fetcher } = fixture(() => Response.json({ value: [], "@odata.nextLink": next }));
    await expect(confirm()).rejects.toMatchObject({ category: "read-failure" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([403, 503])("preserves reply read HTTP %s without fallback", async status => {
    const { confirm, fetcher } = fixture(() => new Response(null, { status }));
    await expect(confirm()).rejects.toMatchObject({ status });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not read after cancellation or accept a response returned past the deadline", async () => {
    const cancelled = fixture();
    cancelled.controller.abort();
    await expect(cancelled.confirm()).rejects.toThrow();
    expect(cancelled.fetcher).not.toHaveBeenCalled();
    const late = fixture((_path, _count, marker) => { late.advance(101); return Response.json({ value: [message(marker)] }); });
    await expect(late.confirm()).rejects.toMatchObject({ category: "read-failure" });
  });

  it.each(["", ".", "..", " bad", "bad\u0000id"])("rejects unsafe Graph root IDs before any reply read: %s", id => {
    const { attempt, confirm, fetcher } = fixture();
    attempt.graphRootId = id;
    return expect(confirm()).rejects.toMatchObject({ category: "read-failure" }).then(() => {
      expect(fetcher).not.toHaveBeenCalled();
    });
  });
});
