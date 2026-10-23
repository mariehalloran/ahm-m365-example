import { afterEach, describe, expect, it, vi } from "vitest";
import { serviceRuntime } from "../../utils/src/runtime.js";
import { parseServiceConfig, serviceSettings } from "../../utils/src/service-config.js";
import { runCycle } from "../../utils/src/runner.js";
import { aggregateHealthReports } from "../../utils/src/health-reports.js";
import { teamsProbe, teamsReplyProbe } from "../src/journey.js";
import { IntegrationError } from "../../utils/src/http.js";
import { outcomeOf } from "../../utils/src/results.js";

const state = vi.hoisted(() => ({ unavailable: "", wrongPostingAuthor: "" }));
const users = [
  { username: "user1@example.invalid", id: "11111111-1111-4111-8111-111111111111" },
  { username: "user2@example.invalid", id: "22222222-2222-4222-8222-222222222222" },
  { username: "user3@example.invalid", id: "33333333-3333-4333-8333-333333333333" },
];
vi.mock("../../utils/src/teams-user-auth.js", () => ({
  createTeamsUserCredentials: () => new Map(users.map(user => [user.username, {
    userId: user.id,
    getToken: async () => {
      if (state.unavailable === user.username) throw new IntegrationError("reauthentication-required");
      return { token: `fake-for-${user.id}`, expiresOnTimestamp: Date.now() + 3600000 };
    },
  }])),
}));

const service = parseServiceConfig({
  type: "teams", mode: "live", teamsAuthentication: "user-delegated", enabled: true, cohort: "teams-global", intervalSeconds: 120, timeoutSeconds: 45,
  targets: users.map((user, index) => ({
    id: `teams-00${index + 1}`, userPrincipalName: user.username,
    tenantId: "44444444-4444-4444-8444-444444444444",
    teamId: "55555555-5555-4555-8555-555555555555", channelId: "dedicated-standard-channel",
  })),
});
const config = serviceSettings(service, { ENABLE_LIVE_M365: "true" }, {
  "publish-channel-message": true, "reply-channel-message": true,
});
const policy = {
  name: "test-model", subscriptionId: "44444444-4444-4444-8444-444444444444", resourceGroup: "test-rg",
  reportTtlMinutes: 15, successDegradedPercent: 99, successUnhealthyPercent: 95,
  latencyDegradedMilliseconds: 15000, latencyUnhealthyMilliseconds: 60000,
};

afterEach(() => {
  state.unavailable = "";
  state.wrongPostingAuthor = "";
  vi.unstubAllGlobals();
});

async function cycleFixture(cleanupEnabled = true, populated = false) {
  type Message = { id: string; author: string; content: string; parent: string | undefined; deleted: boolean };
  const messages = new Map<string, Message>();
  if (populated) {
    for (let index = 0; index < 50; index++) messages.set(`existing-${index}`, {
      id: `existing-${index}`, author: users[0]!.id, content: "unrelated retained content", parent: undefined, deleted: false,
    });
  }
  const posts: { author: string; path: string }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)), path = url.pathname;
    const author = new Headers(init?.headers).get("Authorization")?.replace("Bearer fake-for-", "") ?? "";
    const user = users.find(user => user.id === author)!;
    if (!user) throw new Error("Wrong credential route");
    const parts = path.split("/");
    if (init?.method === "POST" && path.endsWith("/softDelete")) {
      const message = messages.get(parts.at(-2)!)!;
      if (message.author !== author) throw new Error("Cross-account deletion");
      message.deleted = true;
      return new Response(null, { status: 204 });
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { body: { content: string } };
      const message: Message = {
        id: `message-${messages.size + 1}`, author, content: body.body.content, deleted: false,
        parent: path.endsWith("/replies") ? parts.at(-2) : undefined,
      };
      messages.set(message.id, message);
      posts.push({ author, path });
      return Response.json({
        id: message.id,
        from: { user: { id: state.wrongPostingAuthor === user.username ? users[0]!.id : author } },
      }, { status: 201 });
    }
    if (messages.has(parts.at(-1)!)) {
      const message = messages.get(parts.at(-1)!)!;
      return Response.json({
        id: message.id, body: { contentType: "text", content: message.content },
        from: { user: { id: message.author } },
        deletedDateTime: message.deleted ? new Date().toISOString() : null,
      });
    }
    const parent = path.endsWith("/replies") ? parts.at(-2) : undefined;
    return Response.json({ value: [...messages.values()].filter(message =>
      !message.deleted && message.parent === parent).map(message => ({
      id: message.id, body: { contentType: "text", content: message.content }, from: { user: { id: message.author } },
    })).slice(0, 50), ...(populated ? {
      "@odata.nextLink": `${url.origin}${path.replace(/%3A/gi, ":").replace(/%40/gi, "@")}?$top=50&$skiptoken=${"x".repeat(608)}`,
    } : {}) });
  });
  vi.stubGlobal("fetch", fetcher);
  const selectedService = { ...service, teamsCleanupEnabled: cleanupEnabled };
  const executionConfig = serviceSettings(selectedService, { ENABLE_LIVE_M365: "true" }, {
    "publish-channel-message": true, "reply-channel-message": true,
  });
  const runtime = await serviceRuntime(selectedService, executionConfig, { emit: vi.fn() }, {}, {
    record: vi.fn(), recordDiagnostic: vi.fn(),
  });
  const cycle = await runCycle(executionConfig, {
    ...runtime, handler: (probe, context) =>
      (probe.type === "teams-channel-reply" ? teamsReplyProbe : teamsProbe)(probe, context),
  });
  return { cycle, runtime, messages, posts, fetcher };
}

