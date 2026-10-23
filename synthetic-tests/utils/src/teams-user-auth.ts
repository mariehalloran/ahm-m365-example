import { ManagedIdentityCredential, type TokenCredential, type GetTokenOptions } from "@azure/identity";
import { BlobServiceClient, type BlockBlobClient } from "@azure/storage-blob";
import {
  PublicClientApplication, InteractionRequiredAuthError,
  type AccountInfo, type Configuration, type INetworkModule, type NetworkRequestOptions,
} from "@azure/msal-node";
import { z } from "zod";
import { createHash } from "node:crypto";
import { ConfigurationError } from "./config.js";
import { IntegrationError } from "./http.js";
import type { ServiceConfig } from "./service-config.js";

export const teamsDelegatedScopes = [
  "https://graph.microsoft.com/ChannelMessage.Send",
  "https://graph.microsoft.com/ChannelMessage.Read.All",
  "https://graph.microsoft.com/ChannelMessage.ReadWrite",
];
export const teamsCacheContainer = "teams-auth";
export const teamsCacheBlob = "teams-user.msal.json";

class TeamsCacheMissingError extends IntegrationError {
  constructor() { super("reauthentication-required"); }
}

export type TeamsBootstrapFailureReason =
  "timeout" | "cancelled" | "user-denied" | "policy" | "wrong-account" | "storage" | "lease" | "authentication" | "configuration";
export class TeamsBootstrapFailure extends IntegrationError {
  constructor(
    readonly reason: TeamsBootstrapFailureReason, readonly errorCode: string,
    status?: number, readonly identityErrorCode?: number,
  ) {
    super(reason === "wrong-account" ? "reauthentication-required" : "authentication-failure", status);
  }
}

