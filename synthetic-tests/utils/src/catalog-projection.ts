import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { modelCatalog } from "./catalog.js";

const catalogFile = new URL("./catalog.json", import.meta.url);

/** Writes or verifies the `catalog.json` projection consumed by Bicep templates and deployment tooling. */
export async function syncCatalogProjection(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      check: { type: "boolean", default: false },
    },
    strict: true,
  });

  const expected = `${JSON.stringify(modelCatalog, null, 2)}\n`;
  if (values.check) {
    const actual = await readFile(catalogFile, "utf8");
    if (actual !== expected) {
      throw new Error("Shared catalogue projection is stale; run npm run catalog:generate in synthetic-tests.");
    }
    return;
  }

  await writeFile(catalogFile, expected);
}

await syncCatalogProjection();
