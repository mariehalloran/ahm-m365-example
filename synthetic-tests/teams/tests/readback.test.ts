import { describe, expect, it, vi } from "vitest";
import { GraphClient, graphBase } from "../../utils/src/graph.js";
import { AuthenticatedHttp } from "../../utils/src/http.js";
import { confirmPublication, confirmReply, type ChannelReplyAttempt } from "../src/steps.js";

const userId = "22222222-2222-4222-8222-222222222222";
const messagesPath = "/teams/team/channels/19%3Atest%40thread.tacv2/messages";
const parentId = "parent/known?owned";
const replyId = "reply/known?owned";
const parentPath = `${messagesPath}/${encodeURIComponent(parentId)}`;
const replyPath = `${parentPath}/replies/${encodeURIComponent(replyId)}`;

function fixture(reply: boolean, read?: (path: string, count: number, item: ReturnType<typeof message>) => Response) {
  let clock = 0;
  let reads = 0;
  const controller = new AbortController();
  const attempt: ChannelReplyAttempt = {
    serviceUrl: "", tenantId: "tenant", teamId: "team", channelId: "19:test@thread.tacv2",
    userDelegated: true, mutationAttempted: true, replyMutationAttempted: true,
    marker: "unique root marker", replyMarker: "unique reply marker",
    created: { conversationId: messagesPath, activityId: parentId }, reply: { activityId: replyId },
  };
  const fetcher = vi.fn<typeof fetch>(async input => {
    const path = String(input).slice(graphBase.length);
    // Any collection scan fails: a populated channel's unrelated messages/pages are irrelevant.
    if (![parentPath, replyPath].includes(path)) throw new Error("Unexpected collection or unowned-ID request");
    const isReply = path === replyPath;
    const item = message(isReply ? replyId : parentId, isReply ? attempt.replyMarker : attempt.marker);
    return read?.(path, ++reads, item) ?? Response.json(item);
  });
  const graph = new GraphClient(new AuthenticatedHttp({
    getToken: async () => ({ token: "fake-unit-test", expiresOnTimestamp: Date.now() + 60000 }),
  }, "unused", { fetch: fetcher, attempts: 1 }));
  const confirm = () => (reply ? confirmReply : confirmPublication)(
    graph, userId, attempt, controller.signal, 100, 10, () => clock, async ms => { clock += ms; },
  );
  return { confirm, attempt, controller, fetcher, advance: (ms: number) => { clock += ms; } };
}

function message(id: string, marker: string) {
  return {
    id, deletedDateTime: null as string | null, body: { contentType: "html", content: `<p>${marker}</p>` },
    from: { user: { id: userId } },
  };
}

describe.each([false, true])("exact owned-ID delegated readback (reply=%s)", reply => {
  it("reads only known parent/reply IDs, independently of collection size or canonical next links", async () => {
    const { confirm, fetcher } = fixture(reply, (_path, _count, item) => Response.json({
      ...item, "@odata.nextLink": "https://attacker.invalid/unrelated-collection",
    }));
    await expect(confirm()).resolves.toBeUndefined();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(
      (reply ? [parentPath, replyPath] : [parentPath]).map(path => `${graphBase}${path}`),
    );
  });

  it("polls a not-yet-visible known ID after 404 without scanning or repeating POST", async () => {
    const { confirm, fetcher } = fixture(reply, (path, count, item) =>
      count === (reply ? 2 : 1) && path === (reply ? replyPath : parentPath)
        ? new Response(null, { status: 404 }) : Response.json(item));
    await expect(confirm()).resolves.toBeUndefined();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(
      (reply ? [parentPath, replyPath, replyPath] : [parentPath, parentPath]).map(path => `${graphBase}${path}`),
    );
  });

  it.each(["author", "id", "marker", "deleted", "html"] as const)("never confirms mismatched %s", async mismatch => {
    const { confirm } = fixture(reply, (path, _count, item) => {
      if (!reply || path === replyPath) {
        if (mismatch === "author") item.from.user.id = "other-user";
        if (mismatch === "id") item.id = "other-id";
        if (mismatch === "marker") item.body.content += " extra text";
        if (mismatch === "deleted") item.deletedDateTime = "2026-10-23T00:00:00Z";
        if (mismatch === "html") item.body.content = `<script>${item.body.content}</script>`;
      }
      return Response.json(item);
    });
    await expect(confirm()).rejects.toMatchObject({ category: "delivery-timeout" });
  });

  it.each([403, 503])("does not hide HTTP %s behind a collection fallback", async status => {
    const { confirm, fetcher } = fixture(reply, () => new Response(null, { status }));
    await expect(confirm()).rejects.toMatchObject({ status });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects malformed direct responses", async () => {
    const { confirm } = fixture(reply, () => Response.json({ id: parentId }));
    await expect(confirm()).rejects.toMatchObject({ category: "malformed-response" });
  });

  it("never starts a read after cancellation or a spent deadline", async () => {
    const cancelled = fixture(reply);
    cancelled.controller.abort();
    await expect(cancelled.confirm()).rejects.toThrow();
    expect(cancelled.fetcher).not.toHaveBeenCalled();
    const expired = fixture(reply);
    expired.advance(100);
    await expect(expired.confirm()).rejects.toMatchObject({ category: "delivery-timeout" });
    expect(expired.fetcher).not.toHaveBeenCalled();
  });

  it("does not accept a read which completes past the deadline", async () => {
    const current = fixture(reply, (_path, _count, item) => {
      current.advance(101);
      return Response.json(item);
    });
    await expect(current.confirm()).rejects.toMatchObject({ category: "read-failure" });
  });

  it.each([undefined, "", ".", "..", " bad", "bad\u0000id"])("rejects unsafe/missing owned IDs before read: %s", async id => {
    const { attempt, confirm, fetcher } = fixture(reply);
    if (id === undefined) delete attempt.created;
    else attempt.created = { conversationId: messagesPath, activityId: id };
    await expect(confirm()).rejects.toMatchObject({ category: "read-failure" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("does not observe a reply until the exact parent also passes author/correlation checks", async () => {
  const { confirm, fetcher } = fixture(true, (_path, _count, item) =>
    Response.json({ ...item, from: { user: { id: "wrong-parent-author" } } }));
  await expect(confirm()).rejects.toMatchObject({ category: "delivery-timeout" });
  expect(fetcher.mock.calls.every(([url]) => String(url) === `${graphBase}${parentPath}`)).toBe(true);
});

it.each([undefined, "", ".", "..", " bad", "bad\u0000id"])("rejects unsafe/missing reply IDs without collection fallback: %s", async id => {
  const { attempt, confirm, fetcher } = fixture(true);
  if (id === undefined) delete attempt.reply;
  else attempt.reply = { activityId: id };
  await expect(confirm()).rejects.toMatchObject({ category: "read-failure" });
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${graphBase}${parentPath}`]);
});
