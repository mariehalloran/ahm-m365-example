import { describe, expect, it, vi } from "vitest";
import { InteractionRequiredAuthError, type AccountInfo, type PublicClientApplication } from "@azure/msal-node";
import type { BlockBlobClient } from "@azure/storage-blob";
import {
  TeamsBlobCache, TeamsUserCredential, selectTeamsAccount, teamsUserCacheBlob, teamsUserSettings, type TeamsUserSettings,
} from "../../utils/src/teams-user-auth.js";
import { parseServiceConfig, serviceSettings } from "../../utils/src/service-config.js";
import { bootstrap } from "../src/bootstrap.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const settings: TeamsUserSettings = {
  tenantId, username: "test@example.invalid", clientId: "33333333-3333-4333-8333-333333333333",
  accountUrl: "https://approvedcache.blob.core.windows.net", container: "teams-auth", blob: "teams-user.msal.json",
};
const account: AccountInfo = {
  homeAccountId: `${userId}.${tenantId}`, localAccountId: userId, tenantId,
  username: settings.username, environment: "login.windows.net",
};
const service = {
  enabled: true, type: "teams", mode: "live", teamsAuthentication: "user-delegated", intervalSeconds: 120, timeoutSeconds: 45, cohort: "teams-global",
  targets: [{
    id: "teams-001", tenantId, userPrincipalName: settings.username,
    teamId: "44444444-4444-4444-8444-444444444444", channelId: "standard-channel",
  }],
};

function blobFixture() {
  let stored: string | undefined = "initial";
  let etag = "etag-1";
  const lease = {
    leaseId: "lease-1", acquireLease: vi.fn(async () => ({})),
    renewLease: vi.fn(async () => ({})), releaseLease: vi.fn(async () => ({})),
  };
  const blob = {
    getBlobLeaseClient: vi.fn(() => lease),
    getProperties: vi.fn(async () => {
      if (stored === undefined) throw { statusCode: 404 };
      return { etag, isServerEncrypted: true, contentLength: Buffer.byteLength(stored) };
    }),
    downloadToBuffer: vi.fn(async () => Buffer.from(stored ?? "")),
    upload: vi.fn(async (text: string, _length: number, options: { conditions: { ifMatch?: string; ifNoneMatch?: string; leaseId?: string } }) => {
      if (options.conditions.ifNoneMatch && stored !== undefined) throw { statusCode: 412 };
      if (options.conditions.ifMatch && options.conditions.ifMatch !== etag) throw { statusCode: 412 };
      stored = text;
      etag = "etag-next";
      return {};
    }),
  };
  return {
    cache: new TeamsBlobCache(blob as unknown as BlockBlobClient), blob, lease,
    set: (value: string | undefined) => { stored = value; }, stored: () => stored,
  };
}

