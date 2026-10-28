import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const parent = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const nodeProjectDirectory = basename(parent) === "dist" ? dirname(parent) : parent;
export const repositoryDirectory = dirname(nodeProjectDirectory);
export const canonicalProjectFile = resolve(repositoryDirectory, "monitoring.config.json");
