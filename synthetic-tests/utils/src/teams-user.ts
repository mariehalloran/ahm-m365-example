import { z } from "zod";
import { GraphClient } from "./graph.js";
import { IntegrationError } from "./http.js";
import { setTimeout as delay } from "node:timers/promises";
import type { TeamsUserCredential } from "./teams-user-auth.js";

const identifier = z.string().min(1).max(2048).refine(value =>
  value.trim() === value && value !== "." && value !== ".." && !/[\u0000-\u001f\u007f]/.test(value));
const message = z.object({
  id: identifier,
  from: z.object({ user: z.object({ id: z.string().uuid() }) }),
});

export class TeamsUserClient {
  readonly userDelegated = true;
  constructor(readonly graph: GraphClient, private readonly credential: TeamsUserCredential) {}
  get applicationId() { return this.credential.userId; }
  async authenticate(signal: AbortSignal) { await this.graph.authenticate(signal); }
  async createChannelPost(
    _serviceUrl: string, _tenantId: string, teamId: string, channelId: string, text: string, signal: AbortSignal,
  ) {
    const path = `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`;
    const created = await this.post(path, text, signal);
    return { conversationId: path, activityId: created.id };
  }
  async replyToActivity(_serviceUrl: string, conversationId: string, parentId: string, text: string, signal: AbortSignal) {
    const created = await this.post(`${conversationId}/${encodeURIComponent(parentId)}/replies`, text, signal);
    return { activityId: created.id };
  }
  private async post(path: string, text: string, signal: AbortSignal) {
    const created = await this.graph.json(path, message, signal, "POST", {
      body: { contentType: "text", content: text },
    }, false);
    if (created.from.user.id.toLowerCase() !== this.credential.userId.toLowerCase()) {
      throw new IntegrationError("authentication-failure");
    }
    return created;
  }
  async deleteMessage(_serviceUrl: string, conversationId: string, activityId: string, signal: AbortSignal) {
    const response = await this.graph.request(
      `${conversationId}/${encodeURIComponent(activityId)}/softDelete`, signal, "POST", undefined, false,
    );
    await response.body?.cancel();
    if (response.status !== 204) throw new IntegrationError("cleanup-failure", response.status);
    const path = `${conversationId}/${encodeURIComponent(activityId)}`;
    for (let poll = 0; poll < 3; poll++) {
      try {
        const state = await this.graph.json(path, z.object({ deletedDateTime: z.string().nullable() }), signal);
        if (state.deletedDateTime !== null) return;
      } catch (error) {
        if (error instanceof IntegrationError && error.status === 404) return;
        throw error;
      }
      if (poll < 2) await delay(250, undefined, { signal });
    }
    throw new IntegrationError("cleanup-failure");
  }
  async deleteReply(conversationId: string, parentId: string, replyId: string, signal: AbortSignal) {
    await this.deleteMessage("", `${conversationId}/${encodeURIComponent(parentId)}/replies`, replyId, signal);
  }
}
