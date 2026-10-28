import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { ConfigurationError } from "./config.js";
import { parseProjectDocument } from "./project-config.js";

export async function withProjectCheckpoint<T>(
  path: string, apply: boolean,
  run: (context: { file: string; document: unknown; checkpoint: (update: (raw: unknown) => unknown) => Promise<void> }) => Promise<T>,
): Promise<T> {
  const file = await realpath(path);
  const lockPath = `${file}.monitoring-setup.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  if (apply) {
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new ConfigurationError("Another setup holds the monitoring-config lock; verify that it has stopped before removing a stale .monitoring-setup.lock file");
      }
      throw error;
    }
  }
  try {
    if (lock) await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    let expected = await readFile(file, "utf8");
    let document: unknown;
    try { document = JSON.parse(expected); }
    catch { throw new ConfigurationError("Monitoring config must contain valid JSON"); }
    parseProjectDocument(document);
    let writes = Promise.resolve();
    return await run({
      file, document,
      checkpoint(update) {
        if (!apply) throw new ConfigurationError("Setup checkpoint writes require --apply");
        writes = writes.then(async () => {
          if (await readFile(file, "utf8") !== expected) {
            throw new ConfigurationError("Monitoring config changed during setup; no external edits were overwritten");
          }
          const next = update(structuredClone(document));
          parseProjectDocument(next);
          const text = `${JSON.stringify(next, null, 2)}\n`;
          const temporary = `${file}.checkpoint-${randomUUID()}.tmp`;
          const handle = await open(temporary, "wx", 0o600);
          try {
            try { await handle.writeFile(text); await handle.sync(); }
            finally { await handle.close(); }
            if (await readFile(file, "utf8") !== expected) throw new ConfigurationError("Monitoring config changed during setup; no external edits were overwritten");
            await rename(temporary, file);
            expected = text;
            document = next;
          } finally {
            try { await unlink(temporary); }
            catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error; }
          }
        });
        return writes;
      },
    });
  } finally {
    if (lock) {
      try { await lock.close(); }
      finally { await unlink(lockPath); }
    }
  }
}
