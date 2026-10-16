import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStateStore, MemoryStateStore } from "../src/state.js";
import type { History } from "../src/policy.js";

const history: History = {
  "exchange-global": { state: "Degraded", failures: 1, recoveries: 0, expiresAt: "2026-10-16T20:15:00.000Z" },
};
describe("persistent anti-flapping history", () => {
  it("survives a fresh local runner instance and surfaces corrupt state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "m365-synthetic-state-"));
    const file = join(directory, "history.json");
    try {
      expect(await new FileStateStore(file).load()).toEqual({});
      await new FileStateStore(file).save(history);
      expect(await new FileStateStore(file).load()).toEqual(history);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(history);
      await writeFile(file, '{"corrupt":true}');
      await expect(new FileStateStore(file).load()).rejects.toThrow();
    } finally {
      await unlink(file);
      await rmdir(directory);
    }
  });
  it("does not leak mutable history across demo runs", async () => {
    const state = new MemoryStateStore();
    await state.save(history);
    const copy = await state.load();
    copy["exchange-global"]!.failures = 99;
    expect((await state.load())["exchange-global"]?.failures).toBe(1);
  });
});
