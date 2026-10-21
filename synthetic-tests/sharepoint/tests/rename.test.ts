import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../utils/src/config.js";
import { resultSchema, type Probe } from "../../utils/src/contracts.js";
import { GraphClient } from "../../utils/src/graph.js";
import { AuthenticatedHttp } from "../../utils/src/http.js";
import { sharepointRenameProbe } from "../src/rename-journey.js";
import { readRenamedFile, renameFile } from "../src/rename-steps.js";
import type { FileAttempt } from "../src/steps.js";

const siteId = "approved,site/id";
const driveId = "drive/+?=approved";
const folderId = "folder/+?=approved";
const fileId = "file/+?=owned";
const probe: Probe = {
  id: "sharepoint-rename-001", cohort: "sharepoint-rename", type: "sharepoint-rename", siteId, driveId, folderId,
};
const config = loadConfig({ PROBE_TIMEOUT_MS: "120000" });
const json = (value: unknown) => new Response(JSON.stringify(value));
type Stage = "verify" | "upload" | "rename" | "read" | "cleanup";
interface Options {
  failure?: { stage: Stage; status: number };
  ambiguous?: "upload" | "rename";
  cancel?: "upload" | "rename" | "read" | "download";
  malformed?: "upload" | "rename";
  renameMismatch?: "id" | "name";
  readMismatch?: "id" | "name" | "content";
  wrongDrive?: boolean;
  authFail?: boolean;
  cleanupFail?: boolean;
}

async function runRename(options: Options = {}) {
  const controller = new AbortController();
  let clock = 1000;
  let authenticated = false;
  let content = "";
  let uploadName = "";
  let renameName = "";
  const calls: { url: string; method: string; body: unknown; aborted: boolean }[] = [];
  const telemetry = { emit: vi.fn() };
  const credential: TokenCredential = {
    getToken: vi.fn(async () => {
      if (!authenticated) { clock += 100; authenticated = true; }
      if (options.authFail) throw new Error("private credential error");
      return { token: "test-token", expiresOnTimestamp: Date.now() + 60000 };
    }),
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: path.href, method, body, aborted: init?.signal?.aborted ?? false });
    clock += 10;
    const stage: Stage = path.pathname.includes("/sites/") ? "verify" : method === "PUT" ? "upload"
      : method === "PATCH" ? "rename" : method === "DELETE" ? "cleanup" : "read";
    if (stage === "upload") {
      uploadName = path.pathname.split(":/")[1]!;
      content = String(init?.body);
    }
    if (stage === "rename") renameName = body.name;
    if (options.cancel === stage) {
      controller.abort();
      throw new DOMException("Cancelled", "AbortError");
    }
    if (options.ambiguous === stage) throw new Error("private network error");
    if (options.failure?.stage === stage) return new Response(null, { status: options.failure.status });
    if (stage === "cleanup" && options.cleanupFail) return new Response(null, { status: 403 });
    if (stage === "verify") return json({ value: [{ id: options.wrongDrive ? "unrelated-drive" : driveId }] });
    if (stage === "upload") return options.malformed === "upload" ? json({ unexpected: true }) : json({ id: fileId, name: uploadName });
    if (stage === "rename") {
      if (options.malformed === "rename") return json({ unexpected: true });
      return json({
        id: options.renameMismatch === "id" ? "unrelated-id" : fileId,
        name: options.renameMismatch === "name" ? "unrelated.txt" : renameName,
      });
    }
    if (stage === "cleanup") return new Response(null, { status: 204 });
    if (path.pathname.endsWith("/content")) return new Response(null, {
      status: 302, headers: { location: "https://approved.sharepoint.com/run-owned-download" },
    });
    return json({
      id: options.readMismatch === "id" ? "unrelated-id" : fileId,
      name: options.readMismatch === "name" ? uploadName : renameName,
    });
  });
  const download = vi.fn<typeof fetch>(async () => {
    clock += 20;
    if (options.cancel === "download") {
      controller.abort();
      throw new DOMException("Cancelled", "AbortError");
    }
    return options.readMismatch === "content" ? json({ correlationId: "another-run" }) : new Response(content);
  });
  const graph = new GraphClient(new AuthenticatedHttp(credential, "https://graph.microsoft.com/.default", {
    fetch: fetcher, attempts: 3, sleep: async () => {},
  }), download);
  const result = await sharepointRenameProbe(probe, {
    config, graph, telemetry, signal: controller.signal, now: () => clock,
  });
  expect(resultSchema.safeParse(result).success).toBe(true);
  expect(result.steps.map(step => step.name)).toEqual(["authenticate", "verify-drive", "upload-file", "rename-file", "read-file", "cleanup"]);
  return { result, calls, download, telemetry, credential, uploadName, renameName, content };
}

