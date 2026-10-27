import { randomUUID } from "node:crypto";
import { access, link, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createLiveGraphClient } from "../../utils/src/auth.js";
import { ConfigurationError } from "../../utils/src/config.js";
import { maxExchangeJourneyMilliseconds, type Telemetry } from "../../utils/src/contracts.js";
import { categoryOf, IntegrationError } from "../../utils/src/http.js";
import { readProjectService } from "../../utils/src/project-config.js";
import { createResultOutput } from "../../utils/src/results.js";
import { runCycle } from "../../utils/src/runner.js";
import { validateRuntimeConsent } from "../../utils/src/runtime.js";
import { serviceSettings } from "../../utils/src/service-config.js";
import { exchangeAttachmentProbe, exchangeReplyProbe } from "./extended-journeys.js";
import { provisionReplySeed } from "./reply-seed.js";

async function main() {
  const { values } = parseArgs({
    options: {
      "project-config": { type: "string" }, config: { type: "string" },
      "output-config": { type: "string" }, samples: { type: "string", default: "3" },
      "setup-only": { type: "boolean", default: false },
    },
  });
  if (!values["project-config"] || !values["output-config"]) {
    throw new ConfigurationError("Supply --project-config and a new --output-config path; the input configuration is never overwritten");
  }
  const samples = z.coerce.number().int().min(1).max(10).parse(values.samples);
  const source = resolve(values["project-config"]);
  const destination = resolve(values["output-config"]);
  if (source === destination) throw new ConfigurationError("--output-config must differ from the input configuration");
  try {
    await access(destination);
    throw new ConfigurationError("--output-config already exists; choose a new output file");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const original = await readFile(source, "utf8");
  const { project, service } = await readProjectService("exchange", source, values.config);
  if (!service.enabled || service.mode !== "live") throw new ConfigurationError("Mail diagnostics require an enabled live Exchange service");
  validateRuntimeConsent(service, process.env);
  const selected = project.services.exchange;
  if (!selected.scenarios["attachment-mail"] && !selected.scenarios["reply-mail"]) {
    throw new ConfigurationError("Select attachment-mail or reply-mail in the root configuration");
  }
  const graph = createLiveGraphClient(process.env, service.graphAuthentication);
  const telemetry: Telemetry = {
    emit: (event, data) => console.log(JSON.stringify({ event, ...data })),
  };
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
    if (await readFile(source, "utf8") !== original) throw new ConfigurationError("The input configuration changed during setup; no output configuration was published");
    for (const configured of Object.values(project.services)) {
      configured.configFile = resolve(dirname(source), configured.configFile);
    }
    const temporary = resolve(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try { await link(temporary, destination); }
    finally { await unlink(temporary); }
    telemetry.emit("exchange-reply-seed-config-written", { outputConfig: destination, failedTargets: unavailable.size });

    if (!values["setup-only"]) {
      const config = serviceSettings(service, process.env, selected.scenarios);
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
}

await main().catch(error => {
  console.error(JSON.stringify({
    event: "exchange-mail-test-failed", category: categoryOf(error),
    errorType: error instanceof Error ? error.name : "unknown",
    ...(error instanceof ConfigurationError ? { message: error.message } : {}),
    ...(error instanceof z.ZodError ? { invalidFields: error.issues.map(issue => issue.path.join(".")) } : {}),
  }));
  process.exitCode = 1;
});
