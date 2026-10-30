import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createLiveGraphClient } from "../../utils/src/integrations/auth.js";
import { bindingKey, bindingsFile, saveBindings } from "../../utils/src/configuration/bindings.js";
import { ConfigurationError, filterRuntimeProbes } from "../../utils/src/configuration/config.js";
import type { Telemetry } from "../../utils/src/contracts.js";
import { executionLanes } from "../../utils/src/execution/execution-lanes.js";
import { categoryOf, IntegrationError } from "../../utils/src/integrations/http.js";
import {
  readProjectDocument,
  selectTenant,
  serviceExecution,
  type ProjectConfig,
} from "../../utils/src/configuration/project-config.js";
import { createResultOutput, outcomeOf } from "../../utils/src/reporting/results.js";
import { resultContext } from "../../utils/src/configuration/groups.js";
import { runCycle } from "../../utils/src/execution/runner.js";
import {
  serviceEnvironment,
  validateProjectTenantBinding,
  validateRuntimeConsent,
} from "../../utils/src/execution/runtime.js";
import { canonicalProjectFile } from "../../utils/src/paths.js";
import { serviceSettings } from "../../utils/src/configuration/service-config.js";
import { dispatchProbeHandlers } from "../../utils/src/execution/probes.js";
import { exchangeAttachmentProbe, exchangeReplyProbe } from "./extended-journeys.js";
import { provisionReplySeed, type ReplySeedGraph, type ReplySeedOptions } from "./reply-seed.js";

/**
 * Builds the telemetry payload for a failed reply-seed provisioning attempt on a target mailbox.
 */
function buildReplySeedSetupFailureData(
  targetId: string,
  error: unknown,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    targetId,
    category: categoryOf(error),
  };
  if (error instanceof IntegrationError) {
    if (error.detail) {
      payload.detail = error.detail;
    }
    if (error.status !== undefined) {
      payload.httpStatus = error.status;
    }
  }
  return payload;
}

/**
 * Provisions each selected target's retained reply fixture and saves its binding
 * to the `.env` file next to the project configuration.
 */
export async function provisionReplySeeds(
  project: ProjectConfig,
  source: string,
  graph: ReplySeedGraph,
  options: ReplySeedOptions & { reprovision?: boolean },
): Promise<Set<string>> {
  const unavailable = new Set<string>();

  for (const target of project.services.exchange.targets) {
    options.signal.throwIfAborted();
    try {
      const targetSignal = AbortSignal.any([
        options.signal,
        AbortSignal.timeout(120000),
      ]);
      const replySeed = await provisionReplySeed(graph, target, {
        ...options,
        signal: targetSignal,
      });
      target.replySeed = replySeed;

      const messageIdKey = bindingKey(project.tenant.id, target.id, "REPLY_SEED_MESSAGE_ID");
      const correlationIdKey = bindingKey(project.tenant.id, target.id, "REPLY_SEED_CORRELATION_ID");
      await saveBindings(source, {
        [messageIdKey]: replySeed.messageId,
        [correlationIdKey]: replySeed.correlationId,
      });
    } catch (error) {
      unavailable.add(target.id);
      options.telemetry.emit(
        "exchange-reply-seed-setup-failed",
        buildReplySeedSetupFailureData(target.id, error),
      );
    }
  }

  return unavailable;
}

/**
 * Maps an extended mail probe type to its corresponding scenario key in the project configuration.
 */
function resolveMailScenarioName(
  probeType: "exchange-attachment" | "exchange-reply",
): "attachment-mail" | "reply-mail" {
  if (probeType === "exchange-attachment") {
    return "attachment-mail";
  }
  return "reply-mail";
}

/**
 * Builds the structured error log payload emitted when the CLI command exits with an unhandled error.
 */
function buildMailTestFailureLog(error: unknown): Record<string, unknown> {
  let errorType = "unknown";
  if (error instanceof Error) {
    errorType = error.name;
  }

  const payload: Record<string, unknown> = {
    event: "exchange-mail-test-failed",
    category: categoryOf(error),
    errorType,
  };

  if (error instanceof ConfigurationError) {
    payload.message = error.message;
  }
  if (error instanceof z.ZodError) {
    payload.invalidFields = error.issues.map((issue) => issue.path.join("."));
  }

  return payload;
}

/**
 * Parses CLI arguments, provisions Exchange self-reply seed fixtures when needed,
 * and optionally executes sample diagnostic runs for attachment and reply mail journeys.
 */
