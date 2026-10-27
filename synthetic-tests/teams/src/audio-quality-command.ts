import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ConfigurationError } from "../../utils/src/config.js";
import { consoleTelemetry } from "../../utils/src/contracts.js";
import { categoryOf } from "../../utils/src/http.js";
import { readProjectService } from "../../utils/src/project-config.js";
import { audioQualityCollectionDefaults } from "../../utils/src/teams-call-quality-collection.js";
import { runAudioFeasibility, type AudioFeasibilityOptions } from "./audio-quality.js";

const usage = `Usage: npm run teams:audio-quality -- --audio-url <approved-public-https.wav>
  --acknowledge-tenant-wide-call-records
  [--project-config <root.json>] [--config <live-teams.json>] [--target-id <root-call-target>]
  [--max-wait-minutes <1..180>] [--poll-interval-seconds <1..300>]
  [--playback-timeout-seconds <1..30>] [--publish]

One live pilot; requires ENABLE_LIVE_M365=true and both explicit bot managed identities.
Default readback: 150 minutes, 60-second polling, after both calls have left.
--publish sends only returned metrics selected by healthModel.callQualityThresholds.
The command must exclusively own the approved public callback route/port; stop the normal worker.
No permissions are granted, entities created, or received audio independently verified.`;

export function parseAudioQualityArguments(argv: readonly string[]) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv], strict: true, allowPositionals: false,
      options: {
        "audio-url": { type: "string" }, "acknowledge-tenant-wide-call-records": { type: "boolean" },
        "project-config": { type: "string" }, config: { type: "string" }, "target-id": { type: "string" },
        "max-wait-minutes": { type: "string" }, "poll-interval-seconds": { type: "string" },
        "playback-timeout-seconds": { type: "string" }, publish: { type: "boolean" }, help: { type: "boolean" },
      },
    }));
  } catch { throw new ConfigurationError(usage); }
  if (values.help) return { help: true as const };
  const integer = (value: string | undefined, fallback: number, maximum: number) => {
    if (value !== undefined && !/^\d+$/.test(value)) throw new ConfigurationError(usage);
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(number) || number < 1 || number > maximum) throw new ConfigurationError(usage);
    return number;
  };
  if (!values["audio-url"] || values["acknowledge-tenant-wide-call-records"] !== true ||
      [values.config, values["project-config"], values["target-id"]].some(value => value !== undefined && !value.trim())) {
    throw new ConfigurationError(usage);
  }
  const options: AudioFeasibilityOptions = {
    audioUrl: values["audio-url"], acknowledgeTenantWideCallRecords: true, publish: values.publish === true,
    maxWaitSeconds: integer(values["max-wait-minutes"], audioQualityCollectionDefaults.maxWaitSeconds / 60, 180) * 60,
    pollIntervalSeconds: integer(values["poll-interval-seconds"], audioQualityCollectionDefaults.pollIntervalSeconds, 300),
    playbackTimeoutMs: integer(values["playback-timeout-seconds"], 15, 30) * 1000,
    ...(values["target-id"] ? { targetId: values["target-id"] } : {}),
  };
  return {
    help: false as const, options, projectConfig: values["project-config"] ?? "../monitoring.config.json",
    ...(values.config ? { config: values.config } : {}),
  };
}

export async function runTeamsAudioQualityCommand(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const args = parseAudioQualityArguments(argv);
    if (args.help) { console.log(usage); return; }
    const { project, service } = await readProjectService("teams", args.projectConfig, args.config);
    consoleTelemetry.emit("teams-audio-feasibility-profile", {
      projectConfig: resolve(args.projectConfig), modelName: `${project.healthModel.name}-teams`,
    });
    const result = await runAudioFeasibility(project, service, args.options, {
      env, signal: controller.signal, telemetry: consoleTelemetry,
    });
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(JSON.stringify({
      event: "teams-audio-feasibility-command-failed", category: controller.signal.aborted ? "cancelled" : categoryOf(error),
      ...(error instanceof ConfigurationError ? { message: error.message } : {}),
    }));
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runTeamsAudioQualityCommand();
}
