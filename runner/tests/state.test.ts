import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlobStateStore, FileStateStore } from "../src/state.js";
import { MemoryStateStore } from "./memory-state.js";
import type { History } from "../../health-model/src/policy.js";

const blobs = vi.hoisted(() => ({
  getBlockBlobClient: vi.fn(),
  createIfNotExists: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: vi.fn(function () {
    return { getContainerClient: () => ({
      createIfNotExists: blobs.createIfNotExists,
      getBlockBlobClient: (name: string) => {
        blobs.getBlockBlobClient(name);
        return { download: blobs.download, upload: blobs.upload };
      },
    }) };
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  blobs.upload.mockResolvedValue({ etag: "new-etag" });
});

const history: History = {
  "exchange-global": { state: "Degraded", failures: 1, recoveries: 0, expiresAt: "2026-10-16T20:15:00.000Z" },
};
describe("persistent anti-flapping history", () => {
  it("survives a fresh local runner instance and surfaces corrupt state", async () => {
    const file = resolve(".azure", `test-state-${randomUUID()}.json`);
    try {
      expect(await new FileStateStore(file).load()).toEqual({});
      await new FileStateStore(file).save(history);
      expect(await new FileStateStore(file).load()).toEqual(history);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(history);
      await writeFile(file, '{"corrupt":true}');
      await expect(new FileStateStore(file).load()).rejects.toThrow();
    } finally {
      await unlink(file);
    }
  });

  describe("per-worker blob history with legacy defaults", () => {
    const credential = { getToken: async () => ({ token: "not-used", expiresOnTimestamp: 0 }) };
    const url = "https://state.blob.core.windows.net";
    it("preserves the legacy blob name and accepts an isolated worker blob name", () => {
      new BlobStateStore(url, credential);
      new BlobStateStore(url, credential, "probes/exchange/simulation-123/aggregation.json");
      expect(blobs.getBlockBlobClient.mock.calls).toEqual([["aggregation.json"], ["probes/exchange/simulation-123/aggregation.json"]]);
    });
    it.each(["../aggregation.json", "/aggregation.json", "probes/../aggregation.json", "probes//aggregation.json", "probes/%2e%2e/aggregation.json", "probes\\aggregation.json", "not-json"])(
      "rejects unsafe blob paths without constructing a client", name => {
        expect(() => new BlobStateStore(url, credential, name)).toThrow("Invalid state blob name");
        expect(blobs.getBlockBlobClient).not.toHaveBeenCalled();
      },
    );
    it("preserves ETag conditional writes and surfaces collisions rather than pretending to lease ownership", async () => {
      blobs.download.mockResolvedValue({ etag: "loaded-etag", readableStreamBody: [Buffer.from(JSON.stringify(history))] });
      const state = new BlobStateStore(url, credential, "probes/exchange/live-123/aggregation.json");
      expect(await state.load()).toEqual(history);
      await state.save(history);
      expect(blobs.upload).toHaveBeenLastCalledWith(expect.any(String), expect.any(Number), expect.objectContaining({ conditions: { ifMatch: "loaded-etag" } }));
      blobs.upload.mockRejectedValueOnce(Object.assign(new Error("ETag conflict"), { statusCode: 412 }));
      await expect(state.save(history)).rejects.toThrow("ETag conflict");
      expect(blobs.upload).toHaveBeenLastCalledWith(expect.any(String), expect.any(Number), expect.objectContaining({ conditions: { ifMatch: "new-etag" } }));
    });
    it("uses create-only conditions for a worker with no previous state", async () => {
      blobs.download.mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
      const state = new BlobStateStore(url, credential, "probes/sharepoint/simulation-123/aggregation.json");
      expect(await state.load()).toEqual({});
      await state.save(history);
      expect(blobs.upload).toHaveBeenLastCalledWith(expect.any(String), expect.any(Number), expect.objectContaining({ conditions: { ifNoneMatch: "*" } }));
    });
  });
  it("does not leak mutable history across demo runs", async () => {
    const state = new MemoryStateStore();
    await state.save(history);
    const copy = await state.load();
    copy["exchange-global"]!.failures = 99;
    expect((await state.load())["exchange-global"]?.failures).toBe(1);
  });
});