export async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      tenant: { type: "string" },
      apply: { type: "boolean", default: false },
      samples: { type: "string", default: "3" },
      "setup-only": { type: "boolean", default: false },
      "reprovision-seeds": { type: "boolean", default: false },
    },
  });

  const samples = z.coerce.number().int().min(1).max(10).parse(values.samples);
  const source = resolve(values.config ?? canonicalProjectFile);
  const project = selectTenant(await readProjectDocument(source), values.tenant);
  const service = serviceExecution(project, "exchange");

  if (!values.apply) {
    console.log(
      JSON.stringify({
        event: "exchange-reply-seed-setup-plan",
        targetCount: service.targets.length,
        cloudChanges: false,
      }),
    );
    return;
  }

  if (!service.enabled || service.mode !== "live") {
    throw new ConfigurationError("Mail diagnostics require an enabled live Exchange service");
  }

  const env = serviceEnvironment(project, service, process.env, source);
  validateProjectTenantBinding(project.tenant, service, env);
  validateRuntimeConsent(service, env);

  const selected = project.services.exchange;
  if (!selected.scenarios["attachment-mail"] && !selected.scenarios["reply-mail"]) {
    throw new ConfigurationError("Select attachment-mail or reply-mail in the root configuration");
  }

  const graph = createLiveGraphClient(env, service.graphAuthentication);

  /**
   * Emits a structured JSON telemetry event to standard output.
   */
  function emitTelemetry(event: string, data?: Record<string, unknown>): void {
    console.log(JSON.stringify({ event, ...data }));
  }

  const telemetry: Telemetry = { emit: emitTelemetry };
  const controller = new AbortController();

  /**
   * Aborts the active command execution when a process termination signal is received.
   */
  function stopExecution(): void {
    controller.abort();
  }

  process.once("SIGINT", stopExecution);
  process.once("SIGTERM", stopExecution);

  let failed = false;
  let unavailable = new Set<string>();

  try {
    if (selected.scenarios["reply-mail"]) {
      unavailable = await provisionReplySeeds(project, source, graph, {
        signal: controller.signal,
        telemetry,
        reprovision: values["reprovision-seeds"],
      });
      failed = unavailable.size > 0;
      telemetry.emit("exchange-reply-seed-bindings-saved", {
        bindingsFile: bindingsFile(source),
        failedTargets: unavailable.size,
      });
    }

    if (!values["setup-only"]) {
      const config = serviceSettings(service, env, selected.scenarios);
      const lanes = executionLanes(service);
      const handler = dispatchProbeHandlers({
        "exchange-attachment": exchangeAttachmentProbe,
        "exchange-reply": exchangeReplyProbe,
      });
      const results = createResultOutput(telemetry, result => resultContext(project, result));

      for (let sample = 1; sample <= samples; sample++) {
        for (const type of ["exchange-attachment", "exchange-reply"] as const) {
          const journey = resolveMailScenarioName(type);
          if (!selected.scenarios[journey]) {
            continue;
          }

          // Use the same complete-journey deadline as the service worker, not a per-step cap.
          const matchingLane = lanes.find((lane) => lane.journeys.includes(journey))!;
          const deadlineMs = matchingLane.timeoutSeconds * 1000;

          for (const target of selected.targets) {
            controller.signal.throwIfAborted();
            if (type === "exchange-reply" && unavailable.has(target.id)) {
              telemetry.emit("exchange-mail-test-skipped", {
                targetId: target.id,
                journey,
                sample,
                reason: "seed-setup-failed",
              });
              continue;
            }

            const selectedConfig = filterRuntimeProbes(
              config,
              (probe) => probe.type === type && probe.id === target.id,
            );
            const cycle = await runCycle(
              {
                ...selectedConfig,
                PROBE_TIMEOUT_MS: deadlineMs,
              },
              {
                graph,
                handler,
                telemetry,
                results,
              },
              controller.signal,
            );

            const result = cycle.results[0]!;
            const outcome = outcomeOf(result);
            if (outcome !== "success") {
              failed = true;
            }
            telemetry.emit("exchange-mail-test-measured", {
              targetId: target.id,
              journey,
              sample,
              outcome,
              success: outcome === "unknown" ? null : result.success,
              durationMs: result.durationMs,
              deadlineMs,
              category: result.diagnosticCategory,
              healthReportsPublished: false,
            });
          }
        }
      }
    }

    if (failed) {
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGINT", stopExecution);
    process.removeListener("SIGTERM", stopExecution);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify(buildMailTestFailureLog(error)));
    process.exitCode = 1;
  });
}
