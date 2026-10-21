import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationError } from "./config.js";
import { applyProjectConfig, readProjectConfig, type ProjectConfig } from "./project-config.js";
import { readServiceConfig, type ServiceConfig } from "./service-config.js";

async function readDeploymentService(project: ProjectConfig, type: ServiceConfig["type"], projectFile: string) {
  const service = await readServiceConfig(resolve(dirname(projectFile), project.services[type].configFile));
  if (service.type !== type) throw new ConfigurationError(`Deployment requires a ${type} service config`);
  applyProjectConfig(project, service);
  return service;
}

export async function prepareDeploymentParameters(projectFile: string, workerImage?: string, enableLiveProbes = false) {
  const project = await readProjectConfig(projectFile);
  if (project.healthModel.subscriptionId === "00000000-0000-0000-0000-000000000000") {
    throw new ConfigurationError("Deployment requires an approved healthModel.subscriptionId");
  }
  if (workerImage !== undefined && workerImage.trim().length === 0) {
    throw new ConfigurationError("workerImage must be a nonempty image reference");
  }
  const [exchange, teams, sharepoint] = await Promise.all([
    readDeploymentService(project, "exchange", projectFile),
    readDeploymentService(project, "teams", projectFile),
    readDeploymentService(project, "sharepoint", projectFile),
  ]);
  if (workerImage && !enableLiveProbes && [exchange, teams, sharepoint].some(service =>
    applyProjectConfig(project, service).enabled && service.mode === "live")) {
    throw new ConfigurationError("Deploying live worker profiles requires explicit --enable-live");
  }
  return {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    contentVersion: "1.0.0.0",
    parameters: {
      projectConfig: { value: project },
      serviceConfigs: { value: { exchange, teams, sharepoint } },
      deployWorkers: { value: workerImage !== undefined },
      workerImage: { value: workerImage ?? "" },
      enableLiveProbes: { value: enableLiveProbes },
    },
  };
}

async function main(args: string[]): Promise<void> {
  const [projectFile, outputFile, workerImage, liveFlag] = args;
  if (!projectFile || !outputFile || args.length > 4 || (liveFlag !== undefined && liveFlag !== "--enable-live")) {
    throw new ConfigurationError("Usage: npm run deployment:prepare -- <project-config> <output-parameters.json> [worker-image] [--enable-live]");
  }
  if (resolve(projectFile) === resolve(outputFile)) {
    throw new ConfigurationError("Deployment output must not overwrite the project config");
  }
  const parameters = await prepareDeploymentParameters(resolve(projectFile), workerImage, liveFlag === "--enable-live");
  await writeFile(outputFile, `${JSON.stringify(parameters, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ event: "deployment-parameters-prepared", deployWorkers: workerImage !== undefined }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({
      event: "deployment-parameters-failed", errorType: error instanceof Error ? error.name : "unknown",
      ...(error instanceof ConfigurationError ? { message: error.message } : {}),
    }));
    process.exitCode = 1;
  });
}
