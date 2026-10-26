import { z } from "zod";
import type { GraphClient } from "./graph.js";
import { IntegrationError } from "./http.js";

export const callQualityLimits = {
  maxResponseBytes: 2 * 1024 * 1024,
  sessions: 60,
  segmentsPerSession: 128,
  mediaPerSegment: 16,
  streamsPerMedia: 32,
  audioStreamsPerRecord: 4096,
  recordsPerAggregation: 128,
} as const;

const callChainIdSchema = z.string().uuid();
const timestampSchema = z.string().max(64).datetime({ offset: true });
const nonnegative = z.number().finite().nonnegative();
const ratio = nonnegative.max(1);

function chronologicalTimestamps(record: { startDateTime: string; endDateTime: string }): boolean {
  const start = Date.parse(record.startDateTime);
  const end = Date.parse(record.endDateTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start !== end) return end > start;
  // Date.parse discards Graph's sub-millisecond timestamp precision.
  const startFraction = /\.(\d+)/.exec(record.startDateTime)?.[1] ?? "";
  const endFraction = /\.(\d+)/.exec(record.endDateTime)?.[1] ?? "";
  return endFraction.padEnd(startFraction.length, "0") >= startFraction.padEnd(endFraction.length, "0");
}

function durationMilliseconds(value: string): number | undefined {
  // Graph durations have no calendar years/months or weeks. A fractional value
  // is allowed only on the smallest supplied day/hour/minute/second component.
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || match[0] !== value || !match.slice(1).some(part => part !== undefined) ||
      (value.includes("T") && match.slice(2).every(part => part === undefined))) return undefined;
  const parts = match.slice(1);
  if (parts.some((part, index) => part?.includes(".") && parts.slice(index + 1).some(next => next !== undefined))) {
    return undefined;
  }
  const milliseconds = parts.reduce((total, part, index) =>
    total + Number(part ?? 0) * [86400000, 3600000, 60000, 1000][index]!, 0);
  return Number.isFinite(milliseconds) && milliseconds <= Number.MAX_SAFE_INTEGER ? milliseconds : undefined;
}

const durationSchema = z.string().max(128).refine(value => durationMilliseconds(value) !== undefined, "Invalid Graph duration");
const optionalNumber = nonnegative.nullable().optional();
const optionalRatio = ratio.nullable().optional();
const optionalDuration = durationSchema.nullable().optional();
const diagnosticString = z.string().min(1).max(128).nullable().optional();

// Source: https://learn.microsoft.com/graph/api/resources/callrecords-mediastream?view=graph-rest-1.0
const audioStreamSchema = z.object({
  averagePacketLossRate: optionalRatio,
  maxPacketLossRate: optionalRatio,
  averageJitter: optionalDuration,
  maxJitter: optionalDuration,
  averageAudioNetworkJitter: optionalDuration,
  maxAudioNetworkJitter: optionalDuration,
  averageRoundTripTime: optionalDuration,
  maxRoundTripTime: optionalDuration,
  averageAudioDegradation: optionalNumber,
  averageRatioOfConcealedSamples: optionalRatio,
  maxRatioOfConcealedSamples: optionalRatio,
  audioCodec: diagnosticString,
  streamDirection: diagnosticString,
});

// This collector deliberately fails on pagination rather than publishing a
// truncated mean. Null annotations, like null metric fields, mean absent.
const noNextPage = z.null({ invalid_type_error: "Paginated call records are not supported" }).optional();
const mediaSchema = z.object({
  label: z.string().min(1).max(128),
  streams: z.array(audioStreamSchema).max(callQualityLimits.streamsPerMedia),
  "@odata.nextLink": noNextPage,
  "streams@odata.nextLink": noNextPage,
});
const segmentSchema = z.object({
  media: z.array(mediaSchema).max(callQualityLimits.mediaPerSegment),
  "@odata.nextLink": noNextPage,
  "media@odata.nextLink": noNextPage,
});
const sessionSchema = z.object({
  segments: z.array(segmentSchema).max(callQualityLimits.segmentsPerSession),
  "@odata.nextLink": noNextPage,
  "segments@odata.nextLink": noNextPage,
});

export const callQualityRecordSchema = z.object({
  id: callChainIdSchema,
  version: z.number().finite().int().positive().max(Number.MAX_SAFE_INTEGER),
  startDateTime: timestampSchema,
  endDateTime: timestampSchema,
  sessions: z.array(sessionSchema).max(callQualityLimits.sessions),
  "@odata.nextLink": noNextPage,
  "sessions@odata.nextLink": noNextPage,
}).refine(chronologicalTimestamps, "Call ends before it starts");

