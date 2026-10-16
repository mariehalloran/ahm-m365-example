import { app, type InvocationContext, type Timer } from "@azure/functions";
import { ConfigurationError, loadConfig } from "../config.js";
import { runCycle } from "../runner.js";
import { runtime } from "../runtime.js";

app.timer("m365Synthetic", {
  schedule: "%SYNTHETIC_SCHEDULE%",
  useMonitor: true,
  runOnStartup: false,
  handler: async (timer: Timer, context: InvocationContext) => {
    const telemetry = { emit: (event: string, data: Record<string, unknown>) => context.log(JSON.stringify({ event, ...data })) };
    if (timer.isPastDue) telemetry.emit("timer-past-due", { invocationId: context.invocationId });
    let config;
    try { config = loadConfig(); }
    catch (error) {
      context.error(error instanceof ConfigurationError ? error.message : "Invalid synthetic configuration");
      throw new Error("Synthetic configuration invalid");
    }
    await runCycle(config, runtime(config, telemetry));
  },
});