describe("Teams delegated root configuration", () => {
  it("partitions cache locks by normalized account and tenant without changing public storage metadata", () => {
    const name = teamsUserCacheBlob(settings);
    expect(name).toMatch(/^teams-user\.[a-f0-9]{64}\.msal\.json$/);
    expect(teamsUserCacheBlob({ ...settings, username: settings.username.toUpperCase() })).toBe(name);
    expect(teamsUserCacheBlob({ ...settings, username: "other@example.invalid" })).not.toBe(name);
    expect(teamsUserCacheBlob({ ...settings, tenantId: settings.clientId })).not.toBe(name);
    expect(settings.blob).toBe("teams-user.msal.json");
    expect(name).not.toContain(settings.username);
  });
  it("explicitly selects user journeys without needing a Bot Connector URL", () => {
    const parsed = parseServiceConfig(service);
    expect(parsed.teamsAuthentication).toBe("user-delegated");
    expect(serviceSettings(parsed, { ENABLE_LIVE_M365: "true" }).probes[0]).toMatchObject({
      userPrincipalName: settings.username, tenantId,
    });
    expect(teamsUserSettings(parsed, {
      TEAMS_PUBLIC_CLIENT_ID: settings.clientId, TEAMS_CACHE_ACCOUNT_URL: settings.accountUrl,
    })).toEqual(settings);
  });
  it("accepts multiple users with an explicit configured selector and rejects mixed tenants", () => {
    const parsed = parseServiceConfig({
      ...service, targets: [service.targets[0], { ...service.targets[0], id: "teams-002", userPrincipalName: "other@example.invalid" }],
    });
    const env = { TEAMS_PUBLIC_CLIENT_ID: settings.clientId, TEAMS_CACHE_ACCOUNT_URL: settings.accountUrl };
    expect(() => teamsUserSettings(parsed, env)).toThrow("--user-principal-name");
    expect(teamsUserSettings(parsed, env, "OTHER@example.invalid").username).toBe("OTHER@example.invalid");
    expect(() => teamsUserSettings(parsed, env, "unconfigured@example.invalid")).toThrow("configured root target");
    expect(() => parseServiceConfig({
      ...service, targets: [service.targets[0], { ...service.targets[0], id: "teams-002", tenantId: settings.clientId }],
    })).toThrow("one tenantId");
  });
  it("leaves missing account metadata observable as initialization failure without blocking independent providers", () => {
    const parsed = parseServiceConfig({ ...service, targets: [{ ...service.targets[0], userPrincipalName: undefined }] });
    expect(() => teamsUserSettings(parsed, {
      TEAMS_PUBLIC_CLIENT_ID: settings.clientId, TEAMS_CACHE_ACCOUNT_URL: settings.accountUrl,
    })).toThrow("configured root target account");
  });
  it.each(["http://approvedcache.blob.core.windows.net", "https://evil.invalid", `${settings.accountUrl}/?key=secret`])(
    "rejects unapproved cache endpoints %s", accountUrl => {
      expect(() => teamsUserSettings(parseServiceConfig(service), {
        TEAMS_PUBLIC_CLIENT_ID: settings.clientId, TEAMS_CACHE_ACCOUNT_URL: accountUrl,
      })).toThrow("HTTPS");
    },
  );
  it("permits credential-free delegated simulation and default bot mode", () => {
    expect(parseServiceConfig({ ...service, mode: "simulation", targets: [{ id: "teams-001" }] }).teamsAuthentication)
      .toBe("user-delegated");
    expect(parseServiceConfig({
      ...service, teamsAuthentication: "bot", targets: [{ id: "teams-001" }],
    }).teamsAuthentication).toBe("bot");
  });
});

describe("strict delegated account selection", () => {
  it("accepts exactly the expected tenant and username", () => {
    expect(selectTeamsAccount([{ ...account, username: settings.username.toUpperCase() }], settings).localAccountId).toBe(userId);
  });
  it("selects only the expected account from a shared multi-account cache", () => {
    const other = { ...account, username: "other@example.invalid", localAccountId: settings.clientId };
    expect(selectTeamsAccount([other, account], settings).localAccountId).toBe(userId);
    expect(() => selectTeamsAccount([other], settings)).toThrow("reauthentication-required");
  });
  it.each([
    [], [account, account], [{ ...account, username: "wrong@example.invalid" }],
    [{ ...account, tenantId: settings.clientId }], [{ ...account, environment: "evil.invalid" }],
    [{ ...account, localAccountId: "not-an-object-id" }],
  ].map(accounts => ({ accounts })))("requires reauthentication for absent or mismatched accounts", ({ accounts }) => {
    expect(() => selectTeamsAccount(accounts, settings)).toThrow("reauthentication-required");
  });
});

