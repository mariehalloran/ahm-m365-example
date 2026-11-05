import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { readProjectDocument } from "../../utils/src/configuration/project-config.js";
import { canonicalProjectFile, nodeProjectDirectory } from "../../utils/src/paths.js";
import { hash } from "../../utils/src/deployment/deploy-phases.js";
import { makePackageReadable, prepareFunctionPackage } from "../../utils/src/deployment/function-package.js";

/** Generates only local host packaging/settings; the repository-root configuration remains authoritative. */
async function main(): Promise<void> {
  const document = await readProjectDocument(canonicalProjectFile);
  const settings = document.deployment!;
  const localService = "exchange";
  const functionAppName = `${settings.functions.appName.slice(0, 57)}-ex`;
  const directory = join(nodeProjectDirectory, ".function-package/local");
  await prepareFunctionPackage(document, directory);
  await promisify(execFile)("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], {
    cwd: directory, timeout: settings.commandTimeoutSeconds * 1000, env: { ...process.env, TMPDIR: directory },
  });
  await writeFile(join(directory, "local.settings.json"), JSON.stringify({
    IsEncrypted: false,
    Values: {
      AzureWebJobsStorage: "UseDevelopmentStorage=true",
      FUNCTIONS_WORKER_RUNTIME: "node",
      AZURE_FUNCTIONS_ENVIRONMENT: "Development",
      MONITORING_CONFIG_FILE: canonicalProjectFile,
      MONITORING_CONFIG_SHA256: hash(`${JSON.stringify(document, null, 2)}\n`),
      FUNCTION_APP_NAME: functionAppName,
      MONITORING_SERVICE: localService,
      FUNCTION_API_CLIENT_ID: settings.functions.apiClientId ?? "",
      COORDINATOR_CLIENT_ID: settings.coordinator.identityClientId ?? "",
      AZURE_TENANT_ID: settings.azureTenantId,
      ENABLE_LIVE_M365: "false",
      ENABLE_BETA_SERVICE_ACTIVITY: "false",
      WATCHDOG_CRON: "0 */1 * * * *",
      "AzureWebJobs.monitoringWatchdog.Disabled": "true",
    },
  }), { mode: 0o600 });
  await makePackageReadable(directory);
  console.log(JSON.stringify({ event: "local-function-package-prepared", liveExecution: false }));
}

await main().catch(error => {
  console.error(JSON.stringify({ event: "local-function-package-failed", errorType: error instanceof Error ? error.name : "unknown" }));
  process.exitCode = 1;
});
