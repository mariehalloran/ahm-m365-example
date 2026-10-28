import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createLiveGraphClient } from "../../utils/src/auth.js";
import { ConfigurationError } from "../../utils/src/config.js";
import { maxExchangeJourneyMilliseconds, type Telemetry } from "../../utils/src/contracts.js";
import { categoryOf, IntegrationError } from "../../utils/src/http.js";
import {
  parseProjectDocument, rawTenantServices, selectTenant, serviceExecution, type ProjectConfig, type ProjectDocument,
} from "../../utils/src/project-config.js";
import { createResultOutput } from "../../utils/src/results.js";
import { runCycle } from "../../utils/src/runner.js";
import { serviceEnvironment, validateProjectTenantBinding, validateRuntimeConsent } from "../../utils/src/runtime.js";
import { canonicalProjectFile } from "../../utils/src/paths.js";
import { withProjectCheckpoint } from "../../utils/src/config-checkpoint.js";
import { serviceSettings } from "../../utils/src/service-config.js";
import { exchangeAttachmentProbe, exchangeReplyProbe } from "./extended-journeys.js";
import { provisionReplySeed } from "./reply-seed.js";

export function replySeedOutputDocument(
  raw: unknown, tenant: string, targets: ProjectConfig["services"]["exchange"]["targets"],
): ProjectDocument {
  const document = structuredClone(raw) as ProjectDocument;
  const bindings = rawTenantServices(document, tenant).exchange.targets;
  for (const target of targets) {
    const binding = bindings.find(binding => binding.id === target.id);
    if (!binding) throw new ConfigurationError("Reply setup target is no longer in the tenant inventory");
    if (target.replySeed) binding.replySeed = structuredClone(target.replySeed);
  }
  return document;
}

async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" }, tenant: { type: "string" },
      apply: { type: "boolean", default: false }, samples: { type: "string", default: "3" },
      "setup-only": { type: "boolean", default: false },
    },
  });
  const samples = z.coerce.number().int().min(1).max(10).parse(values.samples);
  const source = resolve(values.config ?? canonicalProjectFile);
  await withProjectCheckpoint(source, values.apply, async context => {
    const project = selectTenant(parseProjectDocument(context.document), values.tenant);
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
    const unavailable = new Set<string>();
    try {
      if (selected.scenarios["reply-mail"]) {
        for (const target of selected.targets) {
          controller.signal.throwIfAborted();
          try {
            target.replySeed = await provisionReplySeed(graph, target, {
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]), telemetry,
            });
            await context.checkpoint(raw => replySeedOutputDocument(raw, project.tenant.id, [target]));
          } catch (error) {
            failed = true;
            unavailable.add(target.id);
            telemetry.emit("exchange-reply-seed-setup-failed", {
              targetId: target.id, category: categoryOf(error),
              ...(error instanceof IntegrationError && error.status !== undefined ? { httpStatus: error.status } : {}),
            });
          }
        }
      }
      telemetry.emit("exchange-reply-seed-config-written", { configFile: source, failedTargets: unavailable.size });

      if (!values["setup-only"]) {
        const config = serviceSettings(service, env, selected.scenarios);
        const handlers = { "exchange-attachment": exchangeAttachmentProbe, "exchange-reply": exchangeReplyProbe };
        const results = createResultOutput(telemetry);
        for (let sample = 1; sample <= samples; sample++) {
          for (const type of ["exchange-attachment", "exchange-reply"] as const) {
            const handler = handlers[type];
            const journey = type === "exchange-attachment" ? "attachment-mail" : "reply-mail";
            if (!selected.scenarios[journey]) continue;
            for (const target of selected.targets) {
              controller.signal.throwIfAborted();
              if (type === "exchange-reply" && unavailable.has(target.id)) {
                telemetry.emit("exchange-mail-test-skipped", { targetId: target.id, journey, sample, reason: "seed-setup-failed" });
                continue;
              }
              const cycle = await runCycle({ ...config, probes: [{ ...target, cohort: service.cohort, type }] }, {
                graph, handler, telemetry, results,
              }, controller.signal);
              const result = cycle.results[0]!;
              if (!result.success) failed = true;
              telemetry.emit("exchange-mail-test-measured", {
                targetId: target.id, journey, sample, success: result.success, durationMs: result.durationMs,
                deadlineMs: Math.min(config.PROBE_TIMEOUT_MS, maxExchangeJourneyMilliseconds), category: result.diagnosticCategory,
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
  });
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
