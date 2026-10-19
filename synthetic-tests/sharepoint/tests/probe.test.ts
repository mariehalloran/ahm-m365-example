import type { TokenCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../utils/src/config.js";
import { resultSchema, type Probe } from "../../utils/src/contracts.js";
import { GraphClient } from "../../utils/src/graph.js";
import { AuthenticatedHttp } from "../../utils/src/http.js";
import { sharepointProbe } from "../src/journey.js";
import { authenticate, cleanup, readFile, uploadFile, verifyDrive, type FileAttempt } from "../src/steps.js";

const probe: Probe = {
  id: "sharepoint-001",
  type: "sharepoint-file",
  cohort: "sharepoint-global",
  siteId: "site-approved",
  driveId: "drive-approved",
  folderId: "folder-approved",
};
const config = loadConfig({ PROBE_TIMEOUT_MS: "120000" });
const json = (value: unknown) => new Response(JSON.stringify(value));

async function runSharePoint(options: {
  failure?: "auth" | "upload" | "download" | "verify" | "cleanup";
  wrongDrive?: boolean;
  malformedUpload?: boolean;
  drivePages?: number;
  nextLink?: string;
  redirect?: string;
  oversizedDownload?: boolean;
  cancelDownload?: boolean;
} = {}) {
  let clock = 1000;
  let authenticated = false;
  let drivePage = 0;
  let content = "";
  let fileName = "";
  const controller = new AbortController();
  const calls: { url: string; method: string; aborted: boolean }[] = [];
  const telemetry = { emit: vi.fn() };
  const credential: TokenCredential = {
    getToken: async () => {
      if (!authenticated) {
        clock += 100;
        authenticated = true;
        if (options.failure === "auth") throw new Error("private auth response");
      }
      return { token: "graph-test-token", expiresOnTimestamp: Date.now() + 100000 };
    },
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    calls.push({ url: path, method, aborted: init?.signal?.aborted ?? false });
    if (path.includes("/sites/")) {
      clock += 100;
      drivePage++;
      const hasNextPage = drivePage < (options.drivePages ?? 1);
      return json({
        value: [{ id: hasNextPage || options.wrongDrive ? "unrelated-drive" : probe.driveId }],
        ...(options.nextLink || hasNextPage ? {
          "@odata.nextLink": options.nextLink ??
            `https://graph.microsoft.com/v1.0/sites/site-approved/drives?$skiptoken=${drivePage}`,
        } : {}),
      });
    }
    if (method === "PUT") {
      clock += 200;
      content = String(init?.body);
      fileName = new URL(path).pathname.split(":/")[1]!;
      if (options.failure === "upload") return new Response(null, { status: 403 });
      return options.malformedUpload ? json({ unexpected: "private response" }) : json({ id: "owned-file", name: fileName });
    }
    if (path.endsWith("/content")) {
      clock += 100;
      return new Response(null, {
        status: 302,
        headers: { location: options.redirect ?? "https://example.sharepoint.com/approved-download" },
      });
    }
    if (method === "DELETE") {
      clock += 300;
      return new Response(null, { status: options.failure === "cleanup" ? 403 : 204 });
    }
    throw new Error("Unexpected Graph request");
  });
  const download = vi.fn<typeof fetch>(async () => {
    clock += 200;
    if (options.cancelDownload) {
      controller.abort();
      throw new DOMException("Cancelled", "AbortError");
    }
    if (options.failure === "download") return new Response(null, { status: 503 });
    return new Response(options.oversizedDownload
      ? "x".repeat(4097)
      : options.failure === "verify" ? '{"correlationId":"wrong-run"}' : content);
  });
  const graph = new GraphClient(
    new AuthenticatedHttp(credential, "https://graph.microsoft.com/.default", { fetch: fetcher, attempts: 1 }),
    download,
  );
  const result = await sharepointProbe(probe, {
    config, graph, telemetry, signal: controller.signal, now: () => clock,
  });
  expect(resultSchema.safeParse(result).success).toBe(true);
  expect(result.steps.map(step => step.name)).toEqual(["authenticate", "verify-drive", "upload-file", "read-file", "cleanup"]);
  return { result, calls, download, fileName, telemetry, drivePage };
}