function identityFailure(body: unknown, status: number): TeamsBootstrapFailure {
  const data = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const known = ["authorization_declined", "access_denied", "expired_token", "invalid_grant", "interaction_required",
    "login_required", "consent_required", "invalid_client", "unauthorized_client", "invalid_scope", "bad_verification_code"];
  const code = typeof data.error === "string" && known.includes(data.error) ? data.error : "identity-request-rejected";
  const identityCode = Array.isArray(data.error_codes)
    ? data.error_codes.find((value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    : undefined;
  const reason = code === "authorization_declined" || identityCode === 65004 ? "user-denied"
    : identityCode !== undefined && ([50076, 50079].includes(identityCode) || String(identityCode).startsWith("530")) ? "policy"
    : code === "expired_token" ? "timeout" : "authentication";
  return new TeamsBootstrapFailure(reason, code, status, identityCode);
}

export interface TeamsUserSettings {
  tenantId: string;
  username: string;
  clientId: string;
  accountUrl: string;
  container: string;
  blob: string;
}

export function teamsUserSettings(
  service: ServiceConfig, env: NodeJS.ProcessEnv, userPrincipalName?: string,
): TeamsUserSettings {
  if (service.type !== "teams") throw new ConfigurationError("Delegated authentication is Teams-only");
  const accounts = new Set(service.targets.map(target => target.userPrincipalName?.toLowerCase()));
  const tenants = new Set(service.targets.map(target => target.tenantId?.toLowerCase()));
  const username = userPrincipalName ?? (accounts.size === 1 ? service.targets[0]?.userPrincipalName : undefined);
  const settings = z.object({
    tenantId: z.string().uuid(), username: z.string().email(), clientId: z.string().uuid(),
    accountUrl: z.string().regex(/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/?$/),
    container: z.literal(teamsCacheContainer), blob: z.literal(teamsCacheBlob),
  }).safeParse({
    tenantId: service.targets[0]?.tenantId, username,
    clientId: env.TEAMS_PUBLIC_CLIENT_ID, accountUrl: env.TEAMS_CACHE_ACCOUNT_URL,
    container: env.TEAMS_CACHE_CONTAINER ?? teamsCacheContainer, blob: env.TEAMS_CACHE_BLOB ?? teamsCacheBlob,
  });
  if (!settings.success || !username || !accounts.has(username.toLowerCase()) ||
      accounts.has(undefined) || tenants.size !== 1 || tenants.has(undefined)) {
    throw new ConfigurationError("Teams delegated access requires a configured root target account selector, one tenant, TEAMS_PUBLIC_CLIENT_ID and HTTPS TEAMS_CACHE_ACCOUNT_URL; select --user-principal-name for multiple accounts");
  }
  return settings.data;
}

export function selectTeamsAccount(accounts: AccountInfo[], settings: TeamsUserSettings): AccountInfo {
  const matches = accounts.filter(account =>
    account.username.toLowerCase() === settings.username.toLowerCase() &&
    account.tenantId.toLowerCase() === settings.tenantId.toLowerCase());
  if (matches.length !== 1) throw new IntegrationError("reauthentication-required");
  const account = matches[0]!;
  if ((account.environment !== "login.windows.net" && account.environment !== "login.microsoftonline.com") ||
      !z.string().uuid().safeParse(account.localAccountId).success) {
    throw new IntegrationError("reauthentication-required");
  }
  return account;
}

// Azure Storage provides service-side encryption. Only this dedicated, RBAC-protected
// HTTPS container persists sensitive state; no disk cache or shared-key credentials.
export class TeamsBlobCache {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly blob: BlockBlobClient, private readonly diagnostic?: (phase: string) => void) {}

  async transaction<T>(
    signal: AbortSignal, bootstrap: boolean,
    action: (serialized: string | undefined, signal: AbortSignal) => Promise<{ value: T; serialized: string }>,
  ): Promise<T> {
    const previous = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>(resolve => { unlock = resolve; });
    let operation = "cache-queue";
    const phase = (value: string) => { operation = value; this.diagnostic?.(value); };
    try {
      await abortable(previous, signal);
      signal.throwIfAborted();
      if (bootstrap) {
        phase("cache-creating");
        try {
          await this.blob.upload("", 0, { conditions: { ifNoneMatch: "*" }, abortSignal: signal });
        } catch (error) {
          const alreadyExists = error && typeof error === "object" &&
            (("statusCode" in error && error.statusCode === 412) ||
              ("code" in error && error.code === "BlobAlreadyExists"));
          if (!alreadyExists) throw error;
        }
      }
      const lease = this.blob.getBlobLeaseClient();
      phase("cache-acquiring-lease");
      await lease.acquireLease(60, { abortSignal: signal });
      const lost = new AbortController();
      const bounded = AbortSignal.any([signal, lost.signal]);
      let renewing = false;
      const timer = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void lease.renewLease({ abortSignal: bounded })
          .catch(() => lost.abort(new TeamsBootstrapFailure("lease", "lease-renewal-failed")))
          .finally(() => { renewing = false; });
      }, 20_000);
      try {
        phase("cache-reading");
        const properties = await this.blob.getProperties({ conditions: { leaseId: lease.leaseId }, abortSignal: bounded });
        if (!properties.etag || !properties.isServerEncrypted || (properties.contentLength ?? 0) > 4 * 1024 * 1024) {
          throw new TeamsBootstrapFailure("storage", "cache-encryption-or-size-invalid");
        }
        const buffer = await this.blob.downloadToBuffer(0, undefined, {
          conditions: { leaseId: lease.leaseId, ifMatch: properties.etag }, abortSignal: bounded,
        });
        const serialized = buffer.toString("utf8") || undefined;
        if (!bootstrap && !serialized) throw new TeamsCacheMissingError();
        const result = await action(serialized, bounded);
        bounded.throwIfAborted();
        if (result.serialized !== serialized) {
          phase("cache-writing");
          await this.blob.upload(result.serialized, Buffer.byteLength(result.serialized), {
            conditions: { leaseId: lease.leaseId, ifMatch: properties.etag }, abortSignal: bounded,
            blobHTTPHeaders: { blobContentType: "application/json" },
          });
        }
        return result.value;
      } finally {
        clearInterval(timer);
        this.diagnostic?.("cache-releasing-lease");
        try { await lease.releaseLease({ abortSignal: AbortSignal.timeout(5000) }); }
        catch { throw new TeamsBootstrapFailure("lease", "lease-release-failed"); }
      }
    } catch (error) {
      if (error instanceof IntegrationError || signal.aborted) throw error;
      if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 404) {
        if (bootstrap) throw new TeamsBootstrapFailure("storage", "blob-or-container-not-found", 404);
        throw new TeamsCacheMissingError();
      }
      const status = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode : undefined;
      this.diagnostic?.(`${operation}-failed`);
      const reason = operation.includes("lease") || status === 409 || status === 412 ? "lease" : "storage";
      throw new TeamsBootstrapFailure(reason,
        status === 403 ? "storage-access-denied" : status === 412 ? "cache-concurrency-conflict" : `${reason}-request-failed`, status);
    } finally {
      // Keep the FIFO intact even if a queued caller was cancelled.
      void previous.finally(unlock);
    }
  }
}

