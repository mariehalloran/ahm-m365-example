import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { z } from "zod";
import { createTeamsCallingVerifier, callingAuthenticationDiagnostic } from "../../utils/src/integrations/teams-calling-auth.js";
import { callbackStore } from "../../utils/src/integrations/teams-callback-state.js";
import { withAbort } from "../../utils/src/integrations/http.js";
import { runtimeDocument } from "./runtime.js";

const verifiers = new Map<string, ReturnType<typeof createTeamsCallingVerifier>>();
const parameters = z.object({ runId: z.string().uuid(), attemptId: z.string().uuid(), botClientId: z.string().uuid() });

/** Authenticates Graph calling JWTs and persists callback evidence regardless of the receiving host. */
export async function callingCallback(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  const parsed = parameters.safeParse(request.params);
  if (!parsed.success) return { status: 400, headers };
  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > 8192 || !/^Bearer [^\s]+$/i.test(authorization)) return { status: 401, headers };
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return { status: 415, headers };
  const document = await runtimeDocument();
  const tenant = document.tenants.find(tenant => tenant.services.teams.enabled && tenant.services.teams.botPairs.some(pair =>
    [pair.botClientId?.toLowerCase(), pair.botPeerClientId?.toLowerCase()].includes(parsed.data.botClientId.toLowerCase())));
  if (!tenant) return { status: 401, headers };
  const signal = AbortSignal.timeout(5000);
  const audiences = tenant.services.teams.botPairs.flatMap(pair => [pair.botClientId!, pair.botPeerClientId!]);
  let identity;
  try {
    let verifier = verifiers.get(tenant.id);
    if (!verifier) {
      verifier = createTeamsCallingVerifier({ BOT_TENANT_ID: tenant.tenantId }, audiences);
      verifiers.set(tenant.id, verifier);
    }
    identity = await withAbort(signal, async () => (await verifier)(authorization.slice(7)));
    if (identity.botClientId !== parsed.data.botClientId.toLowerCase()) return { status: 401, headers };
  } catch (error) {
    context.warn("teams-calling-callback-rejected", callingAuthenticationDiagnostic(error));
    return { status: 401, headers };
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > 65536) return { status: 413, headers };
  let notification: unknown;
  try { notification = JSON.parse(text); }
  catch { return { status: 400, headers }; }
  try {
    const store = callbackStore(document.deployment!.functions.storageAccount, process.env.AZURE_CLIENT_ID!);
    await withAbort(signal, () => store.accept(parsed.data.runId, parsed.data.attemptId, identity.botClientId, notification, signal));
    context.log("teams-calling-callback-accepted", { runId: parsed.data.runId, attemptId: parsed.data.attemptId });
    return { status: 200, headers };
  } catch (error) {
    context.error("teams-calling-callback-state-failed", { errorType: error instanceof Error ? error.name : "unknown" });
    return { status: 500, headers };
  }
}