describe("one Teams worker with three isolated delegated accounts", () => {
  it("confirms all six attempts in a channel with 50 retained posts without listing channel/reply collections", async () => {
    const { cycle, messages, fetcher } = await cycleFixture(false, true);
    expect(cycle.results).toHaveLength(6);
    expect(cycle.results.every(result => result.success)).toBe(true);
    expect(messages.size).toBe(59);
    const reads = fetcher.mock.calls.filter(([, init]) => !init?.method || init.method === "GET");
    expect(reads).toHaveLength(9);
    expect(reads.every(([url]) => /\/message-\d+$/.test(new URL(String(url)).pathname))).toBe(true);
    for (const entity of ["teams-global", "teams-reply"]) {
      const reports = aggregateHealthReports("teams", cycle, policy);
      expect(reports).toHaveLength(14);
      expect(JSON.parse(reports.find(report => report.entityName === entity)!.body.additionalContext))
        .toMatchObject({ attempted: 3, succeeded: 3 });
    }
  });
  it("carries service-config retention through runtime/routing for all six attempts without extra signal inventories", async () => {
    const { cycle, messages, runtime } = await cycleFixture(false);
    expect(cycle.results).toHaveLength(6);
    expect([...messages.values()]).toHaveLength(9);
    expect([...messages.values()].every(message => !message.deleted)).toBe(true);
    for (const result of cycle.results) {
      expect(result.success).toBe(true);
      expect(result.steps.at(-1)).toMatchObject({ status: "skipped", reason: "cleanup-disabled" });
      expect(result.diagnosticContext).not.toHaveProperty("cleanupSucceeded");
    }
    expect(vi.mocked(runtime.telemetry.emit).mock.calls.filter(([event]) => event === "teams-cleanup-disabled")).toHaveLength(6);
    const reports = aggregateHealthReports("teams", cycle, policy);
    expect(reports).toHaveLength(14);
    for (const entity of ["teams-global", "teams-reply"]) {
      expect(JSON.parse(reports.find(report => report.entityName === entity)!.body.additionalContext))
        .toMatchObject({ attempted: 3, succeeded: 3 });
    }
  });
  it("routes both scenarios per target, validates the actual author and cleans up using the owning account", async () => {
    const { cycle, posts, messages, runtime } = await cycleFixture();
    expect(cycle.results).toHaveLength(6);
    expect(cycle.results.every(result => result.success)).toBe(true);
    expect(runtime.graph).toBeUndefined();
    expect(runtime.teamsBot).toBeUndefined();
    for (const user of users) {
      expect(posts.filter(post => post.author === user.id)).toHaveLength(3);
    }
    expect([...messages.values()].every(message => message.deleted)).toBe(true);
    const first = runtime.clientsForProbe!(config.probes[0]!);
    expect(runtime.clientsForProbe!(config.probes[3]!).graph).toBe(first.graph);
    expect(runtime.clientsForProbe!(config.probes[1]!).graph).not.toBe(first.graph);
    expect(() => runtime.clientsForProbe!({ ...config.probes[0]!, userPrincipalName: users[1]!.username }))
      .toThrow("configuration-failure");
    const reports = aggregateHealthReports("teams", cycle, policy);
    for (const entity of ["teams-global", "teams-reply"]) {
      const report = reports.find(report => report.entityName === entity && report.body.signalName === "synthetic-success-percentage")!;
      expect(JSON.parse(report.body.additionalContext)).toMatchObject({ attempted: 3, succeeded: 3 });
      expect(report.body.value).toBe(100);
    }
    expect(reports).toHaveLength(14);
    expect(JSON.stringify(reports)).not.toContain("user1@example");
  });
  it("keeps healthy accounts running when User2 needs reauthentication, with three independent journey attempts", async () => {
    state.unavailable = users[1]!.username;
    const { cycle, posts } = await cycleFixture();
    expect(cycle.results).toHaveLength(6);
    expect(cycle.results.filter(result => result.success)).toHaveLength(4);
    for (const result of cycle.results.filter(result => result.testId === "teams-002")) {
      expect(result.diagnosticCategory).toBe("reauthentication-required");
      expect(outcomeOf(result)).toBe("unexecutable");
      expect(result.steps.filter(step => !["authenticate", "cleanup"].includes(step.name))
        .every(step => step.status === "skipped")).toBe(true);
    }
    expect(posts.some(post => post.author === users[1]!.id)).toBe(false);
    const reports = aggregateHealthReports("teams", cycle, policy);
    for (const entity of ["teams-global", "teams-reply"]) {
      const report = reports.find(report => report.entityName === entity && report.body.signalName === "synthetic-success-percentage")!;
      expect(JSON.parse(report.body.additionalContext)).toMatchObject({ attempted: 3, succeeded: 2 });
      expect(report.body.value).toBeCloseTo(200 / 3);
    }
  });
  it("does not accept another user's posting author even when that user is also configured", async () => {
    state.wrongPostingAuthor = users[1]!.username;
    const { cycle } = await cycleFixture();
    expect(cycle.results.filter(result => result.success)).toHaveLength(4);
    expect(cycle.results.filter(result => result.testId === "teams-002")
      .every(result => result.diagnosticCategory === "authentication-failure")).toBe(true);
  });
});
