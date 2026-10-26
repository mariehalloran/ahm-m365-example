import { teamsCallingCallbackUrlSchema } from "./config.js";
import { IntegrationError } from "./http.js";

export const testTonePath = "/media/test-tone.wav";
export const testToneResourceId = "c32d752e-a721-4bb0-941c-6b1a59bd7949";

export function testToneUri(callbackUrl: string): string {
  if (!teamsCallingCallbackUrlSchema.safeParse(callbackUrl).success) throw new IntegrationError("configuration-failure");
  return new URL(testTonePath, new URL(callbackUrl).origin).href;
}

export function createTestTone(): Buffer {
  // Original one-second 440 Hz tone: Graph mediaInfo requires mono 16-bit PCM at 16 kHz.
  const samples = 16000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(samples, 24);
  wav.writeUInt32LE(samples * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const envelope = Math.min(1, index / 160, (samples - 1 - index) / 160);
    wav.writeInt16LE(Math.round(4096 * envelope * Math.sin(2 * Math.PI * 440 * index / samples)), 44 + index * 2);
  }
  return wav;
}
