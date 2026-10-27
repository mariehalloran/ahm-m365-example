import { readFile, writeFile } from "node:fs/promises";
import { modelCatalog } from "./catalog.js";

const file = new URL("./catalog.json", import.meta.url);
const expected = `${JSON.stringify(modelCatalog, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const actual = await readFile(file, "utf8");
  if (actual !== expected) {
    throw new Error("Shared catalogue projection is stale; run npm run catalog:generate in synthetic-tests.");
  }
} else {
  await writeFile(file, expected);
}