export type CallQualityRecord = z.infer<typeof callQualityRecordSchema>;
type AudioStream = z.infer<typeof audioStreamSchema>;

export const callQualityMetricNames = [
  "packetLossPercent", "maxPacketLossPercent", "jitterMs", "maxJitterMs",
  "roundTripTimeMs", "maxRoundTripTimeMs", "audioDegradation",
  "concealedSamplesPercent", "maxConcealedSamplesPercent",
] as const;
export type CallQualityMetric = typeof callQualityMetricNames[number];
export interface CallQualityMetricSample {
  value: number;
  sampleCount: number;
}

const metricDefinitions = {
  packetLossPercent: { field: "averagePacketLossRate", operation: "mean", scale: 100 },
  maxPacketLossPercent: { field: "maxPacketLossRate", operation: "max", scale: 100 },
  jitterMs: { field: "averageAudioNetworkJitter", fallbackField: "averageJitter", operation: "mean", scale: 1 },
  maxJitterMs: { field: "maxAudioNetworkJitter", fallbackField: "maxJitter", operation: "max", scale: 1 },
  roundTripTimeMs: { field: "averageRoundTripTime", operation: "mean", scale: 1 },
  maxRoundTripTimeMs: { field: "maxRoundTripTime", operation: "max", scale: 1 },
  audioDegradation: { field: "averageAudioDegradation", operation: "mean", scale: 1 },
  concealedSamplesPercent: { field: "averageRatioOfConcealedSamples", operation: "mean", scale: 100 },
  maxConcealedSamplesPercent: { field: "maxRatioOfConcealedSamples", operation: "max", scale: 100 },
} as const satisfies Record<CallQualityMetric, {
  field: keyof AudioStream; fallbackField?: keyof AudioStream; operation: "mean" | "max"; scale: number;
}>;

const metricSampleSchema = z.object({
  value: nonnegative,
  sampleCount: z.number().int().positive().max(callQualityLimits.audioStreamsPerRecord),
}).strict();

export const callQualityObservationSchema = z.object({
  callChainId: callChainIdSchema,
  version: z.number().finite().int().positive().max(Number.MAX_SAFE_INTEGER),
  startDateTime: timestampSchema,
  endDateTime: timestampSchema,
  metrics: z.record(z.enum(callQualityMetricNames), metricSampleSchema),
  audioStreamCount: z.number().int().nonnegative().max(callQualityLimits.audioStreamsPerRecord),
  codecs: z.array(z.string().min(1).max(128)).max(callQualityLimits.audioStreamsPerRecord),
  streamDirections: z.array(z.string().min(1).max(128)).max(callQualityLimits.audioStreamsPerRecord),
}).strict().superRefine((observation, context) => {
  if (!chronologicalTimestamps(observation)) {
    context.addIssue({ code: "custom", path: ["endDateTime"], message: "Call ends before it starts" });
  }
  for (const name of callQualityMetricNames) {
    const sample = observation.metrics[name];
    if (!sample) continue;
    if (sample.sampleCount > observation.audioStreamCount) {
      context.addIssue({ code: "custom", path: ["metrics", name, "sampleCount"], message: "Sample count exceeds audio stream count" });
    }
    if (name.endsWith("Percent") && sample.value > 100) {
      context.addIssue({ code: "custom", path: ["metrics", name, "value"], message: "Percentage exceeds 100" });
    }
  }
});

/** Average metrics are unweighted stream means, not packet-weighted or absolute MOS. */
export type CallQualityObservation = z.infer<typeof callQualityObservationSchema>;
export type CallQualitySummary = Pick<CallQualityObservation, "metrics" | "audioStreamCount" | "codecs" | "streamDirections">;

function requireCallChainId(callChainId: string): void {
  if (!callChainIdSchema.safeParse(callChainId).success) throw new IntegrationError("configuration-failure");
}

function emptySummary(): CallQualitySummary {
  return {
    audioStreamCount: 0, metrics: {}, codecs: [], streamDirections: [],
  };
}

function mergeMetric(
  metrics: Partial<Record<CallQualityMetric, CallQualityMetricSample>>, name: CallQualityMetric, sample: CallQualityMetricSample,
): void {
  const current = metrics[name];
  if (!current) {
    metrics[name] = { ...sample };
    return;
  }
  const sampleCount = current.sampleCount + sample.sampleCount;
  // Incremental means avoid overflow when finite, nonnegative Graph doubles
  // are large. Counts preserve the stream mean when combining call records.
  const value = metricDefinitions[name].operation === "max" ? Math.max(current.value, sample.value)
    : current.value + (sample.value - current.value) * (sample.sampleCount / sampleCount);
  metrics[name] = { value, sampleCount };
}