describe("SharePoint upload/readback/cleanup journey", () => {
  it("exposes authentication, drive verification, upload, read and cleanup as reusable direct actions", async () => {
    const correlationId = "11111111-1111-4111-8111-111111111111";
    const calls: string[] = [];
    const credential: TokenCredential = { getToken: async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 60000 }) };
    const graph = new GraphClient(new AuthenticatedHttp(credential, "https://graph.microsoft.com/.default", {
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
        if (String(url).includes("/sites/")) return json({ value: [{ id: "drive-approved" }] });
        if (init?.method === "PUT") return json({ id: "direct-file", name: `ahm-synthetic-${correlationId}.txt` });
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return new Response(null, { status: 302, headers: { location: "https://example.sharepoint.com/approved" } });
      },
    }), async () => json({ correlationId }));
    const attempt: FileAttempt = {
      siteId: "site-approved", driveId: "drive-approved", folderId: "folder-approved", correlationId, mutationAttempted: false,
    };
    const signal = new AbortController().signal;
    expect(await authenticate(graph, signal)).toBe(graph);
    await verifyDrive(graph, attempt, signal);
    const id = await uploadFile(graph, attempt, signal);
    expect(id).toBe("direct-file");
    await readFile(graph, attempt, id, signal);
    await cleanup(graph, attempt, signal);
    expect(calls.map(call => call.split(" ")[0])).toEqual(["GET", "PUT", "GET", "DELETE"]);
  });
  it("verifies the exact uploaded payload and reports request timings without forwarding Graph credentials", async () => {
    const { result, calls, download, fileName } = await runSharePoint();
    expect(result).toMatchObject({
      success: true,
      durationMs: 1000,
      uploadDurationMs: 200,
      readDurationMs: 300,
      diagnosticContext: { authenticationDurationMs: 100, cleanupSucceeded: true, testStage: "complete" },
    });
    expect(result.deliveryDurationMs).toBeUndefined();
    expect(result.steps.map(step => [step.name, step.status])).toEqual([
      ["authenticate", "succeeded"], ["verify-drive", "succeeded"], ["upload-file", "succeeded"],
      ["read-file", "succeeded"], ["cleanup", "succeeded"],
    ]);
    expect(result.sendDurationMs).toBeUndefined();
    expect(fileName).toBe(`ahm-synthetic-${result.correlationId}.txt`);
    expect(calls.filter(call => call.method === "DELETE").map(call => call.url))
      .toEqual(["https://graph.microsoft.com/v1.0/drives/drive-approved/items/owned-file"]);
    expect(download.mock.calls[0]?.[1]).not.toHaveProperty("headers");
    expect(JSON.stringify(result)).not.toMatch(/drive-approved|folder-approved|owned-file|graph-test-token/);
  });
  it("finds an approved drive on the next page without broadening the site scope", async () => {
    const { result, drivePage } = await runSharePoint({ drivePages: 2 });
    expect(result.success).toBe(true);
    expect(drivePage).toBe(2);
  });
  it("rejects an unrelated drive without mutating files", async () => {
    const { result, calls } = await runSharePoint({ wrongDrive: true });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "permission-failure" });
    expect(calls.every(call => call.method === "GET")).toBe(true);
    expect(result.uploadDurationMs).toBeUndefined();
    expect(result.steps.map(step => step.status)).toEqual(["succeeded", "failed", "skipped", "skipped", "skipped"]);
  });
  it.each([
    "https://untrusted.invalid/v1.0/sites/site-approved/drives",
    "https://graph.microsoft.com/v1.0/sites/another-site/drives",
    "https://graph.microsoft.com/v1.0/users",
  ])("rejects pagination outside the approved site collection: %s", async nextLink => {
    const { result, calls } = await runSharePoint({ wrongDrive: true, nextLink });
    expect(result.diagnosticCategory).toBe("read-failure");
    expect(calls).toHaveLength(1);
  });
  it("bounds drive discovery rather than paging indefinitely", async () => {
    const { result, calls, drivePage } = await runSharePoint({ drivePages: 10 });
    expect(result.diagnosticCategory).toBe("read-failure");
    expect(drivePage).toBe(5);
    expect(calls.every(call => call.method === "GET")).toBe(true);
  });
  it.each([
    ["upload", "permission-failure"],
    ["download", "read-failure"],
    ["verify", "read-failure"],
    ["cleanup", "cleanup-failure"],
  ] as const)("reports %s failure and attempts only owned cleanup", async (failure, category) => {
    const { result, calls, download } = await runSharePoint({ failure });
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe(category);
    expect(calls.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(result.uploadDurationMs).toBe(200);
    expect(result.readDurationMs).toBe(failure === "upload" ? undefined : 300);
    const step = failure === "upload" ? "upload-file" : failure === "cleanup" ? "cleanup" : "read-file";
    expect(result.steps.find(item => item.name === step)).toMatchObject({ status: "failed", diagnosticCategory: category });
    if (failure === "upload") {
      expect(result.steps.find(item => item.name === "read-file")?.status).toBe("skipped");
      expect(download).not.toHaveBeenCalled();
    }
  });
  it("cleans up by exact generated path after an ambiguous/malformed upload response", async () => {
    const { result, calls, fileName } = await runSharePoint({ malformedUpload: true });
    expect(result).toMatchObject({
      success: false, diagnosticCategory: "malformed-response",
      uploadDurationMs: 200, diagnosticContext: { cleanupSucceeded: true },
    });
    expect(calls.filter(call => call.method === "DELETE").map(call => call.url))
      .toEqual([`https://graph.microsoft.com/v1.0/drives/drive-approved/items/folder-approved:/${fileName}`]);
  });
  it("does not access or mutate resources after authentication fails", async () => {
    const { result, calls } = await runSharePoint({ failure: "auth" });
    expect(result).toMatchObject({ success: false, durationMs: 100, diagnosticCategory: "authentication-failure" });
    expect(result.uploadDurationMs).toBeUndefined();
    expect(result.readDurationMs).toBeUndefined();
    expect(calls).toEqual([]);
    expect(result.steps.map(step => step.status)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped"]);
  });
  it.each([
    "http://example.sharepoint.com/download",
    "https://untrusted.invalid/download",
    "https://example.sharepoint.com:8443/download",
  ])("refuses unsafe download endpoints: %s", async redirect => {
    const { result, calls, download } = await runSharePoint({ redirect });
    expect(result.diagnosticCategory).toBe("read-failure");
    expect(download).not.toHaveBeenCalled();
    expect(calls.some(call => call.method === "DELETE")).toBe(true);
  });
  it("rejects oversized content without accepting a matching upload alone as success", async () => {
    const { result } = await runSharePoint({ oversizedDownload: true });
    expect(result).toMatchObject({
      success: false, diagnosticCategory: "read-failure", diagnosticContext: { cleanupSucceeded: true },
    });
  });
  it("still cleans up with an independent cancellation budget after the download is cancelled", async () => {
    const { result, calls } = await runSharePoint({ cancelDownload: true });
    expect(result).toMatchObject({ success: false, diagnosticContext: { cleanupSucceeded: true } });
    expect(calls.find(call => call.method === "DELETE")?.aborted).toBe(false);
  });
});
