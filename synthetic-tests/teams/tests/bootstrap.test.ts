import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap } from "../src/bootstrap.js";
import { TeamsBootstrapFailure } from "../../utils/src/teams-user-auth.js";

const state = vi.hoisted(() => ({
  username: "test@example.invalid",
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  configured: ["test@example.invalid"],
  previous: "",
  partitions: {} as Record<string, string>,
  writes: [] as string[],
  cli: vi.fn(),
  device: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@azure/identity", () => ({
  AzureCliCredential: vi.fn(function (...args) { state.cli(...args); }),
}));
vi.mock("../../utils/src/project-config.js", () => ({
  readProjectService: vi.fn(async () => ({
    service: {
      type: "teams", enabled: true, mode: "live", teamsAuthentication: "user-delegated",
      targets: state.configured.map((username, index) => ({
        id: `teams-00${index + 1}`, tenantId: state.tenantId, userPrincipalName: username,
      })),
    },
  })),
}));
vi.mock("../../utils/src/teams-user-auth.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../utils/src/teams-user-auth.js")>();
  const account = () => ({
    homeAccountId: `${state.userId}.${state.tenantId}`, localAccountId: state.userId, tenantId: state.tenantId,
    username: state.username, environment: "login.windows.net",
  });
  return {
    ...original,
    accountBlobCache: (settings: { username: string }) => ({
      transaction: async (signal: AbortSignal, bootstrapMode: boolean, action: (previous: string, bounded: AbortSignal) => Promise<{ serialized: string }>) => {
        state.transaction(signal, bootstrapMode);
        const result = await action(state.partitions[settings.username] ?? "", signal);
        state.writes.push(result.serialized);
        state.partitions[settings.username] = result.serialized;
      },
    }),
    userApplication: () => {
      let accounts: ReturnType<typeof account>[] = [];
      return {
        getTokenCache: () => ({
          deserialize: (serialized: string) => { accounts = JSON.parse(serialized) as ReturnType<typeof account>[]; },
          getAllAccounts: async () => accounts, serialize: () => JSON.stringify(accounts),
        }),
        acquireTokenByDeviceCode: async (request: unknown) => {
          const result = await state.device(request) as { account: ReturnType<typeof account> };
          accounts = [...accounts.filter(previous => previous.username !== result.account.username), result.account];
          return result;
        },
      };
    },
  };
});
const args = [
  "--project-config", "private-root.json", "--client-id", "33333333-3333-4333-8333-333333333333",
  "--cache-account-url", "https://approvedcache.blob.core.windows.net", "--timeout-seconds", "30",
];

beforeEach(() => {
  vi.clearAllMocks();
  state.username = "test@example.invalid";
  state.userId = "22222222-2222-4222-8222-222222222222";
  state.configured = ["test@example.invalid"];
  state.partitions = {};
  state.previous = JSON.stringify([{
    homeAccountId: `${state.userId}.${state.tenantId}`, localAccountId: state.userId, tenantId: state.tenantId,
    username: state.username, environment: "login.windows.net",
  }]);
  state.writes.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.device.mockImplementation(async (request: {
    deviceCodeCallback: (value: { verificationUri: string; userCode: string; message: string }) => void;
  }) => {
    request.deviceCodeCallback({ verificationUri: "https://microsoft.com/devicelogin", userCode: "ABCD-EFGH", message: "must-not-log-verbatim" });
    return { tenantId: state.tenantId, account: {
      homeAccountId: `${state.userId}.${state.tenantId}`, localAccountId: state.userId, tenantId: state.tenantId,
      username: state.username, environment: "login.windows.net",
    } };
  });
});
afterEach(() => vi.restoreAllMocks());