describe("encrypted-at-rest leased Blob token cache", () => {
  it("loads under a lease and writes refresh state with both lease and ETag", async () => {
    const { cache, blob, lease, stored } = blobFixture();
    expect(await cache.transaction(new AbortController().signal, false, async serialized => {
      expect(serialized).toBe("initial");
      return { value: "okay", serialized: "refreshed" };
    })).toBe("okay");
    expect(blob.upload).toHaveBeenCalledWith("refreshed", 9, expect.objectContaining({
      conditions: { ifMatch: "etag-1", leaseId: "lease-1" },
    }));
    expect(lease.acquireLease).toHaveBeenCalledWith(60, expect.anything());
    expect(lease.releaseLease).toHaveBeenCalledOnce();
    expect(stored()).toBe("refreshed");
  });
  it("does not write unchanged cache or failed authentication", async () => {
    const { cache, blob, lease } = blobFixture();
    await cache.transaction(new AbortController().signal, false, async serialized => ({ value: 1, serialized: serialized! }));
    await expect(cache.transaction(new AbortController().signal, false, async () => { throw new Error("sensitive detail"); }))
      .rejects.toThrow("authentication-failure");
    expect(blob.upload).not.toHaveBeenCalled();
    expect(lease.releaseLease).toHaveBeenCalledTimes(2);
  });
  it("recovers on the next call after an empty or missing cache is bootstrapped", async () => {
    const { cache, set } = blobFixture();
    for (const missing of [undefined, ""]) {
      set(missing);
      await expect(cache.transaction(new AbortController().signal, false, vi.fn()))
        .rejects.toThrow("reauthentication-required");
    }
    set("approved");
    expect(await cache.transaction(new AbortController().signal, false, async serialized => ({ value: 1, serialized: serialized! }))).toBe(1);
  });
  it("bootstraps an absent blob with conditional creation", async () => {
    const { cache, set, blob, stored } = blobFixture();
    set(undefined);
    await cache.transaction(new AbortController().signal, true, async () => ({ value: 1, serialized: "approved" }));
    expect(blob.upload.mock.calls[0]?.[2].conditions).toEqual({ ifNoneMatch: "*" });
    expect(stored()).toBe("approved");
  });
  it.each(["lease", "etag", "encryption"] as const)("fails closed on %s errors", async failure => {
    const { cache, blob, lease } = blobFixture();
    if (failure === "lease") lease.acquireLease.mockRejectedValueOnce({ statusCode: 409 });
    if (failure === "etag") blob.upload.mockRejectedValueOnce({ statusCode: 412 });
    if (failure === "encryption") blob.getProperties.mockResolvedValueOnce({ etag: "etag", isServerEncrypted: false, contentLength: 1 });
    await expect(cache.transaction(new AbortController().signal, false, async () => ({ value: 1, serialized: "changed" })))
      .rejects.toThrow("authentication-failure");
    if (failure !== "etag") expect(blob.upload).not.toHaveBeenCalled();
  });
  it("serializes same-process refreshes without mixing cache state", async () => {
    const { cache } = blobFixture();
    const observed: string[] = [];
    await Promise.all([1, 2, 3].map(index => cache.transaction(new AbortController().signal, false, async serialized => {
      observed.push(serialized!);
      return { value: index, serialized: `next-${index}` };
    })));
    expect(observed).toEqual(["initial", "next-1", "next-2"]);
  });
  it("bounds cancellation while waiting behind a transaction", async () => {
    const { cache } = blobFixture();
    const signal = AbortSignal.abort();
    await expect(cache.transaction(signal, false, vi.fn())).rejects.toThrow();
    expect(await cache.transaction(new AbortController().signal, false, async serialized => ({ value: true, serialized: serialized! }))).toBe(true);
  });
  it("aborts and refuses the write after losing a renewable bootstrap lease", async () => {
    vi.useFakeTimers();
    try {
      const { cache, blob, lease } = blobFixture();
      lease.renewLease.mockRejectedValueOnce(new Error("lost lease"));
      const task = cache.transaction(new AbortController().signal, false, async (_serialized, bounded) => {
        await new Promise<void>(resolve => bounded.addEventListener("abort", () => resolve(), { once: true }));
        return { value: 1, serialized: "must-not-write" };
      });
      const rejected = expect(task).rejects.toThrow("authentication-failure");
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
      expect(blob.upload).not.toHaveBeenCalled();
      expect(lease.releaseLease).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});

describe("silent-only worker authentication", () => {
  it("preserves a compatible User1 legacy cache without allowing other selected users to reuse its token", async () => {
    const primary = blobFixture();
    primary.set(undefined);
    const legacy = blobFixture();
    const app = {
      getTokenCache: () => ({
        deserialize: vi.fn(), getAllAccounts: async () => [account], serialize: () => "initial",
      }),
      acquireTokenSilent: vi.fn(async () => ({
        account, tenantId, uniqueId: userId, accessToken: "fake-legacy-user1", expiresOn: new Date(Date.now() + 60000),
      })),
    };
    const factory = () => app as unknown as PublicClientApplication;
    const user1 = new TeamsUserCredential(settings, primary.cache, factory, legacy.cache);
    await expect(user1.getToken("ignored")).resolves.toMatchObject({ token: "fake-legacy-user1" });
    expect(user1.userId).toBe(userId);
    const user2 = new TeamsUserCredential({ ...settings, username: "user2@example.invalid" }, primary.cache, factory, legacy.cache);
    await expect(user2.getToken("ignored")).rejects.toThrow("reauthentication-required");
    expect(app.acquireTokenSilent).toHaveBeenCalledOnce();
    expect(legacy.stored()).toBe("initial");
    expect(primary.blob.upload).not.toHaveBeenCalled();
  });
  it("never falls back to legacy state after revocation or an account mismatch in a present partition", async () => {
    const primary = blobFixture(), legacy = blobFixture();
    const app = {
      getTokenCache: () => ({
        deserialize: vi.fn(), getAllAccounts: async () => [account], serialize: () => "initial",
      }),
      acquireTokenSilent: vi.fn(async () => { throw new InteractionRequiredAuthError("interaction_required", "reauthenticate"); }),
    };
    const credential = new TeamsUserCredential(settings, primary.cache, () => app as unknown as PublicClientApplication, legacy.cache);
    await expect(credential.getToken("ignored")).rejects.toThrow("reauthentication-required");
    expect(legacy.blob.getBlobLeaseClient).not.toHaveBeenCalled();
  });
  it("does not put a stalled account refresh on a healthy account's lock queue", async () => {
    const first = blobFixture(), second = blobFixture();
    let release!: () => void;
    const blocked = first.cache.transaction(new AbortController().signal, false, async serialized => {
      await new Promise<void>(resolve => { release = resolve; });
      return { value: 1, serialized: serialized! };
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    try {
      expect(await second.cache.transaction(new AbortController().signal, false, async serialized => ({
        value: "healthy", serialized: serialized!,
      }))).toBe("healthy");
    } finally { release(); await blocked; }
  });
  it.each(["missing", "interaction"] as const)(
    "isolates a %s account while refreshing the other two in the same leased cache", async failure => {
      const fixture = blobFixture();
      const accounts = [account,
        { ...account, username: "user2@example.invalid", localAccountId: "44444444-4444-4444-8444-444444444444" },
        { ...account, username: "user3@example.invalid", localAccountId: "55555555-5555-4555-8555-555555555555" },
      ];
      const persisted = failure === "missing" ? accounts.filter(item => item !== accounts[1]) : accounts;
      fixture.set(JSON.stringify({ accounts: persisted, refreshed: [] }));
      const credentials = accounts.map(selected => new TeamsUserCredential(
        { ...settings, username: selected.username }, fixture.cache, () => {
          let cache: { accounts: AccountInfo[]; refreshed: string[] };
          return {
            getTokenCache: () => ({
              deserialize: (serialized: string) => { cache = JSON.parse(serialized) as typeof cache; },
              getAllAccounts: async () => cache.accounts,
              serialize: () => JSON.stringify(cache),
            }),
            acquireTokenSilent: async (request: { account: AccountInfo }) => {
              expect(request.account.username).toBe(selected.username);
              if (selected === accounts[1]) throw new InteractionRequiredAuthError("interaction_required", "approved sign-in required");
              cache.refreshed.push(selected.username);
              return {
                account: selected, tenantId, uniqueId: selected.localAccountId,
                accessToken: `fake-for-${selected.localAccountId}`, expiresOn: new Date(Date.now() + 60000),
              };
            },
          } as unknown as PublicClientApplication;
        },
      ));
      const results = await Promise.allSettled(credentials.map(credential => credential.getToken("ignored")));
      expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
      for (const index of [0, 2]) {
        const result = results[index]!;
        expect(result.status === "fulfilled" && result.value.token).toBe(`fake-for-${accounts[index]!.localAccountId}`);
        expect(credentials[index]!.userId).toBe(accounts[index]!.localAccountId);
      }
      expect(credentials[1]!.userId).toBe("");
      const stored = JSON.parse(fixture.stored()!) as { accounts: AccountInfo[]; refreshed: string[] };
      expect(stored.accounts).toEqual(persisted);
      expect(stored.refreshed).toEqual([accounts[0]!.username, accounts[2]!.username]);
    },
  );
  function credentialFixture() {
    const blob = blobFixture();
    const tokenCache = {
      deserialize: vi.fn(), serialize: vi.fn(() => "refreshed"),
      getAllAccounts: vi.fn(async () => [account]),
    };
    const app = {
      getTokenCache: () => tokenCache,
      acquireTokenSilent: vi.fn(async () => ({
        account, tenantId, uniqueId: userId, accessToken: "fake-unit-test-value", expiresOn: new Date(Date.now() + 3600000),
      })),
      acquireTokenByDeviceCode: vi.fn(),
    };
    const credential = new TeamsUserCredential(settings, blob.cache, () => app as unknown as PublicClientApplication);
    return { ...blob, credential, app, tokenCache };
  }
  it("acquires silently and records the validated posting object ID", async () => {
    const { credential, app, stored } = credentialFixture();
    await expect(credential.getToken("ignored")).resolves.toMatchObject({ expiresOnTimestamp: expect.any(Number) });
    expect(credential.userId).toBe(userId);
    expect(app.acquireTokenSilent).toHaveBeenCalledOnce();
    expect(app.acquireTokenByDeviceCode).not.toHaveBeenCalled();
    expect(stored()).toBe("refreshed");
  });
  it.each(["interaction", "revoked", "wrong-account", "wrong-tenant", "wrong-author", "expired"] as const)(
    "fails explicitly without overwriting cache on %s", async failure => {
      const { credential, app, tokenCache, stored } = credentialFixture();
      if (failure === "interaction") app.acquireTokenSilent.mockRejectedValueOnce(new InteractionRequiredAuthError("interaction_required", "approved interaction required"));
      if (failure === "revoked") app.acquireTokenSilent.mockRejectedValueOnce({ errorCode: "invalid_grant", claims: "not-logged" });
      if (failure === "wrong-account") tokenCache.getAllAccounts.mockResolvedValueOnce([{ ...account, username: "wrong@example.invalid" }]);
      if (failure === "wrong-tenant") tokenCache.getAllAccounts.mockResolvedValueOnce([{ ...account, tenantId: settings.clientId }]);
      if (failure === "wrong-author") app.acquireTokenSilent.mockResolvedValueOnce({
        account, tenantId, uniqueId: settings.clientId, accessToken: "fake", expiresOn: new Date(Date.now() + 60000),
      });
      if (failure === "expired") app.acquireTokenSilent.mockResolvedValueOnce({
        account, tenantId, uniqueId: userId, accessToken: "fake", expiresOn: new Date(Date.now() - 1),
      });
      await expect(credential.getToken("ignored")).rejects.toThrow("reauthentication-required");
      expect(app.acquireTokenByDeviceCode).not.toHaveBeenCalled();
      expect(stored()).toBe("initial");
    },
  );
  it("bootstrap rejects unknown, repeated and unbounded arguments before credentials", async () => {
    for (const args of [
      [], ["--password", "never"], ["--project-config", "x", "--project-config", "y"],
      ["--project-config", "x", "--timeout-seconds", "901"],
    ]) await expect(bootstrap(args)).rejects.toThrow();
  });
});
