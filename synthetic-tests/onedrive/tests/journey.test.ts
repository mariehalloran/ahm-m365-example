import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GraphClient } from "../../utils/src/graph.js";
import { IntegrationError } from "../../utils/src/http.js";
import { resultSchema, type Probe, type TestType } from "../../utils/src/contracts.js";
import type { ProbeContext } from "../../utils/src/probes.js";
import { oneDriveProbe } from "../src/journey.js";

const userId = "11111111-1111-4111-8111-111111111111";
const probe = (type: TestType = "onedrive-roundtrip"): Probe => ({
  id: "user-1", type, cohort: "onedrive-global", userId, userPrincipalName: "user1@example.invalid",
  driveId: "drive-1", folderId: "approved", folderName: "AHM-Synthetic-Tests",
});
interface Item {
  id: string; name: string; parentReference: { id: string; driveId: string };
  folder?: object; file?: object; specialFolder?: { name: string };
  bytes?: Buffer; history?: Buffer[];
}

function fixture() {
  const items = new Map<string, Item>([
    ["approved", { id: "approved", name: "AHM-Synthetic-Tests", folder: {}, parentReference: { id: "root", driveId: "drive-1" } }],
    ["approot", { id: "approot", name: "OneDrive Monitor", folder: {}, specialFolder: { name: "approot" }, parentReference: { id: "apps", driveId: "drive-1" } }],
  ]);
  const paths: { path: string; method: string; body?: unknown }[] = [];
  const faults: {
    noVersions?: boolean; badHash?: boolean; permission?: boolean; appUnavailable?: boolean;
    malformedUpload?: boolean; cleanupFailure?: boolean; hostilePage?: boolean; wrongFolder?: boolean;
    ambiguousCreate?: boolean;
  } = {};
  let sequence = 0;
  const locate = (path: string) => {
    const parsed = /\/items\/([^/:?]+)(?::\/([^?]+?)(?=:\/content|$))?/.exec(path);
    const id = parsed?.[1] ? decodeURIComponent(parsed[1]) : undefined;
    const name = parsed?.[2] ? decodeURIComponent(parsed[2]) : undefined;
    const item = name
      ? [...items.values()].find(item => item.parentReference.id === id && item.name === name)
      : id ? items.get(id) : undefined;
    return { id, name, item };
  };
  const raw = async (path: string, signal: AbortSignal, method = "GET", body?: unknown): Promise<unknown> => {
    signal.throwIfAborted();
    paths.push({ path, method, ...(body === undefined ? {} : { body }) });
    if (faults.permission) throw new IntegrationError("permission-failure", 403);
    if (path.includes("/special/approot")) {
      if (faults.appUnavailable) throw new IntegrationError("read-failure", 404);
      return items.get("approot");
    }
    const { id, name, item } = locate(path);
    if (method === "POST" && path.endsWith("/children")) {
      const folder: Item = {
        id: `folder-${++sequence}`, name: (body as { name: string }).name,
        folder: {}, parentReference: { id: id!, driveId: "drive-1" },
      };
      items.set(folder.id, folder);
      if (faults.ambiguousCreate) throw new IntegrationError("graph-unavailable", 503);
      return folder;
    }
    if (method === "PUT") {
      const value: Item = item ?? {
        id: `file-${++sequence}`, name: name!, file: {}, parentReference: { id: id!, driveId: "drive-1" }, history: [],
      };
      if (value.bytes) value.history!.push(value.bytes);
      value.bytes = Buffer.from(JSON.stringify(body));
      items.set(value.id, value);
      return faults.malformedUpload ? { ...value, id: "approved" } : value;
    }
    if (path.includes("/versions")) return {
      value: faults.noVersions ? [] : Array.from({ length: (item?.history?.length ?? 0) + 1 },
        (_, index) => ({ id: `${(item?.history?.length ?? 0) + 1 - index}.0` })),
    };
    if (method === "DELETE") {
      if (faults.cleanupFailure) throw new IntegrationError("permission-failure", 403);
      if (item) {
        items.delete(item.id);
        for (const child of [...items.values()]) if (child.parentReference.id === item.id) items.delete(child.id);
      }
      return undefined;
    }
    if (path.includes("/children")) {
      if (faults.hostilePage) return { value: [], "@odata.nextLink": "https://attacker.invalid/v1.0/drives/drive-1/items/other/children" };
      return { value: [...items.values()].filter(item => item.parentReference.id === id) };
    }
    if (!item) throw new IntegrationError("read-failure", 404);
    return faults.wrongFolder && item.id === "approved" ? { ...item, name: "personal" } : item;
  };
  const graph = {
    authenticate: vi.fn(async () => {}),
    json: vi.fn(async <T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, method = "GET", body?: unknown) => schema.parse(await raw(path, signal, method, body))),
    request: vi.fn(async (path: string, signal: AbortSignal, method = "GET") => {
      await raw(path, signal, method);
      return new Response(null, { status: 204 });
    }),
    downloadContent: vi.fn(async (path: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      paths.push({ path, method: "DOWNLOAD" });
      const { item } = locate(path);
      const version = /\/versions\/(\d+)\.0\/content/.exec(path);
      const bytes = version ? item?.history?.[Number(version[1]) - 1] : item?.bytes;
      if (!bytes) throw new IntegrationError("read-failure", 404);
      return faults.badHash ? Buffer.from('{"wrong":true}') : bytes;
    }),
  } as unknown as GraphClient;
  let clock = 1_700_000_000_000;
  const context: ProbeContext = {
    graph, signal: new AbortController().signal, telemetry: { emit: vi.fn() },
    config: { SYNTHETIC_SCENARIO: "healthy", PROBE_TIMEOUT_MS: 100, POLL_INTERVAL_MS: 10 },
    now: () => clock++, sleep: async ms => { clock += ms; },
  };
  const run = async (selected = probe()) => resultSchema.parse(await oneDriveProbe(selected, context));
  return { items, paths, faults, graph, context, run };
}

