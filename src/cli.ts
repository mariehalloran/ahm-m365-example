import { z } from "zod";
import { RecordingSink } from "./ahm.js";
import { ConfigurationError, loadConfig } from "./config.js";
import { consoleTelemetry, healthStates } from "./contracts.js";
import { categoryOf } from "./http.js";
import { runCycle } from "./runner.js";
import { runtime } from "./runtime.js";
import { MemoryStateStore } from "./state.js";

async function main() {
  const command = process.argv[2];
  if (command === "demo") {
    const config = loadConfig({ ...process.env, EXECUTION_MODE: "simulation" });
    const sink = new RecordingSink();
    const state = new MemoryStateStore();
    const emitDetails = process.env.DEMO_VERBOSE === "true";
    const telemetry = emitDetails ? consoleTelemetry : { emit: () => undefined };
    const cycles = Math.max(config.CONSECUTIVE_FAILURES, config.CONSECUTIVE_RECOVERIES);
    let last;
    for (let index = 0; index < cycles; index++) last = await runCycle(config, { sink, state, telemetry });
    console.log(JSON.stringify({
      mode: "offline-demo", writesToAzure: false, cycles,
      reports: last?.reports.map(report => ({ entity: report.entity, state: report.state, context: report.context })),
    }, null, 2));
    return;
  }
  if (command !== "cycle" && command !== "report") {
    throw new ConfigurationError("Usage: npm run demo | npm run cycle | npm run report -- <Healthy|Degraded|Unhealthy|Unknown> [entity] [signal]");
  }
  const config = loadConfig();
  const dependencies = runtime(config, consoleTelemetry);
  if (command === "cycle") { await runCycle(config, dependencies); return; }
  if (command === "report") {
    const state = z.enum(healthStates).parse(process.argv[3]);
    const entity = z.string().regex(/^[a-zA-Z0-9-]{3,80}$/).parse(process.argv[4] ?? "exchange-global");
    const signal = z.string().regex(/^[a-zA-Z0-9-]{3,80}$/).parse(process.argv[5] ?? "synthetic-health");
    const now = Date.now();
    await dependencies.sink.submit({
      entity, signal, state, observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + config.REPORT_TTL_SECONDS * 1000).toISOString(),
      context: { cycleId: crypto.randomUUID(), source: "synthetic", reason: "manual-validation" },
    }, AbortSignal.timeout(30000));
    console.log(JSON.stringify({ event: "manual-report-submitted", entity, signal, state }));
    return;
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    event: "command-failed", category: categoryOf(error), errorType: error instanceof Error ? error.name : "unknown",
    ...(error instanceof ConfigurationError ? { message: error.message } : {}),
    ...(error instanceof z.ZodError ? { invalidFields: error.issues.map(issue => issue.path.join(".")) } : {}),
  }));
  process.exitCode = 1;
});
