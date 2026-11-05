import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { DurableClient } from "durable-functions";
import { ConfigurationError } from "../../utils/src/configuration/config.js";
import type { ProjectDocument } from "../../utils/src/configuration/project-config.js";
import { dispatchRunId, dispatchSchema, laneInstanceId, selectDispatch, type LaneDispatch } from "./dispatch.js";
import { createLaneOwnership, LaneConflictError, type LaneOwnership } from "./lane-ownership.js";
import { verifyDispatcher } from "./dispatcher-auth.js";
import { runtimeDocument } from "./runtime.js";
import { ZodError } from "zod";

interface StarterDependencies {
  document: ProjectDocument;
  configSha256: string;
  ownership: LaneOwnership;
  start(dispatch: LaneDispatch, instanceId: string): Promise<void>;
  now?: () => number;
}

/** Durably accepts one deterministic slot while the persistent journal enforces lane-level singleton ownership. */
async function acceptLaneStart(raw: unknown, dependencies: StarterDependencies): Promise<{ runId: string }> {
  const dispatch = dispatchSchema.parse(raw);
  selectDispatch(dependencies.document, dispatch, dependencies.configSha256, dependencies.now?.() ?? Date.now());
  const instanceId = `${laneInstanceId(dispatch)}-${dispatchRunId(dispatch)}`;
  const accepted = await dependencies.ownership.accept(dispatch, () => dependencies.start(dispatch, instanceId));
  return { runId: accepted.runId };
}

/** Returns only a receipt after Durable Storage acceptance, never key-bearing management URLs or results. */
export async function startLane(
  request: HttpRequest, context: InvocationContext, client: Pick<DurableClient, "startNew">,
): Promise<HttpResponseInit> {
  const headers = { "Cache-Control": "no-store" };
  try { await verifyDispatcher(request.headers.get("authorization"), process.env); }
  catch (error) {
    context.warn("lane-dispatch-unauthorized", { errorType: error instanceof Error ? error.name : "unknown" });
    return { status: 401, headers };
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > 4096) {
    context.warn("lane-dispatch-invalid", { reason: "body-too-large" });
    return { status: 413, headers };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch {
    context.warn("lane-dispatch-invalid", { reason: "invalid-json" });
    return { status: 400, headers };
  }
  try {
    const receipt = await acceptLaneStart(raw, {
      document: await runtimeDocument(), configSha256: process.env.MONITORING_CONFIG_SHA256!,
      ownership: createLaneOwnership(process.env),
      async start(dispatch, instanceId) {
        await client.startNew("laneOrchestrator", { instanceId, input: dispatch });
      },
    });
    context.log("lane-dispatch-accepted", receipt);
    return { status: 202, headers, jsonBody: receipt };
  } catch (error) {
    context.error("lane-dispatch-rejected", { errorType: error instanceof Error ? error.name : "unknown" });
    return {
      status: error instanceof LaneConflictError || error instanceof ConfigurationError ? 409 : error instanceof ZodError ? 400 : 500,
      headers, jsonBody: { error: "Lane dispatch was not accepted; inspect Function diagnostics and persistent ownership" },
    };
  }
}