describe("operator-only device-code bootstrap", () => {
  it("uses explicit Azure CLI storage identity and prints only safe device information/completion", async () => {
    await bootstrap(args);
    expect(state.cli).toHaveBeenCalledExactlyOnceWith({ tenantId: state.tenantId });
    expect(state.transaction).toHaveBeenCalledWith(expect.any(AbortSignal), true);
    expect(state.writes).toHaveLength(1);
    expect(JSON.parse(state.writes[0]!)).toEqual([expect.objectContaining({ username: state.username })]);
    const output = JSON.stringify(vi.mocked(console.log).mock.calls);
    expect(output).toContain("ABCD-EFGH");
    expect(output).toContain("teams-user-cache-bootstrapped");
    expect(output).not.toContain("fake-sensitive-cache");
    expect(output).not.toContain("must-not-log-verbatim");
    expect(output).not.toContain(state.username);
  });
  it("does not overwrite the previous cache for a wrong signed-in account", async () => {
    const previous = state.previous;
    state.username = "wrong@example.invalid";
    await expect(bootstrap(args)).rejects.toThrow("reauthentication-required");
    expect(state.writes).toEqual([]);
    expect(state.previous).toBe(previous);
  });
  it("does not bypass tenant policy failures or expose raw MSAL errors", async () => {
    state.device.mockRejectedValueOnce(new Error("sensitive tenant policy error detail"));
    await expect(bootstrap(args)).rejects.toThrow();
    expect(state.writes).toEqual([]);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("sensitive tenant policy");
  });
  it("cancels interactive polling on SIGINT without persisting cache", async () => {
    let request: { cancel: boolean } | undefined;
    state.device.mockImplementationOnce(async (value: { cancel: boolean }) => {
      request = value;
      process.emit("SIGINT");
      return new Promise(() => {});
    });
    await expect(bootstrap(args)).rejects.toThrow();
    expect(request?.cancel).toBe(true);
    expect(state.writes).toEqual([]);
    expect(vi.mocked(console.error).mock.calls.map(([text]) => JSON.parse(String(text))))
      .toContainEqual(expect.objectContaining({ reason: "cancelled" }));
  });
  it.each(["timeout", "user-denied", "policy", "storage", "lease"] as const)(
    "reports a safe %s cause without raw identity/storage messages", async reason => {
      state.transaction.mockImplementationOnce(() => {
        throw new TeamsBootstrapFailure(reason, "unit-test-safe-code", reason === "storage" ? 403 : undefined);
      });
      await expect(bootstrap(args)).rejects.toThrow();
      const output = JSON.stringify(vi.mocked(console.error).mock.calls);
      expect(vi.mocked(console.error).mock.calls.map(([text]) => JSON.parse(String(text))))
        .toContainEqual(expect.objectContaining({ reason }));
      expect(output).toContain("unit-test-safe-code");
      expect(output).not.toContain(state.username);
      expect(state.writes).toEqual([]);
    },
  );
  it("requires an explicitly configured selector with multiple root accounts before Blob access", async () => {
    state.configured.push("user2@example.invalid", "user3@example.invalid");
    await expect(bootstrap(args)).rejects.toThrow("--user-principal-name");
    await expect(bootstrap([...args, "--user-principal-name", "unconfigured@example.invalid"])).rejects.toThrow("configured root target");
    expect(state.cli).not.toHaveBeenCalled();
    expect(state.transaction).not.toHaveBeenCalled();
  });
  it("bootstraps Users2/3 into independent partitions without changing User1 legacy state or another user's cache", async () => {
    state.configured.push("user2@example.invalid", "user3@example.invalid");
    const legacy = state.previous;
    for (const [username, id] of [
      ["user2@example.invalid", "44444444-4444-4444-8444-444444444444"],
      ["user3@example.invalid", "55555555-5555-4555-8555-555555555555"],
    ]) {
      state.username = username!;
      state.userId = id!;
      await bootstrap([...args, "--user-principal-name", state.username]);
    }
    expect(state.previous).toBe(legacy);
    expect(Object.keys(state.partitions)).toEqual(["user2@example.invalid", "user3@example.invalid"]);
    for (const username of Object.keys(state.partitions)) {
      expect(JSON.parse(state.partitions[username]!)).toEqual([expect.objectContaining({ username })]);
    }
    const previous = structuredClone(state.partitions);
    state.username = "wrong@example.invalid";
    await expect(bootstrap([...args, "--user-principal-name", "user2@example.invalid"])).rejects.toThrow("reauthentication-required");
    expect(state.partitions).toEqual(previous);
    expect(state.previous).toBe(legacy);
    expect(state.writes).toHaveLength(2);
  });
});