function addStream(summary: CallQualitySummary, stream: AudioStream): void {
  summary.audioStreamCount++;
  if (summary.audioStreamCount > callQualityLimits.audioStreamsPerRecord) throw new IntegrationError("malformed-response");
  for (const name of callQualityMetricNames) {
    const definition = metricDefinitions[name];
    const raw = stream[definition.field] ??
      ("fallbackField" in definition ? stream[definition.fallbackField] : undefined);
    if (raw === null || raw === undefined) continue;
    const value = (typeof raw === "string" ? durationMilliseconds(raw)! : raw) * definition.scale;
    mergeMetric(summary.metrics, name, { value, sampleCount: 1 });
  }
  if (stream.audioCodec) summary.codecs.push(stream.audioCodec);
  if (stream.streamDirection) summary.streamDirections.push(stream.streamDirection);
}

function uniqueDiagnostics(summary: CallQualitySummary): void {
  summary.codecs = [...new Set(summary.codecs)].sort();
  summary.streamDirections = [...new Set(summary.streamDirections)].sort();
}

function summarizeRecord(record: CallQualityRecord, callChainId: string): CallQualityObservation {
  if (record.id !== callChainId) throw new IntegrationError("malformed-response");
  const summary = emptySummary();
  for (const session of record.sessions) {
    for (const segment of session.segments) {
      for (const media of segment.media) {
        // Do not infer audio from call/session modalities or fields on video streams.
        if (media.label !== "main-audio" && media.label !== "audio") continue;
        for (const stream of media.streams) addStream(summary, stream);
      }
    }
  }
  uniqueDiagnostics(summary);
  return {
    ...summary, callChainId, version: record.version,
    startDateTime: record.startDateTime, endDateTime: record.endDateTime,
  };
}

/** Parse one complete, known call record without retaining data between cycles. */
export function parseCallQuality(raw: unknown, callChainId: string): CallQualityObservation {
  requireCallChainId(callChainId);
  const parsed = callQualityRecordSchema.safeParse(raw);
  if (!parsed.success) throw new IntegrationError("malformed-response");
  return summarizeRecord(parsed.data, callChainId);
}

/**
 * Combine distinct known records within one execution. Pending records must be
 * handled separately; an empty summary or a missing metric is not healthy/zero.
 */
export function aggregateCallQuality(records: readonly CallQualityObservation[]): CallQualitySummary {
  if (records.length > callQualityLimits.recordsPerAggregation) throw new IntegrationError("collector-failure");
  const summary = emptySummary();
  const seen = new Set<string>();
  for (const record of records) {
    if (!callQualityObservationSchema.safeParse(record).success) throw new IntegrationError("malformed-response");
    if (seen.has(record.callChainId)) throw new IntegrationError("collector-failure");
    seen.add(record.callChainId);
    summary.audioStreamCount += record.audioStreamCount;
    for (const name of callQualityMetricNames) {
      const sample = record.metrics[name];
      if (sample) mergeMetric(summary.metrics, name, sample);
    }
    summary.codecs.push(...record.codecs);
    summary.streamDirections.push(...record.streamDirections);
  }
  uniqueDiagnostics(summary);
  return summary;
}

/**
 * Reads only call.callChainId. Undefined explicitly means HTTP 404/pending, not
 * zero or Healthy; Graph may also return 404 for records older than 30 days.
 */
export async function collectCallQuality(
  graph: GraphClient, callChainId: string, signal: AbortSignal,
): Promise<CallQualityObservation | undefined> {
  signal.throwIfAborted();
  requireCallChainId(callChainId);
  try {
    const record = await graph.json(
      `/communications/callRecords/${callChainId}?$expand=sessions($expand=segments)`,
      callQualityRecordSchema, signal, "GET", undefined, true, "v1.0", callQualityLimits.maxResponseBytes,
    );
    signal.throwIfAborted();
    const observation = summarizeRecord(record, callChainId);
    signal.throwIfAborted();
    return observation;
  } catch (error) {
    // GraphClient can wrap a body-read abort as malformed-response.
    signal.throwIfAborted();
    if (error instanceof IntegrationError) {
      if (error.category === "read-failure" && error.status === 404) {
        return undefined;
      }
      throw error;
    }
    if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw error;
    throw new IntegrationError("collector-failure");
  }
}
