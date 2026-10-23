import { AzureCliCredential } from "@azure/identity";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readProjectService } from "../../utils/src/project-config.js";
import { ConfigurationError } from "../../utils/src/config.js";
import { IntegrationError } from "../../utils/src/http.js";
import {
  abortable, accountBlobCache, selectTeamsAccount, teamsDelegatedScopes, teamsUserCacheBlob, teamsUserSettings, userApplication,
  TeamsBootstrapFailure,
} from "../../utils/src/teams-user-auth.js";

export async function bootstrap(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (!["--project-config", "--client-id", "--cache-account-url", "--timeout-seconds", "--user-principal-name"].includes(key) ||
        !value || value.startsWith("--") || values.has(key)) throw new ConfigurationError("Invalid bootstrap arguments");
    values.set(key, value);
  }
  if (!values.get("--project-config")) throw new ConfigurationError("Bootstrap requires --project-config");
  const seconds = Number(values.get("--timeout-seconds") ?? "600");
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 900) throw new ConfigurationError("Bootstrap timeout must be 30–900 seconds");
  const { service } = await readProjectService("teams", resolve(values.get("--project-config")!));
  if (!service.enabled || service.mode !== "live" || service.teamsAuthentication !== "user-delegated") {
    throw new ConfigurationError("Bootstrap requires selected live user-delegated Teams journeys");
  }
  const settings = teamsUserSettings(service, {
    TEAMS_PUBLIC_CLIENT_ID: values.get("--client-id"), TEAMS_CACHE_ACCOUNT_URL: values.get("--cache-account-url"),
  }, values.get("--user-principal-name"));
  const cancelled = new AbortController();
  let lastPhase = "starting";
  let failurePhase: string | undefined;
  const onCancel = () => cancelled.abort();
  process.once("SIGINT", onCancel);
  process.once("SIGTERM", onCancel);
  const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(seconds * 1000)]);
  const startedAt = Date.now();
  const phase = (value: string) => { lastPhase = value; console.log(JSON.stringify({
    event: "teams-user-bootstrap-phase", phase: value, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
    cacheBlob: teamsUserCacheBlob(settings),
  })); };
  try {
    const cache = accountBlobCache(settings, new AzureCliCredential({ tenantId: settings.tenantId }), phase);
    phase("waiting-for-cache-lock");
    await cache.transaction(signal, true, async (previous, bounded) => {
      phase("cache-lock-acquired");
      let identityFailure: TeamsBootstrapFailure | undefined;
      const app = userApplication(settings, bounded, (value, failure) => {
        phase(value);
        identityFailure = failure ?? identityFailure;
      });
      if (previous) app.getTokenCache().deserialize(previous);
      const request = {
        scopes: teamsDelegatedScopes,
        timeout: seconds,
        deviceCodeCallback: (response: { verificationUri: string; userCode: string }) => {
          console.log(JSON.stringify({ verificationUri: response.verificationUri, userCode: response.userCode }));
        },
        cancel: false,
      };
      const onAbort = () => { request.cancel = true; };
      bounded.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await abortable(app.acquireTokenByDeviceCode(request), bounded);
        if (!result?.account || result.tenantId.toLowerCase() !== settings.tenantId.toLowerCase()) {
          throw new TeamsBootstrapFailure("wrong-account", "account-or-tenant-mismatch");
        }
        selectTeamsAccount(await app.getTokenCache().getAllAccounts(), settings);
        selectTeamsAccount([result.account], settings);
        phase("account-validated");
        return { value: undefined, serialized: app.getTokenCache().serialize() };
      } catch (error) {
        failurePhase = lastPhase;
        if (identityFailure) throw identityFailure;
        if (bounded.aborted && bounded.reason instanceof TeamsBootstrapFailure) throw bounded.reason;
        if (error instanceof TeamsBootstrapFailure) throw error;
        if (error instanceof IntegrationError && error.category === "reauthentication-required") {
          throw new TeamsBootstrapFailure("wrong-account", "account-or-tenant-mismatch");
        }
        if (bounded.aborted) throw new TeamsBootstrapFailure(
          cancelled.signal.aborted ? "cancelled" : "timeout",
          cancelled.signal.aborted ? "operator-cancelled" : "bootstrap-deadline-exceeded",
        );
        throw new TeamsBootstrapFailure("authentication", "identity-sdk-request-failed");
      } finally { bounded.removeEventListener("abort", onAbort); }
    });
    phase("cache-persisted-and-lock-released");
    console.log(JSON.stringify({ event: "teams-user-cache-bootstrapped" }));
  } catch (error) {
    const failure = error instanceof TeamsBootstrapFailure ? error
      : new TeamsBootstrapFailure(signal.aborted ? cancelled.signal.aborted ? "cancelled" : "timeout" : "authentication",
        signal.aborted ? cancelled.signal.aborted ? "operator-cancelled" : "bootstrap-deadline-exceeded" : "bootstrap-request-failed");
    console.error(JSON.stringify({
      event: "teams-user-bootstrap-failed", phase: failurePhase ?? lastPhase, category: failure.category, reason: failure.reason,
      errorCode: failure.errorCode, ...(failure.status !== undefined ? { httpStatus: failure.status } : {}),
      ...(failure.identityErrorCode !== undefined ? { identityErrorCode: failure.identityErrorCode } : {}),
      elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }));
    throw failure;
  } finally {
    process.removeListener("SIGINT", onCancel);
    process.removeListener("SIGTERM", onCancel);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bootstrap(process.argv.slice(2)).catch(error => {
    if (error instanceof ConfigurationError) console.error(JSON.stringify({
      event: "teams-user-bootstrap-failed", phase: "configuration", category: "configuration-failure",
      reason: "configuration", errorCode: "invalid-bootstrap-configuration",
    }));
    console.error("Teams bootstrap failed or cancelled. Check approved tenant policy, account, consent and container RBAC; cache persistence was not confirmed.");
    process.exitCode = 1;
  });
}
