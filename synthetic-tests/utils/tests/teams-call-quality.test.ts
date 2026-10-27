import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../src/graph.js";
import { IntegrationError } from "../src/http.js";
import {
  aggregateCallQuality, callQualityLimits, callQualityMetricNames, callQualityObservationSchema,
  callQualityRecordSchema, collectCallQuality, parseCallQuality,
  type CallQualityMetric, type CallQualityObservation,
} from "../src/teams-call-quality.js";

const callChainId = "e523d2ed-2966-4b6b-925b-754a88034cc5";
const secondCallChainId = "e523d2ed-2966-4b6b-925b-754a88034cc6";
const startDateTime = "2026-10-26T12:00:00.1234567Z";
const endDateTime = "2026-10-26T12:01:00.1234567Z";
const signal = () => new AbortController().signal;
function record(streams: unknown[] = [], id = callChainId) {
  return {
    id, version: 3, startDateTime, endDateTime,
    sessions: [{ segments: [{ media: [{ label: "main-audio", streams }] }] }],
  };
}
function client(reply: () => Response | Promise<Response>) {
  const token = vi.fn(async () => ({ token: "test-only-token", expiresOnTimestamp: Date.now() + 100000 }));
  const fetcher = vi.fn<typeof fetch>(async () => reply());
  return {
    fetcher, token,
    graph: new GraphClient({ getToken: token }, {
      fetch: fetcher, attempts: 1,
    }),
  };
}

