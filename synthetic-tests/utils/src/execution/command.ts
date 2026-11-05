import { z } from "zod";
import { ConfigurationError } from "../configuration/config.js";
import { categoryOf } from "../integrations/http.js";
import type { ProbeHandler } from "./probes.js";
import type { ServiceConfig } from "../configuration/service-config.js";
import type { ProviderCollector } from "../providers/provider-collection.js";
import { readProjectService } from "../configuration/project-config.js";
import { serviceEnvironment } from "./runtime.js";
import { executeProviderLane, executeServiceLane } from "./lane-execution.js";
import { executionLanes } from "./execution-lanes.js";
import { hasProviderSources } from "../configuration/service-config.js";
import { canonicalProjectFile } from "../paths.js";

/** Parses one explicit local diagnostic execution; hosted scheduling belongs only to the coordinator. */
function parseArguments(argv: readonly string[]) {
  let config = canonicalProjectFile;
  let tenant: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--once") continue;
    if ((argument === "--config" || argument === "--tenant") && argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      if (argument === "--config") config = argv[++index]!;
      else tenant = argv[++index]!;
    } else throw new ConfigurationError("Usage: npm run <service> -- --once [--config <root config>] [--tenant <alias>]");
  }
  return { config, tenant };
}

async function main(type: ServiceConfig["type"], handler: ProbeHandler, argv: readonly string[], providers?: ProviderCollector) {
  const args = parseArguments(argv);
  const { project, service } = await readProjectService(type, args.config, args.tenant);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (!service.enabled) throw new ConfigurationError("The selected diagnostic service is disabled");
    const options = {
      signal: controller.signal, handler, project,
      env: serviceEnvironment(project, service, process.env, args.config), ...(providers ? { providers } : {}),
    };
    const lanes = executionLanes(service).filter(lane =>
      lane.journeys.some(journey => (project.services[type].scenarios as Record<string, boolean>)[journey]));
    const outcomes = await Promise.allSettled([
      ...lanes.map(lane => executeServiceLane(service, lane, options)),
      ...(hasProviderSources(service) ? [executeProviderLane(service, options)] : []),
    ]);
    const failures = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Local diagnostic execution failed");
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function runServiceCommand(type: ServiceConfig["type"], handler: ProbeHandler, argv = process.argv.slice(2), providers?: ProviderCollector) {
  await main(type, handler, argv, providers).catch(error => {
    console.error(JSON.stringify({
      event: "command-failed", category: categoryOf(error), errorType: error instanceof Error ? error.name : "unknown",
      ...(error instanceof ConfigurationError ? { message: error.message } : {}),
      ...(error instanceof z.ZodError ? { invalidFields: error.issues.map(issue => issue.path.join(".")) } : {}),
    }));
    process.exitCode = 1;
  });
}
