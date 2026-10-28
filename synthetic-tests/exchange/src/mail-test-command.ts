import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createLiveGraphClient } from "../../utils/src/auth.js";
import { bindingKey, bindingsFile, saveBindings } from "../../utils/src/bindings.js";
import { ConfigurationError } from "../../utils/src/config.js";
import { exchangeJourneyMilliseconds, type Telemetry } from "../../utils/src/contracts.js";
import { executionLanes } from "../../utils/src/execution-lanes.js";
import { categoryOf, IntegrationError } from "../../utils/src/http.js";
import { readProjectDocument, selectTenant, serviceExecution, type ProjectConfig } from "../../utils/src/project-config.js";
import { createResultOutput } from "../../utils/src/results.js";
import { runCycle } from "../../utils/src/runner.js";
import { serviceEnvironment, validateProjectTenantBinding, validateRuntimeConsent } from "../../utils/src/runtime.js";
import { canonicalProjectFile } from "../../utils/src/paths.js";
import { serviceSettings } from "../../utils/src/service-config.js";
import { exchangeAttachmentProbe, exchangeReplyProbe } from "./extended-journeys.js";
import { provisionReplySeed, type ReplySeedGraph, type ReplySeedOptions } from "./reply-seed.js";

/** Provisions each selected target's retained reply fixture and saves its binding to the `.env` next to the config. */
export async function provisionReplySeeds(
  project: ProjectConfig, source: string, graph: ReplySeedGraph, options: ReplySeedOptions & { reprovision?: boolean },
): Promise<Set<string>> {
  const unavailable = new Set<string>();
  for (const target of project.services.exchange.targets) {
    options.signal.throwIfAborted();
    try {
      const replySeed = await provisionReplySeed(graph, target, {
        ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(120000)]),
      });
      target.replySeed = replySeed;
      await saveBindings(source, {
        [bindingKey(project.tenant.id, target.id, "REPLY_SEED_MESSAGE_ID")]: replySeed.messageId,
        [bindingKey(project.tenant.id, target.id, "REPLY_SEED_CORRELATION_ID")]: replySeed.correlationId,
      });
    } catch (error) {
      unavailable.add(target.id);
      options.telemetry.emit("exchange-reply-seed-setup-failed", {
        targetId: target.id, category: categoryOf(error),
        ...(error instanceof IntegrationError && error.detail ? { detail: error.detail } : {}),
        ...(error instanceof IntegrationError && error.status !== undefined ? { httpStatus: error.status } : {}),
      });
    }
  }
  return unavailable;
}

export async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" }, tenant: { type: "string" },
      apply: { type: "boolean", default: false }, samples: { type: "string", default: "3" },
      "setup-only": { type: "boolean", default: false },
      "reprovision-seeds": { type: "boolean", default: false },
    },
  });
  const samples = z.coerce.number().int().min(1).max(10).parse(values.samples);
  const source = resolve(values.config ?? canonicalProjectFile);
  const project = selectTenant(await readProjectDocument(source), values.tenant);
  const service = serviceExecution(project, "exchange");
  if (!values.apply) {
    console.log(JSON.stringify({ event: "exchange-reply-seed-setup-plan", targetCount: service.targets.length, cloudChanges: false }));
    return;
  }
  if (!service.enabled || service.mode !== "live") throw new ConfigurationError("Mail diagnostics require an enabled live Exchange service");
  const env = serviceEnvironment(project, service, process.env, source);
  validateProjectTenantBinding(project.tenant, service, env);
  validateRuntimeConsent(service, env);
  const selected = project.services.exchange;
  if (!selected.scenarios["attachment-mail"] && !selected.scenarios["reply-mail"]) {
    throw new ConfigurationError("Select attachment-mail or reply-mail in the root configuration");
  }
  const graph = createLiveGraphClient(env, service.graphAuthentication);
  const telemetry: Telemetry = { emit: (event, data) => console.log(JSON.stringify({ event, ...data })) };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let failed = false;
  let unavailable = new Set<string>();
  try {
    if (selected.scenarios["reply-mail"]) {
      unavailable = await provisionReplySeeds(project, source, graph, {
        signal: controller.signal, telemetry, reprovision: values["reprovision-seeds"],
      });
      failed = unavailable.size > 0;
      telemetry.emit("exchange-reply-seed-bindings-saved", { bindingsFile: bindingsFile(source), failedTargets: unavailable.size });
    }

    if (!values["setup-only"]) {
      const config = serviceSettings(service, env, selected.scenarios);
      const lanes = executionLanes(service);
      const handlers = { "exchange-attachment": exchangeAttachmentProbe, "exchange-reply": exchangeReplyProbe };
      const results = createResultOutput(telemetry);
      for (let sample = 1; sample <= samples; sample++) {
        for (const type of ["exchange-attachment", "exchange-reply"] as const) {
          const handler = handlers[type];
          const journey = type === "exchange-attachment" ? "attachment-mail" : "reply-mail";
          if (!selected.scenarios[journey]) continue;
          // The deadline the worker applies: the journey's lane timeout, never above the journey's own cap.
          const deadlineMs = Math.min(
            lanes.find(lane => lane.journeys.includes(journey))!.timeoutSeconds * 1000, exchangeJourneyMilliseconds(type),
          );
          for (const target of selected.targets) {
            controller.signal.throwIfAborted();
            if (type === "exchange-reply" && unavailable.has(target.id)) {
              telemetry.emit("exchange-mail-test-skipped", { targetId: target.id, journey, sample, reason: "seed-setup-failed" });
              continue;
            }
            const cycle = await runCycle({ ...config, PROBE_TIMEOUT_MS: deadlineMs, probes: [{ ...target, cohort: service.cohort, type }] }, {
              graph, handler, telemetry, results,
            }, controller.signal);
            const result = cycle.results[0]!;
            if (!result.success) failed = true;
            telemetry.emit("exchange-mail-test-measured", {
              targetId: target.id, journey, sample, success: result.success, durationMs: result.durationMs,
              deadlineMs, category: result.diagnosticCategory,
              healthReportsPublished: false,
            });
          }
        }
      }
    }
    if (failed) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({
      event: "exchange-mail-test-failed", category: categoryOf(error),
      errorType: error instanceof Error ? error.name : "unknown",
      ...(error instanceof ConfigurationError ? { message: error.message } : {}),
      ...(error instanceof z.ZodError ? { invalidFields: error.issues.map(issue => issue.path.join(".")) } : {}),
    }));
    process.exitCode = 1;
  });
}