export function blobCache(
  settings: TeamsUserSettings, credential: TokenCredential, diagnostic?: (phase: string) => void,
): TeamsBlobCache {
  return new TeamsBlobCache(new BlobServiceClient(settings.accountUrl, credential, {
    retryOptions: { maxTries: 1 },
  }).getContainerClient(settings.container).getBlockBlobClient(settings.blob), diagnostic);
}

export function teamsUserCacheBlob(settings: Pick<TeamsUserSettings, "tenantId" | "username">): string {
  const partition = createHash("sha256")
    .update(`${settings.tenantId.toLowerCase()}\0${settings.username.toLowerCase()}`).digest("hex");
  return `teams-user.${partition}.msal.json`;
}

export function accountBlobCache(
  settings: TeamsUserSettings, credential: TokenCredential, diagnostic?: (phase: string) => void,
): TeamsBlobCache {
  return blobCache({ ...settings, blob: teamsUserCacheBlob(settings) }, credential, diagnostic);
}

export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason instanceof IntegrationError ? signal.reason : new IntegrationError("authentication-failure"));
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

export type TeamsAuthenticationPhase = "token-poll-started" | "token-poll-pending" | "token-response-received" | "token-endpoint-rejected";

export function userApplication(
  settings: TeamsUserSettings, signal: AbortSignal,
  diagnostic?: (phase: TeamsAuthenticationPhase, failure?: TeamsBootstrapFailure) => void,
): PublicClientApplication {
  const send = async <T>(url: string, options?: NetworkRequestOptions, method = "GET") => {
    const tokenRequest = new URL(url).pathname.endsWith("/token");
    if (tokenRequest) diagnostic?.("token-poll-started");
    const response = await fetch(url, {
      method, ...(options?.headers ? { headers: options.headers } : {}),
      ...(options?.body !== undefined ? { body: options.body } : {}), redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    const body: unknown = await response.json();
    if (tokenRequest) {
      const error = body && typeof body === "object" && "error" in body ? body.error : undefined;
      if (error && error !== "authorization_pending") {
        const failure = identityFailure(body, response.status);
        diagnostic?.("token-endpoint-rejected", failure);
        if (diagnostic) throw failure;
      } else {
        diagnostic?.(error === "authorization_pending" ? "token-poll-pending" : "token-response-received");
      }
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), body: body as T };
  };
  const networkClient: INetworkModule = {
    sendGetRequestAsync: <T>(url: string, options?: NetworkRequestOptions) => send<T>(url, options),
    sendPostRequestAsync: <T>(url: string, options?: NetworkRequestOptions) => send<T>(url, options, "POST"),
  };
  const config: Configuration = {
    auth: { clientId: settings.clientId, authority: `https://login.microsoftonline.com/${settings.tenantId}` },
    system: { networkClient, loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
  };
  return new PublicClientApplication(config);
}

export class TeamsUserCredential implements TokenCredential {
  userId = "";
  constructor(
    private readonly settings: TeamsUserSettings, private readonly cache: TeamsBlobCache,
    private readonly application = userApplication,
    private readonly legacyCache?: TeamsBlobCache,
  ) {}

  async getToken(_scopes: string | string[], options?: GetTokenOptions) {
    const signal = AbortSignal.any([
      ...(options?.abortSignal ? [options.abortSignal as AbortSignal] : []), AbortSignal.timeout(15000),
    ]);
    const acquire = (cache: TeamsBlobCache) => cache.transaction(signal, false, async (serialized, bounded) => {
      const app = this.application(this.settings, bounded);
      try {
        app.getTokenCache().deserialize(serialized!);
        const account = selectTeamsAccount(await app.getTokenCache().getAllAccounts(), this.settings);
        const token = await abortable(app.acquireTokenSilent({ account, scopes: teamsDelegatedScopes }), bounded);
        if (!token?.accessToken || !token.expiresOn || token.expiresOn.getTime() <= Date.now() || !token.account) {
          throw new IntegrationError("reauthentication-required");
        }
        const actual = selectTeamsAccount([token.account], this.settings);
        if (actual.localAccountId !== account.localAccountId || token.tenantId.toLowerCase() !== this.settings.tenantId.toLowerCase() ||
            token.uniqueId.toLowerCase() !== actual.localAccountId.toLowerCase()) {
          throw new IntegrationError("reauthentication-required");
        }
        this.userId = actual.localAccountId;
        return {
          value: { token: token.accessToken, expiresOnTimestamp: token.expiresOn.getTime() },
          serialized: app.getTokenCache().serialize(),
        };
      } catch (error) {
        if (error instanceof IntegrationError) throw error;
        if (error instanceof InteractionRequiredAuthError ||
            error && typeof error === "object" && "errorCode" in error &&
            ["invalid_grant", "interaction_required", "login_required", "consent_required", "no_tokens_found"].includes(String(error.errorCode))) {
          throw new IntegrationError("reauthentication-required");
        }
        throw new IntegrationError("authentication-failure");
      }
    });
    try { return await acquire(this.cache); }
    catch (error) {
      if (error instanceof TeamsCacheMissingError && this.legacyCache) return acquire(this.legacyCache);
      throw error;
    }
  }
}

export function createTeamsUserCredentials(service: ServiceConfig, env: NodeJS.ProcessEnv): Map<string, TeamsUserCredential> {
  if (service.type !== "teams") throw new ConfigurationError("Delegated authentication is Teams-only");
  const first = service.targets[0]?.userPrincipalName;
  const settings = teamsUserSettings(service, env, first);
  if (env.AZURE_TENANT_ID?.toLowerCase() !== settings.tenantId.toLowerCase()) {
    throw new ConfigurationError("Teams cache managed identity and delegated target must use the same tenant");
  }
  if (!z.string().uuid().safeParse(env.AZURE_CLIENT_ID).success) {
    throw new ConfigurationError("Teams cache requires an explicitly selected AZURE_CLIENT_ID managed identity");
  }
  const identity = new ManagedIdentityCredential({ clientId: env.AZURE_CLIENT_ID! });
  const legacy = blobCache(settings, identity);
  const users = new Map<string, TeamsUserCredential>();
  for (const target of service.targets) {
    const selected = teamsUserSettings(service, env, target.userPrincipalName);
    users.set(selected.username.toLowerCase(), new TeamsUserCredential(
      selected, accountBlobCache(selected, identity), userApplication, legacy,
    ));
  }
  return users;
}
