import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ProjectDocument } from "../configuration/project-config.js";
import { nodeProjectDirectory } from "../paths.js";
import { dispatchInventory } from "../../../functions/src/dispatch.js";
import { ConfigurationError } from "../configuration/config.js";

/** Formats configured host execution capacity using the standard .NET TimeSpan representation. */
export function functionTimeout(document: ProjectDocument): string {
  const seconds = Math.max(...dispatchInventory(document, "0".repeat(64)).map(lane => lane.intervalSeconds));
  const days = Math.floor(seconds / 86400);
  const part = (value: number) => String(Math.floor(value)).padStart(2, "0");
  return `${days}.${part(seconds % 86400 / 3600)}:${part(seconds % 3600 / 60)}:${part(seconds % 60)}`;
}

/** Makes the generated deployment archive readable by the Linux Function worker without opening its staging parent. */
export async function makePackageReadable(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await makePackageReadable(path);
      await chmod(path, 0o755);
    } else if (entry.isFile()) {
      await chmod(path, (await stat(path)).mode & 0o111 ? 0o755 : 0o644);
    } else throw new ConfigurationError("The generated Function package contains an unsupported file type");
  }
}

/** Produces a self-contained Node v4 Function package from the existing project build and lockfile. */
export async function prepareFunctionPackage(document: ProjectDocument, directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = z.object({ name: z.string(), version: z.string(), dependencies: z.record(z.string()) })
    .parse(JSON.parse(await readFile(join(nodeProjectDirectory, "package.json"), "utf8")));
  await writeFile(join(directory, "package.json"), JSON.stringify({
    ...manifest, type: "module", private: true, main: "dist/functions/src/index.js", engines: { node: ">=22 <25" },
  }), { mode: 0o600 });
  await cp(join(nodeProjectDirectory, "package-lock.json"), join(directory, "package-lock.json"));
  for (const service of ["functions", "exchange", "teams", "onedrive", "sharepoint", "utils"]) {
    await cp(join(nodeProjectDirectory, "dist", service), join(directory, "dist", service), { recursive: true });
  }
  await rm(join(directory, "dist/utils/src/deployment"), { recursive: true, force: true });
  const host = JSON.parse(await readFile(join(nodeProjectDirectory, "functions/host.json"), "utf8"));
  host.functionTimeout = functionTimeout(document);
  await writeFile(join(directory, "host.json"), JSON.stringify(host), { mode: 0o600 });
}
