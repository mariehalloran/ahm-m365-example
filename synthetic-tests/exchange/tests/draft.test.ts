import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../utils/src/config.js";
import { resultSchema, type Probe } from "../../utils/src/contracts.js";
import { GraphClient } from "../../utils/src/graph.js";
import { exchangeDraftProbe } from "../src/draft-journey.js";
import { readDraft, updateDraft } from "../src/draft-steps.js";
import type { MailAttempt } from "../src/steps.js";

const mailbox = "synthetic+owned@example.invalid";
const draftId = "draft/+?=immutable";
const probe: Probe = { id: "exchange-draft-001", cohort: "exchange-draft", type: "exchange-draft", mailbox };
const config = loadConfig({ PROBE_TIMEOUT_MS: "120000" });
const json = (value: unknown) => new Response(JSON.stringify(value));
type Stage = "create" | "update" | "initial-read" | "read" | "cleanup";
interface Options {
  failure?: { stage: Stage; status: number };
  ambiguous?: "create" | "update";
  cancel?: "create" | "update" | "read";
  malformed?: "create" | "read";
  mismatch?: "id" | "subject" | "bodyPreview" | "isDraft";
  cleanupNextPage?: boolean;
  authFail?: boolean;
  missingMailbox?: boolean;
  cleanupFail?: boolean;
  cleanupEnabled?: boolean;
}

async function runDraft(options: Options = {}) {
  const controller = new AbortController();
  let time = 1000;
  let subject = "";
  let editedContent = "";
  let createdContent = "";
  let created = false;
  const calls: { url: string; method: string; body: unknown; headers: Headers; aborted: boolean }[] = [];
  const telemetry = { emit: vi.fn() };
  const credential: TokenCredential = {
    getToken: vi.fn(async () => {
      if (options.authFail) throw new Error("private credential error");
      return { token: "test-token", expiresOnTimestamp: Date.now() + 60000 };
    }),
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: path.href, method, body, headers: new Headers(init?.headers), aborted: init?.signal?.aborted ?? false });
    time += 10;
    const stage: Stage = method === "POST" ? "create" : method === "PATCH" ? "update"
      : method === "DELETE" || path.searchParams.has("$filter") ? "cleanup" : editedContent ? "read" : "initial-read";
    if (stage === "create") {
      subject = body.subject;
      createdContent = body.body.content;
      created = true;
    }
    if (stage === "update") editedContent = body.body.content;
    if (options.cancel === stage) {
      controller.abort();
      throw new DOMException("Cancelled", "AbortError");
    }
    if (options.ambiguous === stage) throw new Error("private network error");
    if (options.failure?.stage === stage) return new Response(null, { status: options.failure.status });
    if (stage === "cleanup" && options.cleanupFail) return new Response(null, { status: 403 });
    if (method === "POST") return options.malformed === "create" ? json({ unexpected: true }) : json({ id: draftId });
    if (method === "PATCH") return json({ id: draftId });
    if (method === "DELETE") { created = false; return new Response(null, { status: 204 }); }
    if (stage === "cleanup") return json({
      value: created ? [{ id: draftId }, { id: "owned-copy" }] : [],
      ...(options.cleanupNextPage ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/another/messages" } : {}),
    });
    if (options.malformed === "read" && stage === "read") return json({ id: draftId });
    const saved: Record<string, unknown> = { id: draftId, subject, bodyPreview: editedContent || createdContent, isDraft: true };
    if (options.mismatch && stage === "read") saved[options.mismatch] = options.mismatch === "isDraft" ? false : "unrelated";
    return json(saved);
  });
  const graph = new GraphClient(credential, {
    fetch: fetcher, attempts: 3, sleep: async () => {},
  });
  const selectedProbe = { ...probe };
  if (options.missingMailbox) delete selectedProbe.mailbox;
  const result = await exchangeDraftProbe(selectedProbe, {
    config: { ...config, EXCHANGE_CLEANUP_ENABLED: options.cleanupEnabled === false ? "false" : "true" },
    graph, telemetry, signal: controller.signal, now: () => time,
  });
  expect(resultSchema.safeParse(result).success).toBe(true);
  expect(result.steps.map(step => step.name)).toEqual(["authenticate", "create-draft", "read-initial-draft", "update-draft", "read-draft", "delete-draft", "cleanup"]);
  return { result, calls, telemetry, credential, subject, editedContent, createdContent };
}