describe("known Teams call quality parsing", () => {
  it("exports the fixed typed metric inventory and observation schema", () => {
    expect(callQualityMetricNames).toEqual([
      "packetLossPercent", "maxPacketLossPercent", "jitterMs", "maxJitterMs",
      "roundTripTimeMs", "maxRoundTripTimeMs", "audioDegradation",
      "concealedSamplesPercent", "maxConcealedSamplesPercent",
    ]);
    const observation: CallQualityObservation = parseCallQuality(record(), callChainId);
    const metrics: Partial<Record<CallQualityMetric, { value: number; sampleCount: number }>> = observation.metrics;
    expect(metrics).toEqual({});
    expect(callQualityObservationSchema.parse(observation)).toEqual(observation);
    expect(Object.keys(observation).sort()).toEqual([
      "audioStreamCount", "callChainId", "codecs", "endDateTime", "metrics", "startDateTime", "streamDirections", "version",
    ]);
    expect(callQualityObservationSchema.safeParse({ ...observation, metrics: { mos: { value: 4, sampleCount: 1 } } }).success).toBe(false);
    expect(callQualityObservationSchema.safeParse({
      ...observation, metrics: { jitterMs: { value: 4, sampleCount: 1 } },
    }).success).toBe(false);
    expect(callQualityObservationSchema.safeParse({
      ...observation, audioStreamCount: 1, metrics: { packetLossPercent: { value: 101, sampleCount: 1 } },
    }).success).toBe(false);
  });

  it("preserves provenance and computes exact per-metric unweighted means, maxima, units and counts", () => {
    const result = parseCallQuality(record([
      {
        averagePacketLossRate: 0.01, maxPacketLossRate: 0.08,
        averageJitter: "PT0.012S", maxJitter: "PT0.025S",
        averageRoundTripTime: "PT0.1S", maxRoundTripTime: "PT0.3S",
        averageAudioDegradation: 0.2, averageRatioOfConcealedSamples: 0.02, maxRatioOfConcealedSamples: 0.06,
        packetUtilization: 1, audioCodec: "opus", streamDirection: "callerToCallee",
      },
      {
        averagePacketLossRate: 0.03, maxPacketLossRate: 0.04,
        averageJitter: "PT0.020S", maxJitter: "PT0.030S",
        averageRoundTripTime: "PT0.2S", maxRoundTripTime: "PT0.4S",
        averageAudioDegradation: 0.4, averageRatioOfConcealedSamples: 0.04,
        packetUtilization: 9999, audioCodec: "silk", streamDirection: "calleeToCaller",
      },
      { averageJitter: "PT0.028S", audioCodec: "opus", streamDirection: "callerToCallee" },
    ]), callChainId);
    expect(result).toMatchObject({
      callChainId, version: 3, startDateTime, endDateTime, audioStreamCount: 3,
      codecs: ["opus", "silk"], streamDirections: ["calleeToCaller", "callerToCallee"],
    });
    expect(result.metrics).toEqual({
      packetLossPercent: { value: 2, sampleCount: 2 },
      maxPacketLossPercent: { value: 8, sampleCount: 2 },
      jitterMs: { value: 20, sampleCount: 3 },
      maxJitterMs: { value: 30, sampleCount: 2 },
      roundTripTimeMs: { value: 150, sampleCount: 2 },
      maxRoundTripTimeMs: { value: 400, sampleCount: 2 },
      audioDegradation: { value: 0.30000000000000004, sampleCount: 2 },
      concealedSamplesPercent: { value: 3, sampleCount: 2 },
      maxConcealedSamplesPercent: { value: 6, sampleCount: 1 },
    });
    expect(callQualityObservationSchema.parse(result)).toEqual(result);
  });

  it("prefers audio-specific jitter once per stream, including zero, and only falls back for null/missing fields", () => {
    const result = parseCallQuality(record([
      {
        averageAudioNetworkJitter: "PT0.01S", averageJitter: "PT1S",
        maxAudioNetworkJitter: "PT0.03S", maxJitter: "PT2S",
      },
      {
        averageAudioNetworkJitter: null, averageJitter: "PT0.02S",
        maxAudioNetworkJitter: null, maxJitter: "PT0.04S",
      },
      { averageJitter: "PT0.03S", maxJitter: "PT0.05S" },
      { averageAudioNetworkJitter: "PT0.04S", maxAudioNetworkJitter: "PT0.06S" },
      {
        averageAudioNetworkJitter: "PT0S", averageJitter: "PT3S",
        maxAudioNetworkJitter: "PT0S", maxJitter: "PT4S",
      },
      { averageAudioNetworkJitter: null, maxAudioNetworkJitter: null },
      {},
    ]), callChainId);
    expect(result.audioStreamCount).toBe(7);
    expect(result.metrics).toEqual({
      jitterMs: { value: 20, sampleCount: 5 },
      maxJitterMs: { value: 60, sampleCount: 5 },
    });
  });

  it("selects average and maximum jitter independently without inferring a missing maximum", () => {
    expect(parseCallQuality(record([
      { averageAudioNetworkJitter: "PT0.01S", maxJitter: "PT0.03S" },
      { averageJitter: "PT0.02S", maxAudioNetworkJitter: "PT0.04S" },
      { averageAudioNetworkJitter: "PT0.03S" },
    ]), callChainId).metrics).toEqual({
      jitterMs: { value: 20, sampleCount: 3 },
      maxJitterMs: { value: 40, sampleCount: 2 },
    });
  });

  it.each(["averageAudioNetworkJitter", "maxAudioNetworkJitter"])(
    "rejects malformed %s instead of hiding it behind generic jitter", field => {
      expect(() => parseCallQuality(record([{
        [field]: "PT-1S", averageJitter: "PT0.01S", maxJitter: "PT0.02S",
      }]), callChainId)).toThrow(IntegrationError);
    },
  );

  it("omits missing/null metrics, preserves actual zeros and does not synthesize maxima", () => {
    const result = parseCallQuality(record([
      {},
      {
        averagePacketLossRate: null, averageJitter: null, averageRoundTripTime: null,
        averageAudioDegradation: null, averageRatioOfConcealedSamples: null,
        maxPacketLossRate: null, maxJitter: null, maxRoundTripTime: null,
        maxRatioOfConcealedSamples: null, audioCodec: null, streamDirection: null,
      },
      { averagePacketLossRate: 0, averageJitter: "PT0S" },
    ]), callChainId);
    expect(result.audioStreamCount).toBe(3);
    expect(result.metrics).toEqual({
      packetLossPercent: { value: 0, sampleCount: 1 }, jitterMs: { value: 0, sampleCount: 1 },
    });
    expect(result.codecs).toEqual([]);
    expect(result.streamDirections).toEqual([]);
    expect(parseCallQuality(record([{}]), callChainId).metrics).toEqual({});
    expect(parseCallQuality(record(), callChainId).metrics).toEqual({});
  });

  it("only uses explicitly audio media even in mixed-modality calls", () => {
    const raw = record([{ averagePacketLossRate: 0.02 }]);
    raw.sessions[0]!.segments[0]!.media.push(
      { label: "main-video", streams: [{ averagePacketLossRate: 1, audioCodec: "video-only" }] },
      { label: "videoBasedScreenSharing", streams: [{ averageJitter: "PT99S" }] },
      { label: "unrecognized", streams: [{ averageAudioDegradation: 99 }] },
      { label: "audio", streams: [{ averagePacketLossRate: 0.04 }] },
    );
    const result = parseCallQuality({ ...raw, modalities: ["audio", "video"] }, callChainId);
    expect(result.audioStreamCount).toBe(2);
    expect(result.metrics).toEqual({ packetLossPercent: { value: 3, sampleCount: 2 } });
    expect(result.codecs).toEqual([]);
  });

  it.each([
    ["P1DT2H3M4.5S", 93784500], ["P2D", 172800000], ["PT2H", 7200000],
    ["PT3M", 180000], ["PT1.25S", 1250], ["PT0.0001S", 0.1], ["P0DT0H0M0S", 0],
    ["P0.5D", 43200000], ["PT0.5H", 1800000], ["PT0.5M", 30000],
  ])("converts %s to milliseconds", (duration, milliseconds) => {
    expect(parseCallQuality(record([{ averageJitter: duration }]), callChainId).metrics.jitterMs)
      .toEqual({ value: milliseconds, sampleCount: 1 });
  });

  it.each([
    "", "P", "PT", "P1DT", "P1Y", "P1M", "P1W", "-PT1S", "PT-1S", "PT+1S",
    "PT1e2S", "PTNaNS", "PTInfinityS", "PT1", "1S", "PT1Sx", " PT1S", "PT1S\n",
    "PT1S2M", "PT1M1M", "PT.5S", "PT1.S", "P1.5DT1H", "PT1.5H1M", "PT1.5M1S",
    "P999999999999999999999999999D",
  ])("rejects invalid or unrepresentable duration %j", duration => {
    expect(() => parseCallQuality(record([{ averageJitter: duration }]), callChainId)).toThrow(IntegrationError);
  });

  it.each([
    ["averagePacketLossRate", -0.01], ["averagePacketLossRate", 1.01],
    ["maxPacketLossRate", 1.01], ["averageRatioOfConcealedSamples", 1.01],
    ["maxRatioOfConcealedSamples", -0.01], ["maxRatioOfConcealedSamples", 1.01],
    ["averageAudioDegradation", -1], ["averageAudioDegradation", NaN],
    ["averageAudioDegradation", Infinity], ["averagePacketLossRate", -Infinity],
    ["averagePacketLossRate", "0.01"], ["averageJitter", 10], ["maxRoundTripTime", "PT-1S"],
  ])("rejects malformed %s=%j", (field, value) => {
    expect(() => parseCallQuality(record([{ [field]: value }]), callChainId)).toThrow(IntegrationError);
  });

  it("accepts ratio endpoints and does not clamp degradation to an invented MOS range", () => {
    expect(parseCallQuality(record([{
      averagePacketLossRate: 1, averageRatioOfConcealedSamples: 0, averageAudioDegradation: 7,
    }]), callChainId).metrics).toMatchObject({
      packetLossPercent: { value: 100 }, concealedSamplesPercent: { value: 0 }, audioDegradation: { value: 7 },
    });
    expect(parseCallQuality(record([
      { averageAudioDegradation: Number.MAX_VALUE }, { averageAudioDegradation: Number.MAX_VALUE },
    ]), callChainId).metrics.audioDegradation?.value).toBe(Number.MAX_VALUE);
  });

  it.each([
    { id: secondCallChainId }, { id: callChainId.toUpperCase() }, { id: "not-a-uuid" },
    { version: 0 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { startDateTime: "not-a-date" }, { endDateTime: "2026-10-26T11:00:00Z" },
    { endDateTime: null }, { sessions: undefined }, { sessions: null },
    { sessions: [{}] }, { sessions: [{ segments: null }] },
  ])("rejects malformed or mismatched record metadata/expansion %j", fields => {
    expect(() => parseCallQuality({ ...record(), ...fields }, callChainId)).toThrow(IntegrationError);
  });

  it("exports a bounded source schema which strips unrelated participant data", () => {
    const parsed = callQualityRecordSchema.parse({ ...record(), participants: [{ private: "unneeded" }] });
    expect(parsed).not.toHaveProperty("participants");
  });

  it.each(callQualityMetricNames)("rejects %s sample counts exceeding the audio stream count", name => {
    const observation = parseCallQuality(record([{}, {}]), callChainId);
    expect(callQualityObservationSchema.safeParse({
      ...observation, metrics: { [name]: { value: 1, sampleCount: 3 } },
    }).success).toBe(false);
    expect(callQualityObservationSchema.safeParse({
      ...observation, metrics: { [name]: { value: 1, sampleCount: 2 } },
    }).success).toBe(true);
  });

  it.each([
    ["2026-10-26T12:01:00Z", "2026-10-26T12:00:00Z"],
    ["2026-10-26T12:00:00.1234567Z", "2026-10-26T12:00:00.1234566Z"],
    ["2026-10-26T12:00:00+01:00", "2026-10-26T10:59:59Z"],
  ])("rejects inverted chronology in both source and observation schemas: %s > %s", (start, end) => {
    const timestamps = { startDateTime: start, endDateTime: end };
    expect(() => parseCallQuality({ ...record(), ...timestamps }, callChainId)).toThrow(IntegrationError);
    expect(callQualityObservationSchema.safeParse({
      ...parseCallQuality(record(), callChainId), ...timestamps,
    }).success).toBe(false);
  });

  it.each([
    ["2070-01-01T00:00:00Z", "2070-01-01T00:00:01Z"],
    ["2026-10-26T12:00:00.1234566Z", "2026-10-26T12:00:00.1234567Z"],
    ["2026-10-26T12:00:00+01:00", "2026-10-26T11:00:00.000Z"],
  ])("accepts chronological timestamps without imposing a wall-clock policy: %s <= %s", (start, end) => {
    const observation = parseCallQuality({
      ...record(), startDateTime: start, endDateTime: end,
    }, callChainId);
    expect(callQualityObservationSchema.safeParse(observation).success).toBe(true);
  });
});

describe("complete bounded call records", () => {
  const next = "https://graph.microsoft.com/v1.0/communications/callRecords/next";
  it.each([
    { ...record(), "@odata.nextLink": next },
    { ...record(), "sessions@odata.nextLink": next },
    { ...record(), sessions: [{ "@odata.nextLink": next, segments: [] }] },
    { ...record(), sessions: [{ "segments@odata.nextLink": next, segments: [] }] },
    { ...record(), sessions: [{ segments: [{ "@odata.nextLink": next, media: [] }] }] },
    { ...record(), sessions: [{ segments: [{ "media@odata.nextLink": next, media: [] }] }] },
    { ...record(), sessions: [{ segments: [{ media: [{ label: "main-audio", streams: [], "streams@odata.nextLink": next }] }] }] },
    { ...record(), sessions: [{ segments: [{ media: [{ label: "main-audio", streams: [], "@odata.nextLink": next }] }] }] },
    { ...record(), "sessions@odata.nextLink": "" },
    { ...record(), "sessions@odata.nextLink": 1 },
  ])("fails explicitly on pagination, never silently computing partial metrics", raw => {
    expect(callQualityRecordSchema.safeParse(raw).success).toBe(false);
    expect(() => parseCallQuality(raw, callChainId)).toThrow(IntegrationError);
  });

  it("allows absent/null next-link annotations", () => {
    expect(parseCallQuality({ ...record(), "sessions@odata.nextLink": null }, callChainId).metrics).toEqual({});
  });

  it.each([
    { ...record(), sessions: Array.from({ length: callQualityLimits.sessions + 1 }, () => ({ segments: [] })) },
    { ...record(), sessions: [{ segments: Array.from({ length: callQualityLimits.segmentsPerSession + 1 }, () => ({ media: [] })) }] },
    { ...record(), sessions: [{ segments: [{ media: Array.from({ length: callQualityLimits.mediaPerSegment + 1 }, () => ({ label: "main-audio", streams: [] })) }] }] },
    record(Array.from({ length: callQualityLimits.streamsPerMedia + 1 }, () => ({}))),
  ])("rejects oversized nested collections", raw => {
    expect(() => parseCallQuality(raw, callChainId)).toThrow(IntegrationError);
  });

  it("bounds total audio streams even when individual collections fit", () => {
    const media = () => ({ label: "main-audio", streams: Array.from({ length: callQualityLimits.streamsPerMedia }, () => ({})) });
    const raw = {
      ...record(), sessions: [{ segments: Array.from({ length: 9 }, () => ({
        media: Array.from({ length: callQualityLimits.mediaPerSegment }, media),
      })) }],
    };
    expect(() => parseCallQuality(raw, callChainId)).toThrow(IntegrationError);
  });
});

describe("aggregation across known records", () => {
  it("combines stream sample counts, not an equally weighted mean of record means", () => {
    const first = parseCallQuality(record([
      { averagePacketLossRate: 0.01, maxPacketLossRate: 0.05, audioCodec: "opus" },
      { averagePacketLossRate: 0.03, maxPacketLossRate: 0.07 },
      { averagePacketLossRate: null },
    ]), callChainId);
    const second = parseCallQuality(record([{
      averagePacketLossRate: 0.08, maxPacketLossRate: 0.06, averageJitter: "PT0.1S", audioCodec: "silk",
    }], secondCallChainId), secondCallChainId);
    const firstBefore = structuredClone(first);
    const result = aggregateCallQuality([first, second]);
    expect(result.audioStreamCount).toBe(4);
    expect(result.metrics).toEqual({
      packetLossPercent: { value: 4, sampleCount: 3 },
      maxPacketLossPercent: { value: 7.000000000000001, sampleCount: 3 },
      jitterMs: { value: 100, sampleCount: 1 },
    });
    expect(result.codecs).toEqual(["opus", "silk"]);
    expect(first).toEqual(firstBefore);
    expect(aggregateCallQuality([]).metrics).toEqual({});
    expect(aggregateCallQuality([first]).metrics.packetLossPercent?.sampleCount).toBe(2);
  });

  it("rejects duplicate call chains/versions, invalid observations and excessive aggregation size", () => {
    const available = parseCallQuality(record(), callChainId);
    expect(() => aggregateCallQuality([available, { ...available, version: 4 }])).toThrow(IntegrationError);
    expect(() => aggregateCallQuality([{ ...available, metrics: { jitterMs: { value: NaN, sampleCount: 1 } } }]))
      .toThrow(IntegrationError);
    expect(() => aggregateCallQuality(Array.from({
      length: callQualityLimits.recordsPerAggregation + 1,
    }, () => available))).toThrow(IntegrationError);
  });
});

describe("known-call Graph collector", () => {
  it("only GETs the exact known record with expansions and an explicit response byte limit", async () => {
    const { graph, fetcher } = client(() => Response.json(record([{ averagePacketLossRate: 0.02 }])));
    const json = vi.spyOn(graph, "json");
    const requestSignal = signal();
    expect(await collectCallQuality(graph, callChainId, requestSignal)).toMatchObject({
      callChainId, metrics: { packetLossPercent: { value: 2, sampleCount: 1 } },
    });
    const path = `/communications/callRecords/${callChainId}?$expand=sessions($expand=segments)`;
    expect(json).toHaveBeenCalledExactlyOnceWith(
      path, callQualityRecordSchema, requestSignal, "GET", undefined, true, "v1.0", callQualityLimits.maxResponseBytes,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://graph.microsoft.com/v1.0${path}`);
    expect(fetcher.mock.calls[0]![1]?.method).toBe("GET");
  });

  it("returns undefined only for explicit 404/pending without metrics or healthy zeros", async () => {
    const { graph, fetcher } = client(() => new Response(null, { status: 404 }));
    expect(await collectCallQuality(graph, callChainId, signal())).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[401, "authentication-failure"], [403, "permission-failure"]])("throws IntegrationError for HTTP %s", async (status, category) => {
    const { graph } = client(() => new Response(null, { status: status as number }));
    await expect(collectCallQuality(graph, callChainId, signal())).rejects.toMatchObject({
      name: "IntegrationError", status, category,
    });
  });

  it("throws IntegrationError for credential failure", async () => {
    const { graph, fetcher, token } = client(() => Response.json(record()));
    token.mockRejectedValueOnce(new Error("credential rejected"));
    await expect(collectCallQuality(graph, callChainId, signal())).rejects.toMatchObject({
      name: "IntegrationError", category: "authentication-failure",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["not-a-uuid", `${callChainId}/sessions`, `${callChainId}?$filter=all`, "", "../callRecords"])(
    "rejects invalid chain id %j before authentication or network", async id => {
      const { graph, fetcher, token } = client(() => Response.json(record()));
      await expect(collectCallQuality(graph, id, signal())).rejects.toMatchObject({
        name: "IntegrationError", category: "configuration-failure",
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(token).not.toHaveBeenCalled();
    },
  );

  it.each([
    () => new Response("{invalid"),
    () => Response.json({ ...record(), id: secondCallChainId }),
    () => Response.json(record([{ averagePacketLossRate: 1.1 }])),
    () => Response.json(record([{ averageRoundTripTime: "PT-1S" }])),
    () => Response.json({ ...record(), "sessions@odata.nextLink": "https://untrusted.invalid/next" }),
  ])("throws malformed IntegrationError, never pending, on malformed or partial payloads", async reply => {
    const { graph, fetcher } = client(reply);
    await expect(collectCallQuality(graph, callChainId, signal())).rejects.toMatchObject({
      name: "IntegrationError", category: "malformed-response",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("enforces the GraphClient body byte bound even on otherwise valid JSON", async () => {
    const { graph } = client(() => Response.json({
      ...record(), ignored: "x".repeat(callQualityLimits.maxResponseBytes),
    }));
    await expect(collectCallQuality(graph, callChainId, signal())).rejects.toMatchObject({
      name: "IntegrationError", category: "malformed-response",
    });
  });

  it("does not cache pending calls or retain a cross-cycle queue", async () => {
    let attempts = 0;
    const { graph, fetcher } = client(() => ++attempts === 1
      ? new Response(null, { status: 404 }) : Response.json(record()));
    expect(await collectCallQuality(graph, callChainId, signal())).toBeUndefined();
    expect(await collectCallQuality(graph, callChainId, signal())).toMatchObject({ callChainId });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("honors cancellation before any I/O", async () => {
    const { graph, fetcher, token } = client(() => Response.json(record()));
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    controller.abort(reason);
    await expect(collectCallQuality(graph, callChainId, controller.signal)).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
  });

  it("preserves cancellation during a request instead of treating a racing 404 as pending", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const { graph } = client(() => {
      controller.abort(reason);
      return new Response(null, { status: 404 });
    });
    await expect(collectCallQuality(graph, callChainId, controller.signal)).rejects.toBe(reason);
  });

  it("preserves cancellation during body reading instead of wrapping it as malformed", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const { graph } = client(() => new Response(new ReadableStream({
      pull(stream) {
        controller.abort(reason);
        stream.error(reason);
      },
    })));
    await expect(collectCallQuality(graph, callChainId, controller.signal)).rejects.toBe(reason);
  });

  it.each(["payload", "404"] as const)("rechecks cancellation after Graph settles with %s", async outcome => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const { graph, fetcher } = client(() => Response.json(record()));
    const json = vi.spyOn(graph, "json");
    if (outcome === "404") json.mockRejectedValueOnce(new IntegrationError("read-failure", 404));
    else json.mockResolvedValueOnce(callQualityRecordSchema.parse(record()));
    const collection = collectCallQuality(graph, callChainId, controller.signal);
    controller.abort(reason);
    await expect(collection).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
