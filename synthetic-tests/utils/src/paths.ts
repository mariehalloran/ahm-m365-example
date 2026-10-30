import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolves the `synthetic-tests` Node project directory whether running from TypeScript source or `dist/` output. */
function resolveNodeProjectDirectory(): string {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (basename(parent) === "dist") {
    return dirname(parent);
  }
  return parent;
}

export const nodeProjectDirectory = resolveNodeProjectDirectory();
export const repositoryDirectory = dirname(nodeProjectDirectory);
export const canonicalProjectFile = resolve(repositoryDirectory, "monitoring.config.json");