describe("Exchange save/edit/reopen draft journey", () => {
  it.each([undefined, "update", "read"] as const)("retains the draft without cleanup/reconciliation after %s", async stage => {
    const { result, calls, telemetry } = await runDraft({
      cleanupEnabled: false, ...(stage ? { failure: { stage, status: 503 } } : {}),
    });
    expect(result.success).toBe(stage === undefined);
    expect(result.steps.at(-1)).toMatchObject({ name: "cleanup", status: "skipped", reason: "cleanup-disabled" });
    expect(result.steps.at(-1)).not.toHaveProperty("durationMs");
    expect(result.diagnosticContext).not.toHaveProperty("cleanupSucceeded");
    expect(calls.some(call => call.method === "DELETE" || new URL(call.url).searchParams.has("$filter"))).toBe(false);
    expect(telemetry.emit).toHaveBeenCalledWith("exchange-cleanup-disabled", expect.objectContaining({
      mode: "live", mutationAttempted: true,
    }));
  });
  it("refuses to edit or reopen a message that was not created by this attempt", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const graph = new GraphClient({
      getToken: async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 60000 }),
    }, { fetch: fetcher });
    const attempt: MailAttempt = {
      mailbox, correlationId: "11111111-1111-4111-8111-111111111111",
      ownedMessageIds: new Set(), mutationAttempted: false,
    };
    const signal = new AbortController().signal;
    await expect(updateDraft(graph, attempt, "unowned-id", signal)).rejects.toMatchObject({ category: "collector-failure" });
    await expect(readDraft(graph, attempt, "unowned-id", signal)).rejects.toMatchObject({ category: "collector-failure" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("authenticates, saves a distinct edit, reopens the immutable draft and removes only owned copies without sending", async () => {
    const { result, calls, credential, subject, editedContent, createdContent } = await runDraft();
    expect(result).toMatchObject({ success: true, diagnosticCategory: null, diagnosticContext: { testStage: "complete", cleanupSucceeded: true } });
    expect(result.steps.every(step => step.status === "succeeded")).toBe(true);
    expect(result.sendDurationMs).toBeUndefined();
    expect(result.deliveryDurationMs).toBeUndefined();
    expect(subject).toBe(`AHM synthetic ${result.correlationId}`);
    expect(editedContent).not.toBe(createdContent);
    expect(editedContent).toContain(result.correlationId);
    expect(editedContent.length).toBeLessThan(255);
    expect(calls[0]?.body).toMatchObject({
      subject,
      internetMessageHeaders: [{ name: "x-ahm-correlation-id", value: result.correlationId }],
    });
    expect(calls[2]?.body).toEqual({ body: { contentType: "Text", content: editedContent } });
    expect(calls.map(call => call.method)).toEqual(["POST", "GET", "PATCH", "GET", "DELETE", "GET"]);
    const messages = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages`;
    const ownedDraft = `${messages}/${encodeURIComponent(draftId)}`;
    expect(calls[0]?.url).toBe(messages);
    expect(calls[2]?.url).toBe(ownedDraft);
    const reopened = new URL(calls[3]!.url);
    expect(reopened.origin + reopened.pathname).toBe(ownedDraft);
    expect([...reopened.searchParams]).toEqual([["$select", "id,subject,bodyPreview,isDraft"]]);
    const cleanup = new URL(calls[5]!.url);
    expect(cleanup.origin + cleanup.pathname).toBe(messages);
    expect(Object.fromEntries(cleanup.searchParams)).toEqual({
      "$filter": `subject eq '${subject}'`, "$select": "id", "$top": "100",
    });
    expect(calls.filter(call => call.method === "DELETE").map(call => call.url)).toEqual([ownedDraft]);
    expect(calls.every(call => call.headers.get("prefer") === 'IdType="ImmutableId"')).toBe(true);
    expect(calls.every(call => call.headers.get("authorization") === "Bearer test-token")).toBe(true);
    expect(credential.getToken).toHaveBeenCalledWith(["https://graph.microsoft.com/.default"], expect.anything());
    expect(calls.some(call => call.url.includes("/send") || call.url.includes("/mailFolders"))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/test-token|example\.invalid|owned-copy|immutable/);
  });

  it.each(["id", "subject", "bodyPreview", "isDraft"] as const)("rejects saved draft %s mismatch", async mismatch => {
    const { result, calls } = await runDraft({ mismatch });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "read-failure", diagnosticContext: { cleanupSucceeded: true } });
    expect(result.steps[4]).toMatchObject({ status: "failed", diagnosticCategory: "read-failure" });
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
  });

  it.each([
    ["create", 403, "permission-failure", ["succeeded", "failed", "skipped", "skipped", "skipped", "skipped", "succeeded"]],
    ["create", 503, "graph-unavailable", ["succeeded", "failed", "skipped", "skipped", "skipped", "skipped", "succeeded"]],
    ["update", 503, "graph-unavailable", ["succeeded", "succeeded", "succeeded", "failed", "skipped", "skipped", "succeeded"]],
    ["read", 404, "read-failure", ["succeeded", "succeeded", "succeeded", "succeeded", "failed", "skipped", "succeeded"]],
    ["update", 429, "graph-throttling", ["succeeded", "succeeded", "succeeded", "failed", "skipped", "skipped", "succeeded"]],
  ] as const)("preserves %s API failure (%s) and skips dependent business actions", async (stage, status, category, statuses) => {
    const { result, calls } = await runDraft({ failure: { stage, status } });
    expect(result).toMatchObject({ success: false, diagnosticCategory: category, diagnosticContext: { httpStatus: status, cleanupSucceeded: true } });
    expect(result.steps.map(step => step.status)).toEqual(statuses);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
    expect(calls.filter(call => call.method === "PATCH")).toHaveLength(stage === "create" ? 0 : 1);
    if (stage === "create") expect(calls.some(call => new URL(call.url).searchParams.get("$select")?.includes("bodyPreview"))).toBe(false);
  });

  it.each(["create", "update"] as const)("does not retry an ambiguous %s and still cleans up the exact run marker", async ambiguous => {
    const { result, calls } = await runDraft({ ambiguous });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "graph-unavailable", diagnosticContext: { cleanupSucceeded: true } });
    expect(calls.filter(call => call.method === (ambiguous === "create" ? "POST" : "PATCH"))).toHaveLength(1);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
    expect(result.steps[4]?.status).toBe("skipped");
  });

  it.each(["create", "update", "read"] as const)("uses an independent cleanup budget after %s cancellation", async cancel => {
    const { result, calls } = await runDraft({ cancel });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "cancelled", diagnosticContext: { cleanupSucceeded: true } });
    expect(calls.filter(call => call.method === "DELETE").every(call => !call.aborted)).toBe(true);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(2);
  });

  it.each(["create", "read"] as const)("fails malformed %s responses instead of accepting an incomplete journey", async malformed => {
    const { result } = await runDraft({ malformed });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "malformed-response", diagnosticContext: { cleanupSucceeded: true } });
    if (malformed === "create") expect(result.steps.slice(2, 4).map(step => step.status)).toEqual(["skipped", "skipped"]);
  });

  it("bounds ambiguous-copy discovery and never follows another mailbox's continuation", async () => {
    const { result, calls } = await runDraft({ cleanupNextPage: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "cleanup-failure", diagnosticContext: { cleanupSucceeded: false } });
    expect(calls).toHaveLength(6);
    expect(calls.some(call => call.url.includes("another"))).toBe(false);
  });

  it("fails a completed journey on cleanup failure without replacing an earlier business failure", async () => {
    const completed = await runDraft({ cleanupFail: true });
    expect(completed.result).toMatchObject({ success: false, diagnosticCategory: "cleanup-failure" });
    const failed = await runDraft({ mismatch: "bodyPreview", cleanupFail: true });
    expect(failed.result).toMatchObject({ success: false, diagnosticCategory: "read-failure", diagnosticContext: { cleanupSucceeded: false } });
    expect(failed.telemetry.emit).toHaveBeenCalledWith("probe-cleanup-failed", expect.objectContaining({ category: "cleanup-failure" }));
  });

  it.each([{ authFail: true }, { missingMailbox: true }])("does not query or mutate when authentication prerequisites fail: %j", async options => {
    const { result, calls } = await runDraft(options);
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("missingMailbox" in options ? "configuration-failure" : "authentication-failure");
    expect(calls).toEqual([]);
    expect(result.steps.map(step => step.status)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    expect(result.steps[6]).toMatchObject({ reason: "no-mutation" });
  });
});
