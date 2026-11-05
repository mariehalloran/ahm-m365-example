import { consoleTelemetry } from "../../utils/src/contracts.js";
import { serviceEnvironment } from "../../utils/src/execution/runtime.js";
import { executeProviderLane, executeServiceLane, UnsettledExecutionError } from "../../utils/src/execution/lane-execution.js";
import { dispatchRunId, dispatchSchema, selectDispatch, type LaneDispatch } from "./dispatch.js";
import { createLaneOwnership, type LaneOwnership } from "./lane-ownership.js";
import { runtimeDocument, serviceHandlers } from "./runtime.js";
import type { ProjectDocument } from "../../utils/src/configuration/project-config.js";

/** Finds unsettled mutation ownership even when reporting also failed in the same lane. */
function isUnsettled(error: unknown): boolean {
  return error instanceof UnsettledExecutionError ||
    error instanceof AggregateError && error.errors.some(isUnsettled);
}

interface ActivityDependencies {
  document: ProjectDocument;
  configSha256: string;
  ownership: LaneOwnership;
  execute: (dispatch: LaneDispatch, selected: ReturnType<typeof selectDispatch>) => Promise<void>;
  now?: () => number;
}

/** Fences platform redelivery before executing any business operation; never retries uncertain mutations. */
async function executeClaimedLane(raw: unknown, dependencies: ActivityDependencies): Promise<void> {
  const dispatch = dispatchSchema.parse(raw);
  const claim = await dependencies.ownership.claim(dispatch);
  if (claim === "completed") return;
  let phase: "completed" | "failed" | "ambiguous" = "completed";
  let failure: unknown;
  try {
    const selected = selectDispatch(dependencies.document, dispatch, dependencies.configSha256, dependencies.now?.() ?? Date.now());
    await dependencies.execute(dispatch, selected);
  } catch (error) {
    phase = isUnsettled(error) ? "ambiguous" : "failed";
    failure = error;
  }
  try { await dependencies.ownership.finish(dispatch, phase); }
  catch (error) {
    if (failure) throw new AggregateError([failure, error], "Lane execution and persistent ownership completion both failed");
    throw error;
  }
  if (failure) throw failure;
}

/** Runs all selected targets in one durable activity, retaining shared actual-HTTP Exchange permits. */
export async function laneActivity(raw: unknown): Promise<void> {
  const document = await runtimeDocument();
  await executeClaimedLane(raw, {
    document, configSha256: process.env.MONITORING_CONFIG_SHA256!, ownership: createLaneOwnership(process.env),
    async execute(dispatch, selected) {
      const { handler, providers } = await serviceHandlers(dispatch.service);
      const env = serviceEnvironment(selected.project, selected.service, { ...process.env, AZURE_CLIENT_ID: undefined });
      const cycleId = dispatchRunId(dispatch);
      const telemetry = {
        emit: (event: string, data: unknown) => consoleTelemetry.emit(event, {
          ...(typeof data === "object" && data !== null ? data : { data }),
          tenant: dispatch.tenant, service: dispatch.service, lane: dispatch.lane, slot: dispatch.slot,
          runId: cycleId, attemptId: dispatch.attemptId, configSha256: dispatch.configSha256,
        }),
      };
      const options = {
        project: selected.project, handler, providers, env, telemetry, slotStart: dispatch.slot,
        correlation: {
          cycleId, lane: dispatch.lane, slot: dispatch.slot,
          configSha256: dispatch.configSha256, attemptId: dispatch.attemptId,
        },
      };
      if (selected.lane.provider) await executeProviderLane(selected.service, options);
      else await executeServiceLane(selected.service, selected.lane, {
        ...options,
        selectedProbe: { type: selected.lane.probeType, id: selected.lane.testId },
      });
    },
  });
}
