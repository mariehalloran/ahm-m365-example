import { parseArgs } from "node:util";
import { ConfigurationError } from "../../utils/src/configuration/config.js";
import { categoryOf } from "../../utils/src/integrations/http.js";
import { setupSharePointIds } from "./setup.js";

/** Runs the SharePoint-only, managed-identity discovery branch of the existing setup-ID command. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { config: { type: "string" }, tenant: { type: "string" } },
    strict: true, allowPositionals: false,
  });
  await setupSharePointIds({
    ...(values.config ? { file: values.config } : {}),
    ...(values.tenant ? { tenant: values.tenant } : {}),
  });
}

await main().catch(error => {
  console.error(JSON.stringify({
    event: "sharepoint-setup-failed", category: categoryOf(error),
    ...(error instanceof ConfigurationError ? { message: error.message } : {}),
  }));
  process.exitCode = 1;
});