describe("SharePoint rename/reopen file journey", () => {
  it("refuses to rename or reopen a file that was not uploaded by this attempt", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const graph = new GraphClient(new AuthenticatedHttp({
      getToken: async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 60000 }),
    }, "https://graph.microsoft.com/.default", { fetch: fetcher }));
    const attempt: FileAttempt = {
      siteId, driveId, folderId, correlationId: "11111111-1111-4111-8111-111111111111",
      mutationAttempted: false, uploadedFileId: "owned-id",
    };
    const signal = new AbortController().signal;
    await expect(renameFile(graph, attempt, "unowned-id", signal)).rejects.toMatchObject({ category: "collector-failure" });
    await expect(readRenamedFile(graph, attempt, "unowned-id", signal)).rejects.toMatchObject({ category: "collector-failure" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("verifies the approved drive, renames one owned file and checks its reopened metadata and downloaded content", async () => {
    const { result, calls, download, credential, uploadName, renameName, content } = await runRename();
    expect(result).toMatchObject({
      success: true, durationMs: 180, uploadDurationMs: 10, readDurationMs: 40,
      diagnosticCategory: null, diagnosticContext: { testStage: "complete", cleanupSucceeded: true, authenticationDurationMs: 100 },
    });
    expect(result.steps.every(step => step.status === "succeeded")).toBe(true);
    expect(result.sendDurationMs).toBeUndefined();
    expect(result.deliveryDurationMs).toBeUndefined();
    expect(uploadName).toBe(`ahm-synthetic-${result.correlationId}.txt`);
    expect(renameName).toBe(`ahm-synthetic-${result.correlationId}-renamed.txt`);
    expect(JSON.parse(content)).toEqual({ correlationId: result.correlationId });
    const drive = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}`;
    const item = `${drive}/items/${encodeURIComponent(fileId)}`;
    expect(calls.map(call => call.method)).toEqual(["GET", "PUT", "PATCH", "GET", "GET", "DELETE"]);
    expect(calls[0]?.url).toBe(`https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(siteId)}/drives?$select=id`);
    expect(calls[1]?.url).toBe(`${drive}/items/${encodeURIComponent(folderId)}:/${uploadName}:/content`);
    expect(calls[2]).toMatchObject({ url: item, body: { name: renameName } });
    const reopened = new URL(calls[3]!.url);
    expect(reopened.origin + reopened.pathname).toBe(item);
    expect([...reopened.searchParams]).toEqual([["$select", "id,name"]]);
    expect(calls[4]?.url).toBe(`${item}/content`);
    expect(calls[5]?.url).toBe(item);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[1]).not.toHaveProperty("headers");
    expect(credential.getToken).toHaveBeenCalledWith("https://graph.microsoft.com/.default", expect.anything());
    expect(JSON.stringify(result)).not.toMatch(/approved|owned-download|test-token|another-run/);
  });

  it.each(["id", "name"] as const)("rejects a mismatched rename %s and deletes only the original owned ID", async renameMismatch => {
    const { result, calls, download } = await runRename({ renameMismatch });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "read-failure", diagnosticContext: { cleanupSucceeded: true } });
    expect(result.steps[3]).toMatchObject({ status: "failed", diagnosticCategory: "read-failure" });
    expect(result.steps[4]?.status).toBe("skipped");
    expect(result.readDurationMs).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
    expect(calls.at(-1)?.url).toBe(`https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(fileId)}`);
    expect(calls.some(call => call.url.includes("unrelated-id"))).toBe(false);
  });

  it.each(["id", "name", "content"] as const)("rejects a reopened %s mismatch", async readMismatch => {
    const { result, download } = await runRename({ readMismatch });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "read-failure", diagnosticContext: { cleanupSucceeded: true } });
    expect(result.steps[4]).toMatchObject({ status: "failed", diagnosticCategory: "read-failure" });
    expect(download).toHaveBeenCalledTimes(readMismatch === "content" ? 1 : 0);
  });

  it.each([
    ["verify", 403, "permission-failure", ["succeeded", "failed", "skipped", "skipped", "skipped", "skipped"]],
    ["upload", 503, "graph-unavailable", ["succeeded", "succeeded", "failed", "skipped", "skipped", "succeeded"]],
    ["rename", 403, "permission-failure", ["succeeded", "succeeded", "succeeded", "failed", "skipped", "succeeded"]],
    ["rename", 429, "graph-throttling", ["succeeded", "succeeded", "succeeded", "failed", "skipped", "succeeded"]],
    ["read", 404, "read-failure", ["succeeded", "succeeded", "succeeded", "succeeded", "failed", "succeeded"]],
  ] as const)("preserves %s API failure (%s) and skips dependent business actions", async (stage, status, category, statuses) => {
    const { result, calls, download } = await runRename({ failure: { stage, status } });
    expect(result).toMatchObject({ success: false, diagnosticCategory: category, diagnosticContext: { httpStatus: status } });
    expect(result.steps.map(step => step.status)).toEqual(statuses);
    expect(calls.filter(call => call.method === "PUT")).toHaveLength(stage === "verify" ? 0 : 1);
    expect(calls.filter(call => call.method === "PATCH")).toHaveLength(stage === "verify" || stage === "upload" ? 0 : 1);
    expect(download).not.toHaveBeenCalled();
  });

  it.each(["upload", "rename"] as const)("does not retry ambiguous %s responses and retains bounded owned cleanup", async ambiguous => {
    const { result, calls } = await runRename({ ambiguous });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "graph-unavailable", diagnosticContext: { cleanupSucceeded: true } });
    expect(calls.filter(call => call.method === (ambiguous === "upload" ? "PUT" : "PATCH"))).toHaveLength(1);
    expect(result.steps[4]?.status).toBe("skipped");
    const deletes = calls.filter(call => call.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url).toBe(ambiguous === "upload"
      ? `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folderId)}:/ahm-synthetic-${result.correlationId}.txt`
      : `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(fileId)}`);
  });

  it.each(["upload", "rename"] as const)("cleans up after malformed %s without trusting response IDs", async malformed => {
    const { result, calls } = await runRename({ malformed });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "malformed-response", diagnosticContext: { cleanupSucceeded: true } });
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(result.steps[4]?.status).toBe("skipped");
  });

  it.each(["upload", "rename", "read", "download"] as const)("cleans up with an independent budget after %s cancellation", async cancel => {
    const { result, calls } = await runRename({ cancel });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "cancelled", diagnosticContext: { cleanupSucceeded: true } });
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(calls.find(call => call.method === "DELETE")?.aborted).toBe(false);
  });

  it("does not touch any file when the drive is outside the approved site", async () => {
    const { result, calls } = await runRename({ wrongDrive: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "permission-failure" });
    expect(calls).toHaveLength(1);
    expect(result.steps.slice(2).map(step => step.status)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
    expect(result.steps[5]).toMatchObject({ reason: "no-mutation" });
  });

  it("fails the journey on owned cleanup failure and retains an earlier read failure", async () => {
    const completed = await runRename({ cleanupFail: true });
    expect(completed.result).toMatchObject({ success: false, diagnosticCategory: "cleanup-failure", diagnosticContext: { cleanupSucceeded: false } });
    const failed = await runRename({ readMismatch: "content", cleanupFail: true });
    expect(failed.result).toMatchObject({ success: false, diagnosticCategory: "read-failure", diagnosticContext: { cleanupSucceeded: false } });
    expect(failed.telemetry.emit).toHaveBeenCalledWith("probe-cleanup-failed", expect.objectContaining({ category: "cleanup-failure" }));
  });

  it("does not read or mutate resources without a real app token", async () => {
    const { result, calls, download } = await runRename({ authFail: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "authentication-failure" });
    expect(calls).toEqual([]);
    expect(download).not.toHaveBeenCalled();
    expect(result.steps.map(step => step.status)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped", "skipped"]);
  });
});
