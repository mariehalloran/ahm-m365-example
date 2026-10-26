import { describe, expect, it, vi } from "vitest";
import { AuthenticatedHttp } from "../../utils/src/http.js";
import { TeamsBotClient } from "../../utils/src/teams.js";
import { cleanupReply, postReply, type ChannelReplyAttempt } from "../src/steps.js";

const applicationId = "33333333-3333-4333-8333-333333333333";
const serviceUrl = "https://smba.trafficmanager.net/teams/";
const conversationId = "19:conversation@thread.tacv2;messageid=123";
const activityId = "root/123?owned";
const replyId = "reply/456?owned";
const activityUrl = (id: string) =>
  `${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(id)}`;

function fixture(options: { missingRoot?: boolean; replyStatus?: number; replyBody?: unknown; replyNetworkFailure?: boolean; deleteFailure?: string } = {}) {
  const attempt: ChannelReplyAttempt = {
    serviceUrl, tenantId: "11111111-1111-4111-8111-111111111111",
    teamId: "22222222-2222-4222-8222-222222222222", channelId: "dedicated-channel",
    marker: "unique root marker", replyMarker: "unique correlated reply marker",
    mutationAttempted: true, replyMutationAttempted: false,
    ...(options.missingRoot ? {} : { created: { conversationId, activityId } }),
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.method === "POST") {
      if (options.replyNetworkFailure) throw new Error("lost after mutation");
      return Response.json(options.replyBody ?? { id: replyId }, { status: options.replyStatus ?? 201 });
    }
    return new Response(null, { status: String(input) === options.deleteFailure ? 403 : 204 });
  });
  const bot = new TeamsBotClient(new AuthenticatedHttp({
    getToken: async () => ({ token: "fake-reply-unit-test", expiresOnTimestamp: Date.now() + 60000 }),
  }, "https://api.botframework.com/.default", { fetch: fetcher, attempts: 1 }), applicationId);
  return { attempt, fetcher, bot, signal: new AbortController().signal };
}

describe("thread-reply primitives within the channel journey", () => {
  it("submits the exact correlated reply to the known root and deletes only owned IDs", async () => {
    const { attempt, fetcher, bot, signal } = fixture();
    await postReply(bot, attempt, signal);
    expect(attempt.replyMutationAttempted).toBe(true);
    expect(attempt.reply).toEqual({ activityId: replyId });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      type: "message", textFormat: "plain", text: attempt.replyMarker,
      from: { id: `28:${applicationId}` }, conversation: { id: conversationId }, replyToId: activityId,
    });
    await cleanupReply(bot, attempt, signal);
    expect(fetcher.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      `POST ${activityUrl(activityId)}`, `DELETE ${activityUrl(replyId)}`, `DELETE ${activityUrl(activityId)}`,
    ]);
  });

  it("never posts or invents a conversation when the root creation did not return owned IDs", async () => {
    const { attempt, fetcher, bot, signal } = fixture({ missingRoot: true });
    await expect(postReply(bot, attempt, signal)).rejects.toMatchObject({ category: "send-failure" });
    await expect(cleanupReply(bot, attempt, signal)).rejects.toMatchObject({ category: "cleanup-failure" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{}, { id: "" }, { id: ".." }, { id: " unsafe" }, { id: "\nunsafe" }, { id: 5 }])(
    "does not manufacture cleanup evidence from a malformed reply response: %j", async replyBody => {
      const { attempt, fetcher, bot, signal } = fixture({ replyBody });
      await expect(postReply(bot, attempt, signal)).rejects.toMatchObject({ category: "malformed-response" });
      await expect(cleanupReply(bot, attempt, signal)).rejects.toMatchObject({ category: "cleanup-failure" });
      expect(fetcher.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
        `POST ${activityUrl(activityId)}`, `DELETE ${activityUrl(activityId)}`,
      ]);
    },
  );

  it("does not retry an ambiguous reply, and root deletion does not repair its unknown outcome", async () => {
    const { attempt, fetcher, bot, signal } = fixture({ replyNetworkFailure: true });
    await expect(postReply(bot, attempt, signal)).rejects.toMatchObject({ category: "send-failure" });
    await expect(cleanupReply(bot, attempt, signal)).rejects.toMatchObject({ category: "cleanup-failure" });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("still removes the known root after failure to delete the known reply", async () => {
    const { attempt, fetcher, bot, signal } = fixture({ deleteFailure: activityUrl(replyId) });
    await postReply(bot, attempt, signal);
    await expect(cleanupReply(bot, attempt, signal)).rejects.toMatchObject({ category: "cleanup-failure" });
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toBe(activityUrl(activityId));
  });
});
