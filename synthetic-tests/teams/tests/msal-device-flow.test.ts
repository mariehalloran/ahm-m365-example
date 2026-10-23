import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlockBlobClient } from "@azure/storage-blob";
import {
  TeamsBlobCache, abortable, selectTeamsAccount, teamsDelegatedScopes, userApplication, type TeamsUserSettings,
} from "../../utils/src/teams-user-auth.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const settings: TeamsUserSettings = {
  tenantId, username: "test@example.invalid", clientId: "33333333-3333-4333-8333-333333333333",
  accountUrl: "https://approvedcache.blob.core.windows.net", container: "teams-auth", blob: "teams-user.msal.json",
};
const authority = `https://login.microsoftonline.com/${tenantId}`;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function network(alwaysPending = false, rejected?: { error: string; error_codes: number[] }) {
  let polls = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = String(input);
    if (url.includes("/discovery/instance")) return Response.json({
      tenant_discovery_endpoint: `${authority}/v2.0/.well-known/openid-configuration`,
      metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net",
        aliases: ["login.microsoftonline.com", "login.windows.net"] }],
    });
    if (url.includes("/.well-known/openid-configuration")) return Response.json({
      issuer: `${authority}/v2.0`, authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
      token_endpoint: `${authority}/oauth2/v2.0/token`, end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
      device_authorization_endpoint: `${authority}/oauth2/v2.0/devicecode`,
      jwks_uri: `${authority}/discovery/v2.0/keys`,
      response_modes_supported: ["query", "fragment", "form_post"], response_types_supported: ["code", "id_token"],
      subject_types_supported: ["pairwise"], id_token_signing_alg_values_supported: ["RS256"],
    });
    if (url.includes("/devicecode")) return Response.json({
      device_code: "fake-device-code", user_code: "UNIT-TEST", verification_uri: "https://microsoft.com/devicelogin",
      expires_in: 900, interval: 0.01, message: "fake SDK test device response",
    });
    if (url.includes("/token")) {
      expect(new URLSearchParams(String(init?.body)).get("device_code")).toBe("fake-device-code");
      polls++;
      if (rejected) return Response.json({
        ...rejected, error_description: "private identity payload must never be logged",
      }, { status: 400 });
      if (alwaysPending || polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({
        token_type: "Bearer", expires_in: 3600, ext_expires_in: 3600,
        scope: teamsDelegatedScopes.join(" "), access_token: "fake-unit-test-access", refresh_token: "fake-unit-test-refresh",
        client_info: encode({ uid: userId, utid: tenantId }),
        id_token: `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
          oid: userId, tid: tenantId, sub: userId, preferred_username: settings.username,
          iss: `${authority}/v2.0`, aud: settings.clientId, iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        })}.fake-unit-test-signature`,
      });
    }
    throw new Error("Unexpected MSAL SDK endpoint");
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, polls: () => polls };
}

afterEach(() => vi.unstubAllGlobals());

describe("installed MSAL SDK device flow, not a fake PublicClientApplication", () => {
  it.each([
    { response: { error: "authorization_declined", error_codes: [65004] }, reason: "user-denied" },
    { response: { error: "access_denied", error_codes: [53003] }, reason: "policy" },
  ])("extracts safe $reason diagnostics before MSAL can wrap a network rejection", async ({ response, reason }) => {
    network(false, response);
    const failures: unknown[] = [];
    const app = userApplication(settings, AbortSignal.timeout(3000), (_phase, failure) => {
      if (failure) failures.push(failure);
    });
    await expect(app.acquireTokenByDeviceCode({
      scopes: teamsDelegatedScopes, timeout: 2, deviceCodeCallback: () => {},
    })).rejects.toThrow();
    expect(failures).toEqual([expect.objectContaining({ reason, errorCode: response.error, identityErrorCode: response.error_codes[0] })]);
    expect(JSON.stringify(failures)).not.toContain("private identity payload");
  });
  it("polls pending then authorized, validates the real SDK account and persists without cache-callback deadlock", async () => {
    const { polls } = network();
    let serialized = "";
    const lease = {
      leaseId: "unit-test-lease", acquireLease: vi.fn(async () => ({})),
      renewLease: vi.fn(async () => ({})), releaseLease: vi.fn(async () => ({})),
    };
    const cache = new TeamsBlobCache({
      getBlobLeaseClient: () => lease,
      getProperties: async () => ({ etag: "unit-test-etag", isServerEncrypted: true, contentLength: serialized.length }),
      downloadToBuffer: async () => Buffer.from(serialized),
      upload: async (value: string) => { serialized = value; return {}; },
    } as unknown as BlockBlobClient);
    const phases: string[] = [];
    const signal = AbortSignal.timeout(3000);
    await cache.transaction(signal, true, async (_previous, bounded) => {
      const app = userApplication(settings, bounded, phase => phases.push(phase));
      const callback = vi.fn();
      const token = await abortable(app.acquireTokenByDeviceCode({
        scopes: teamsDelegatedScopes, timeout: 2, deviceCodeCallback: callback,
      }), bounded);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0]?.[0]).toMatchObject({ userCode: "UNIT-TEST" });
      expect(token?.account).toBeDefined();
      expect(selectTeamsAccount(await app.getTokenCache().getAllAccounts(), settings).localAccountId).toBe(userId);
      return { value: undefined, serialized: app.getTokenCache().serialize() };
    });
    expect(polls()).toBe(2);
    expect(phases).toEqual(["token-poll-started", "token-poll-pending", "token-poll-started", "token-response-received"]);
    expect(serialized.length).toBeGreaterThan(0);
    expect(lease.releaseLease).toHaveBeenCalledOnce();
    const reader = userApplication(settings, AbortSignal.timeout(3000));
    reader.getTokenCache().deserialize(serialized);
    const account = selectTeamsAccount(await reader.getTokenCache().getAllAccounts(), settings);
    const silent = await reader.acquireTokenSilent({ account, scopes: teamsDelegatedScopes });
    expect(silent?.uniqueId).toBe(userId);
    expect(polls()).toBe(2);
  });
  it("cancels continued authorization_pending within the deadline with the real SDK", async () => {
    const { polls } = network(true);
    const controller = new AbortController();
    const app = userApplication(settings, controller.signal);
    const request = { scopes: teamsDelegatedScopes, timeout: 1, cancel: false, deviceCodeCallback: () => {} };
    controller.signal.addEventListener("abort", () => { request.cancel = true; }, { once: true });
    const timer = setTimeout(() => controller.abort(), 40);
    try {
      await expect(abortable(app.acquireTokenByDeviceCode(request), controller.signal)).rejects.toThrow();
      await new Promise(resolve => setTimeout(resolve, 25));
      const finalPolls = polls();
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(polls()).toBe(finalPolls);
      expect(request.cancel).toBe(true);
    } finally { clearTimeout(timer); }
  });
});
