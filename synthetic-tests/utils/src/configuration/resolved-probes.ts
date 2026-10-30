import { z } from "zod";
import { probeSchema, type TestType } from "../contracts.js";

// Keep remote fixture/folder ownership checks in their existing journey steps, not worker-wide validation.
const exchange = probeSchema.required({ mailbox: true });
const oneDrive = probeSchema.required({ userId: true, userPrincipalName: true, folderName: true });
const channel = probeSchema.required({
  tenantId: true,
  teamId: true,
  channelId: true,
  serviceUrl: true,
  botPairId: true,
  botClientId: true,
});
const call = probeSchema.required({
  tenantId: true,
  meetingThreadId: true,
  organizerUserId: true,
  botPairId: true,
  botClientId: true,
  peerBotClientId: true,
});

/** Discriminated union schema enforcing the required target fields for each live synthetic journey type. */
export const liveProbeSchema = z.discriminatedUnion("type", [
  exchange.extend({ type: z.literal("exchange-mail-flow") }),
  exchange.extend({ type: z.literal("exchange-draft") }),
  exchange.extend({ type: z.literal("exchange-attachment") }),
  exchange.extend({ type: z.literal("exchange-reply") }),
  exchange.extend({ type: z.literal("exchange-recurring-calendar") }),
  channel.extend({ type: z.literal("teams-channel-message") }),
  call.extend({ type: z.literal("teams-call") }),
  oneDrive.extend({ type: z.literal("onedrive-roundtrip") }),
  oneDrive.extend({ type: z.literal("onedrive-appfolder") }),
  oneDrive.extend({ type: z.literal("onedrive-versions") }),
]);

export type LiveProbe = z.infer<typeof liveProbeSchema>;
type LiveProbeByType = { [Type in TestType]: Extract<LiveProbe, { type: Type }> };
export type LiveProbeFor<Type extends TestType = TestType> = LiveProbeByType[Type];
export type OneDriveProbe = LiveProbeFor<"onedrive-roundtrip" | "onedrive-appfolder" | "onedrive-versions">;
