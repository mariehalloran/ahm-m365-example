import { app } from "@azure/functions";
import * as df from "durable-functions";
import type { OrchestrationContext, OrchestrationHandler } from "durable-functions";
import { laneActivity } from "./lane-activity.js";
import { startLane } from "./starter.js";
import { callingCallback } from "./calling-callback.js";
import { monitoringWatchdog } from "./watchdog.js";

/** Keeps all nondeterministic work in one activity; orchestration replay never re-executes Graph operations. */
const laneOrchestrator: OrchestrationHandler = function* (context: OrchestrationContext) {
  yield context.df.callActivity("runLane", context.df.getInput());
  return null;
};
df.app.orchestration("laneOrchestrator", laneOrchestrator);
df.app.activity("runLane", { handler: laneActivity });
app.timer("monitoringWatchdog", { schedule: "%WATCHDOG_CRON%", runOnStartup: false, useMonitor: true, handler: monitoringWatchdog });

// Function keys are intentionally unused: platform Entra authentication and the JWT verifier protect this route.
app.http("startLane", {
  methods: ["POST"], route: "lanes/start", authLevel: "anonymous", extraInputs: [df.input.durableClient()],
  handler: (request, context) => startLane(request, context, df.getClient(context)),
});
app.http("teamsCallingCallback", {
  methods: ["POST"], route: "calls/{runId}/{attemptId}/{botClientId}", authLevel: "anonymous", handler: callingCallback,
});
app.http("about", {
  methods: ["GET"], route: "about", authLevel: "anonymous",
  /** Exposes no execution capability or target data; bot registration can reference this notice. */
  handler: () => ({
    status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    body: "Dedicated Microsoft 365 monitoring resources only. Bot-only API journeys use managed identities. Operators own retention and diagnostics.\n",
  }),
});
