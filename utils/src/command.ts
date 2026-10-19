import { z } from "zod";
import { ConfigurationError } from "./config.js";
import { categoryOf } from "./http.js";
import type { ProbeHandler } from "./probes.js";
import type { ServiceConfig } from "./service-config.js";
import { readServiceConfig } from "./service-config.js";
import { parseWorkerArguments, runServiceWorker } from "./worker.js";

async function main(type: ServiceConfig["type"], handler: ProbeHandler, argv: readonly string[]) {
  const args = parseWorkerArguments(argv, `${type}/config.json`);
  const service = await readServiceConfig(args.config);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runServiceWorker(service, { once: args.once, signal: controller.signal, expectedService: type, handler });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function runServiceCommand(type: ServiceConfig["type"], handler: ProbeHandler, argv = process.argv.slice(2)) {
  await main(type, handler, argv).catch(error => {
    console.error(JSON.stringify({
      event: "command-failed", category: categoryOf(error), errorType: error instanceof Error ? error.name : "unknown",
      ...(error instanceof ConfigurationError ? { message: error.message } : {}),
      ...(error instanceof z.ZodError ? { invalidFields: error.issues.map(issue => issue.path.join(".")) } : {}),
    }));
    process.exitCode = 1;
  });
}