describe("OneDrive completed API-backed journeys", () => {
  it("creates an owned nested folder/file, enumerates, verifies exact hash and confirms deliberate deletion", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.success).toBe(true);
    expect(result.steps.filter(step => !["authenticate", "cleanup"].includes(step.name)).map(step => [step.name, step.status])).toEqual([
      ["create-folder-file", "succeeded"], ["reopen-file", "succeeded"], ["verify-file-hash", "succeeded"], ["delete-owned-artifacts", "succeeded"],
    ]);
    expect([...f.items.keys()]).toEqual(["approved", "approot"]);
    expect(f.paths.some(call => call.path.includes("/children") && call.method === "GET")).toBe(true);
    expect(f.paths.some(call => /\/users|\/root|\/sites|\/search/.test(call.path))).toBe(false);
    expect(f.paths.filter(call => call.method === "DELETE")).toHaveLength(1);
    expect(result.steps.at(-1)).toMatchObject({ name: "cleanup", status: "skipped", reason: "no-mutation" });
  });
  it("uses user-addressed approot without a drive ID, verifies updates and deletes all per-cycle owned data", async () => {
    const f = fixture();
    const selected = probe("onedrive-appfolder");
    delete selected.driveId;
    delete selected.folderId;
    expect((await f.run(selected)).success).toBe(true);
    expect([...f.items.keys()]).toEqual(["approved", "approot"]);
    const firstCreation = f.paths.find(call => call.method === "POST")!.body as { name: string };
    expect(firstCreation.name).toMatch(/^ahm-synthetic-/);
    const firstUpdate = f.paths.filter(call => call.method === "PUT").at(-1)!.body;
    expect(firstUpdate).toMatchObject({ userId, targetId: "user-1", revision: 2 });
    const before = f.paths.length;
    expect((await f.run(selected)).success).toBe(true);
    const nextCreation = f.paths.slice(before).find(call => call.method === "POST")!.body as { name: string };
    expect(nextCreation.name).not.toBe(firstCreation.name);
    expect([...f.items.keys()]).toEqual(["approved", "approot"]);
    expect(f.items.has("approot")).toBe(true);
    expect(f.paths.filter(call => call.method === "DELETE").every(call => call.path.includes("/items/folder-"))).toBe(true);
    expect(f.paths.filter(call => call.method === "DELETE")).toHaveLength(2);
    expect(f.paths.filter(call => call.path.includes("/users/")).every(call =>
      call.path === `/users/${userId}/drive/special/approot`)).toBe(true);
  });
  it.each([false, true])("retrieves actual prior version bytes with optional downloaded-byte restore=%s", async restoreVersion => {
    const f = fixture();
    const result = await f.run({ ...probe("onedrive-versions"), restoreVersion });
    expect(result.success).toBe(true);
    expect(result.steps.find(step => step.name === "read-prior-version")?.status).toBe("succeeded");
    expect(result.steps.filter(step => !["authenticate", "cleanup", "restore-version"].includes(step.name))
      .every(step => step.status === "succeeded")).toBe(true);
    expect(result.steps.find(step => step.name === "restore-version")).toMatchObject(restoreVersion
      ? { status: "succeeded" } : { status: "skipped", reason: "variant-disabled" });
    expect(f.paths.filter(call => call.method === "PUT")).toHaveLength(restoreVersion ? 3 : 2);
    expect([...f.items.keys()]).toEqual(["approved", "approot"]);
    expect(f.paths.filter(call => call.method === "DOWNLOAD" && call.path.includes("/versions/"))
      .every(call => call.path.endsWith("/versions/1.0/content"))).toBe(true);
  });
  it("records real authentication failure without inventing executed file actions", async () => {
    const f = fixture();
    vi.spyOn(f.graph, "authenticate").mockRejectedValue(new IntegrationError("authentication-failure"));
    const result = await f.run();
    expect(result).toMatchObject({ success: false, diagnosticCategory: "authentication-failure" });
    expect(result.steps.filter(step => !["authenticate", "cleanup"].includes(step.name))
      .every(step => step.status === "skipped")).toBe(true);
    expect(f.paths).toEqual([]);
  });
  it("rejects an app-folder drive that conflicts with the configured drive binding before writing anything", async () => {
    const f = fixture();
    const result = await f.run({ ...probe("onedrive-appfolder"), driveId: "other-drive" });
    expect(result).toMatchObject({ success: false, diagnosticCategory: "configuration-failure" });
    expect(f.paths.filter(call => call.method !== "GET")).toEqual([]);
  });
  it.each(["onedrive-roundtrip", "onedrive-versions"] as const)("reports missing selected IDs as unhealthy %s evidence, not simulation", async type => {
    const f = fixture();
    const selected = probe(type);
    delete selected.driveId;
    delete selected.folderId;
    const result = await f.run(selected);
    expect(result).toMatchObject({ success: false, diagnosticCategory: "configuration-failure" });
    expect(f.graph.authenticate).toHaveBeenCalledOnce();
    expect(f.paths).toEqual([]);
    expect(result.steps.filter(step => !["authenticate", "cleanup"].includes(step.name))
      .every(step => step.status === "skipped" && step.reason === "prerequisite-failed")).toBe(true);
  });
  it.each(["permission", "appUnavailable", "wrongFolder", "badHash", "malformedUpload", "hostilePage", "cleanupFailure"] as const)(
    "does not fabricate success on %s", async fault => {
      const f = fixture();
      f.faults[fault] = true;
      const result = await f.run(probe(fault === "appUnavailable" ? "onedrive-appfolder" : "onedrive-roundtrip"));
      expect(result.success).toBe(false);
      expect(result.diagnosticCategory).not.toBeNull();
      expect(f.items.has("approved")).toBe(true);
      expect(f.items.has("approot")).toBe(true);
      expect(f.paths.filter(call => call.method === "DELETE").some(call =>
        /\/items\/(?:approved|approot)$/.test(call.path))).toBe(false);
    },
  );
  it("fails unavailable version history within the polling budget and safely cleans up", async () => {
    const f = fixture();
    f.faults.noVersions = true;
    const result = await f.run(probe("onedrive-versions"));
    expect(result).toMatchObject({ success: false, diagnosticCategory: "delivery-timeout" });
    expect(result.steps.find(step => step.name === "read-prior-version")).toMatchObject({ status: "failed" });
    expect([...f.items.keys()]).toEqual(["approved", "approot"]);
  });
  it("does not read, overwrite or delete existing app-folder data, including legacy test state", async () => {
    const f = fixture();
    f.items.set("legacy", {
      id: "legacy", name: "AHM-Synthetic-Tests-user-1", folder: {}, parentReference: { id: "approot", driveId: "drive-1" },
    });
    f.items.set("legacy-state", {
      id: "legacy-state", name: "state.json", file: {}, parentReference: { id: "legacy", driveId: "drive-1" },
      bytes: Buffer.from('{"owner":"someone-else"}'),
    });
    expect((await f.run(probe("onedrive-appfolder"))).success).toBe(true);
    expect(f.items.get("legacy-state")?.bytes?.toString()).toBe('{"owner":"someone-else"}');
    expect(f.paths.some(call => /\/items\/legacy/.test(call.path))).toBe(false);
  });
  it("cleans an ambiguous app-folder creation through only its exact per-cycle owned path", async () => {
    const f = fixture();
    f.faults.ambiguousCreate = true;
    const result = await f.run(probe("onedrive-appfolder"));
    expect(result).toMatchObject({ success: false, diagnosticCategory: "graph-unavailable" });
    expect(result.steps.find(step => step.name === "cleanup")).toMatchObject({ status: "succeeded" });
    expect([...f.items.keys()]).toEqual(["approved", "approot"]);
  });
  it("cleans all per-cycle app data if verifying the updated bytes fails", async () => {
    const f = fixture();
    const download = vi.mocked(f.graph.downloadContent).getMockImplementation()!;
    vi.spyOn(f.graph, "downloadContent").mockImplementationOnce(download).mockResolvedValueOnce(Buffer.from("incorrect-bytes"));
    const result = await f.run(probe("onedrive-appfolder"));
    expect(result).toMatchObject({ success: false, diagnosticCategory: "read-failure" });
    expect(result.steps.find(step => step.name === "update-app-data")).toMatchObject({ status: "failed" });
    expect(result.steps.find(step => step.name === "cleanup")).toMatchObject({ status: "succeeded" });
    expect([...f.items.keys()]).toEqual(["approved", "approot"]);
  });
  it("cancellation remains failure while cleanup uses its independent signal", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.context.signal = controller.signal;
    vi.spyOn(f.graph, "downloadContent").mockImplementation(async (_path, signal) => {
      controller.abort();
      signal.throwIfAborted();
      return Buffer.alloc(0);
    });
    const result = await f.run();
    expect(result.success).toBe(false);
    expect(result.diagnosticCategory).toBe("cancelled");
    expect(result.steps.find(step => step.name === "cleanup")).toMatchObject({ status: "succeeded" });
    expect([...f.items.keys()]).toEqual(["approved", "approot"]);
  });
});

describe("OneDrive Graph content transport", () => {
  it("downloads exact bytes from the allowed HTTPS redirect without forwarding Graph credentials", async () => {
    const download = vi.fn<typeof fetch>(async () => new Response('{"probe":true}'));
    const graphFetch = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302, headers: { location: "https://tenant-my.sharepoint.com/download?key=opaque" },
    }));
    const graph = new GraphClient({
      getToken: async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 60000 }),
    }, { fetch: graphFetch, downloadFetch: download });
    const bytes = await graph.downloadContent("/drives/d/items/f/versions/1.0/content", new AbortController().signal);
    expect(bytes.toString()).toBe('{"probe":true}');
    expect(download.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });
});
