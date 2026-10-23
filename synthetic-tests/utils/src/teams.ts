import { z } from "zod";
import { AuthenticatedHttp, IntegrationError } from "./http.js";
import type { TeamsUserClient } from "./teams-user.js";

export type TeamsJourneyClient = TeamsBotClient | TeamsUserClient;

const identifier = z.string().min(1).max(2048).refine(value =>
  value.trim() === value && value !== "." && value !== ".." && !/[\u0000-\u001f\u007f]/.test(value));
const createdPostSchema = z.object({ id: identifier, activityId: identifier });
const createdReplySchema = z.object({ id: identifier });

export function validateTeamsServiceUrl(value: string): string {
  // Match the original input: URL parsing alone silently removes dot segments and default ports.
  const match = /^https:\/\/smba\.trafficmanager\.net\/(amer|emea|apac|teams)\/?$/.exec(value);
  if (!match) throw new IntegrationError("collector-failure");
  return `https://smba.trafficmanager.net/${match[1]}/`;
}

export class TeamsBotClient {
  readonly userDelegated = false;
  constructor(private readonly http: AuthenticatedHttp, public readonly applicationId: string) {
    if (!z.string().uuid().safeParse(applicationId).success) throw new IntegrationError("collector-failure");
  }

  async authenticate(signal: AbortSignal): Promise<void> {
    await this.http.token(signal);
  }

  async createChannelPost(
    serviceUrl: string, tenantId: string, teamId: string, channelId: string, text: string, signal: AbortSignal,
  ): Promise<{ conversationId: string; activityId: string }> {
    const base = validateTeamsServiceUrl(serviceUrl);
    if (!z.string().uuid().safeParse(tenantId).success || !z.string().uuid().safeParse(teamId).success ||
        !identifier.safeParse(channelId).success || !z.string().min(1).max(4000).safeParse(text).success) {
      throw new IntegrationError("collector-failure");
    }
    const response = await this.http.request(`${base}v3/conversations`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        isGroup: true,
        bot: { id: `28:${this.applicationId}` },
        channelData: {
          tenant: { id: tenantId },
          team: { id: teamId },
          channel: { id: channelId },
        },
        activity: { type: "message", textFormat: "plain", text },
      }),
    }, signal, false);
    if (response.status !== 200 && response.status !== 201) {
      await response.body?.cancel();
      throw new IntegrationError("send-failure", response.status);
    }
    let raw: unknown;
    try { raw = await response.json(); }
    catch { throw new IntegrationError("malformed-response"); }
    const parsed = createdPostSchema.safeParse(raw);
    if (!parsed.success) throw new IntegrationError("malformed-response");
    return { conversationId: parsed.data.id, activityId: parsed.data.activityId };
  }

  async deleteMessage(
    serviceUrl: string, conversationId: string, activityId: string, signal: AbortSignal,
  ): Promise<void> {
    const base = validateTeamsServiceUrl(serviceUrl);
    if (!identifier.safeParse(conversationId).success || !identifier.safeParse(activityId).success) {
      throw new IntegrationError("collector-failure");
    }
    const response = await this.http.request(
      `${base}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`,
      { method: "DELETE", redirect: "error" }, signal, true,
    );
    await response.body?.cancel();
    if (![200, 202, 204, 404].includes(response.status)) {
      throw new IntegrationError("cleanup-failure", response.status);
    }
  }

  async replyToActivity(
    serviceUrl: string, conversationId: string, parentActivityId: string, text: string, signal: AbortSignal,
  ): Promise<{ activityId: string }> {
    const base = validateTeamsServiceUrl(serviceUrl);
    if (!identifier.safeParse(conversationId).success || !identifier.safeParse(parentActivityId).success ||
        !z.string().min(1).max(4000).safeParse(text).success) {
      throw new IntegrationError("collector-failure");
    }
    const response = await this.http.request(
      `${base}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(parentActivityId)}`,
      {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "message", textFormat: "plain", text,
          from: { id: `28:${this.applicationId}` },
          conversation: { id: conversationId }, replyToId: parentActivityId,
        }),
      }, signal, false,
    );
    if (response.status !== 200 && response.status !== 201) {
      await response.body?.cancel();
      throw new IntegrationError("send-failure", response.status);
    }
    let raw: unknown;
    try { raw = await response.json(); }
    catch { throw new IntegrationError("malformed-response"); }
    const parsed = createdReplySchema.safeParse(raw);
    if (!parsed.success) throw new IntegrationError("malformed-response");
    return { activityId: parsed.data.id };
  }
}
