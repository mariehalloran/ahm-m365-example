import type { TokenCredential } from "@azure/identity";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IntegrationError } from "../../utils/src/http.js";
import { readProjectConfig, type ProjectConfig } from "../../utils/src/project-config.js";
import { cachedSetupCredential, parseSetupArguments, runSetupCommand } from "../src/setup-command.js";
import { setupOneDriveTargets, type SetupGraph, type SetupOptions } from "../src/setup.js";

const workerClientId = "22222222-2222-4222-8222-222222222222";
const tenantId = "33333333-3333-4333-8333-333333333333";
const sample = await readProjectConfig("../monitoring.config.json");
type Target = ProjectConfig["services"]["onedrive"]["targets"][number];
interface Folder {
  id: string; name: string; folder: object; parentReference: { id: string; driveId: string };
}
interface Permission {
  id: string; roles: string[]; grantedToV2: { application: { id: string } } | null;
  grantedToIdentitiesV2?: { application: { id: string } }[] | null; inheritedFrom?: object | null;
}
interface Account {
  target: Target; driveId: string; rootId: string; folder?: Folder; permissions: Permission[];
  denied?: boolean; unprovisioned?: boolean; ambiguousFolder?: boolean; ambiguousGrant?: boolean;
  omitGrant?: boolean; hiddenGrantReads?: number; nextLink?: string; pagePermissions?: Permission[];
}

function fixture(count = 2, existingFolders = false) {
  const targets: Target[] = Array.from({ length: count }, (_, index) => ({
    id: `account-${index}`, userId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    userPrincipalName: `account-${index}@example.invalid`, folderName: "AHM-Synthetic-Tests",
  }));
  const accounts: Account[] = targets.map((target, index) => ({
    target, driveId: `drive-${index}`, rootId: `root-${index}`, permissions: [],
    ...(existingFolders ? { folder: {
      id: `folder-${index}`, name: target.folderName!, folder: {},
      parentReference: { id: `root-${index}`, driveId: `drive-${index}` },
    } } : {}),
  }));
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const hooks: { afterMutation?: () => Promise<void> } = {};
  let active = 0;
  let peak = 0;
  const raw = async (path: string, signal: AbortSignal, method: string, body?: unknown): Promise<unknown> => {
    signal.throwIfAborted();
    calls.push({ path, method, ...(body === undefined ? {} : { body }) });
    const url = new URL(`https://graph.microsoft.com/v1.0${path}`);
    const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
    const account = accounts.find(item => parts[0] === "users" ? item.target.userId === parts[1] : item.driveId === parts[1]);
    if (!account) throw new Error(`Unexpected out-of-allowlist request ${path}`);
    if (account.denied) throw new IntegrationError("permission-failure", 403);
    if (parts[0] === "users") {
      if (account.unprovisioned) throw new IntegrationError("read-failure", 404);
      return { id: account.driveId, driveType: "business" };
    }
    if (parts[2] === "root" && method === "GET") return { id: account.rootId };
    if (parts[2] === "root" && parts[3] === "children" && method === "POST") {
      const request = z.object({
        name: z.string(), folder: z.object({}), "@microsoft.graph.conflictBehavior": z.literal("fail"),
      }).strict().parse(body);
      if (account.folder) throw new IntegrationError("graph-unavailable", 409);
      account.folder = {
        id: `folder-${account.target.id}`, name: request.name, folder: {},
        parentReference: { id: account.rootId, driveId: account.driveId },
      };
      await hooks.afterMutation?.();
      if (account.ambiguousFolder) {
        account.ambiguousFolder = false;
        throw new IntegrationError("graph-unavailable", 503);
      }
      return account.folder;
    }
    if (parts[4] === "permissions") {
      if (!account.folder || parts[3] !== account.folder.id) throw new Error("Permission operation outside the dedicated folder");
      if (method === "GET") {
        if (url.searchParams.has("$skiptoken")) return { value: account.pagePermissions ?? [] };
        if (account.hiddenGrantReads && account.permissions.length) {
          account.hiddenGrantReads--;
          return { value: [] };
        }
        return { value: account.permissions, ...(account.nextLink ? { "@odata.nextLink": account.nextLink } : {}) };
      }
      if (method === "PATCH") {
        const request = z.object({ roles: z.array(z.string()) }).strict().parse(body);
        const permission = account.permissions.find(item => item.id === parts[5]);
        if (!permission || permission.inheritedFrom) throw new Error("Unexpected permission upgrade");
        permission.roles = request.roles;
        return permission;
      }
      if (method === "POST") {
        const request = z.object({
          roles: z.array(z.literal("write")),
          grantedToV2: z.object({ application: z.object({ id: z.literal(workerClientId) }).strict() }).strict(),
        }).strict().parse(body);
        const permission = { id: `grant-${account.target.id}`, ...request };
        if (!account.omitGrant) account.permissions.push(permission);
        await hooks.afterMutation?.();
        if (account.ambiguousGrant) {
          account.ambiguousGrant = false;
          throw new IntegrationError("graph-unavailable", 503);
        }
        return permission;
      }
    }
    if (method !== "GET") throw new Error(`Unexpected mutation ${method} ${path}`);
    if (!account.folder) throw new IntegrationError("read-failure", 404);
    if (parts[2] === "items" && parts[3] !== account.folder.id) throw new IntegrationError("read-failure", 404);
    return account.folder;
  };
  async function json<T>(
    path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, signal: AbortSignal, method = "GET", body?: unknown,
  ): Promise<T> {
    active++;
    peak = Math.max(peak, active);
    try { return schema.parse(await raw(path, signal, method, body)); }
    finally { active--; }
  }
  const authenticate = vi.fn<SetupGraph["authenticate"]>(async signal => { signal.throwIfAborted(); });
  const graph: SetupGraph = { authenticate, json };
  const telemetry = { emit: vi.fn() };
  const checkpoint = vi.fn(async () => {});
  const sleep = vi.fn(async (_milliseconds: number, signal: AbortSignal) => { signal.throwIfAborted(); });
  const options: SetupOptions = {
    workerClientId, apply: true, concurrency: 4, targetTimeoutSeconds: 300,
    signal: new AbortController().signal, telemetry, checkpoint, sleep,
  };
  return { targets, accounts, calls, hooks, graph, authenticate, telemetry, checkpoint, sleep, options, peak: () => peak };
}

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function privateProfile(targets: Target[]) {
  const directory = await mkdtemp(join(tmpdir(), "ahm-onedrive-setup-"));
  directories.push(directory);
  const file = join(directory, "monitoring.private.json");
  const { serviceHealth: _serviceHealth, ...root } = sample;
  const { callQualityThresholds: _thresholds, ...healthModel } = root.healthModel;
  const original = {
    ...root, healthModel,
    services: { ...root.services, onedrive: { ...root.services.onedrive, targets } },
  };
  await writeFile(file, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
  const args = [file, "--tenant-id", tenantId, "--worker-client-id", workerClientId, "--authentication", "azure-cli"];
  return { directory, file, original, args };
}

describe("bulk dedicated-folder setup", () => {
  it("refuses apply without a binding checkpoint before authentication or mutations", async () => {
    const f = fixture();
    const { checkpoint: _checkpoint, ...options } = f.options;
    await expect(setupOneDriveTargets(f.targets, f.graph, options)).rejects.toThrow("configuration checkpoint");
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
  it("plans every account without mutating Graph or configuration", async () => {
    const f = fixture();
    const result = await setupOneDriveTargets(f.targets, f.graph, { ...f.options, apply: false });
    expect(result).toMatchObject({ total: 2, planned: 2, ready: 0, failed: 0, notStarted: 0 });
    expect(result.outcomes.every(outcome => outcome.status === "planned" && outcome.folderAction === "create")).toBe(true);
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
    expect(f.checkpoint).not.toHaveBeenCalled();
    expect(f.accounts.every(account => !account.folder && account.permissions.length === 0)).toBe(true);
  });
  it("provisions 500 accounts with bounded concurrency, checkpoints each binding, and safely reruns", async () => {
    const f = fixture(500);
    expect(await setupOneDriveTargets(f.targets, f.graph, f.options)).toMatchObject({
      total: 500, ready: 500, failed: 0, notStarted: 0,
    });
    expect(f.peak()).toBeLessThanOrEqual(4);
    expect(f.peak()).toBeGreaterThan(1);
    expect(f.checkpoint).toHaveBeenCalledTimes(500);
    const mutations = f.calls.filter(call => call.method !== "GET").length;
    expect(mutations).toBe(1000);
    expect(await setupOneDriveTargets(f.targets, f.graph, f.options)).toMatchObject({ ready: 500, failed: 0 });
    expect(f.calls.filter(call => call.method !== "GET")).toHaveLength(mutations);
    expect(f.accounts.every(account => account.permissions.length === 1 &&
      account.permissions[0]?.grantedToV2?.application.id === workerClientId)).toBe(true);
  });
  it("continues independent accounts after an unprovisioned drive or denied access without fabricating bindings", async () => {
    const f = fixture(3);
    f.accounts[0]!.unprovisioned = true;
    f.accounts[1]!.denied = true;
    const result = await setupOneDriveTargets(f.targets, f.graph, f.options);
    expect(result).toMatchObject({ ready: 1, failed: 2, notStarted: 0 });
    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "account-0", status: "failed", stage: "drive", httpStatus: 404 }),
      expect.objectContaining({ targetId: "account-1", status: "failed", stage: "drive", httpStatus: 403 }),
    ]));
    expect(f.checkpoint).toHaveBeenCalledExactlyOnceWith({
      targetId: "account-2", driveId: "drive-2", folderId: "folder-account-2",
    });
  });
  it("upgrades a direct read grant and preserves unrelated grants with nullable metadata", async () => {
    const f = fixture(1, true);
    const unrelated = { id: "other", roles: ["read"], grantedToV2: { application: { id: tenantId } } };
    f.accounts[0]!.permissions = [
      unrelated, { id: "link", roles: ["read"], grantedToV2: null, grantedToIdentitiesV2: null, inheritedFrom: null },
      { id: "worker", roles: ["read"], grantedToV2: { application: { id: workerClientId } }, inheritedFrom: null },
    ];
    expect(await setupOneDriveTargets(f.targets, f.graph, f.options)).toMatchObject({ ready: 1 });
    expect(f.calls.filter(call => call.method !== "GET")).toEqual([{
      path: "/drives/drive-0/items/folder-0/permissions/worker", method: "PATCH", body: { roles: ["write"] },
    }]);
    expect(unrelated.roles).toEqual(["read"]);
  });
  it("finds an existing grant on a later page without adding another permission", async () => {
    const f = fixture(1, true);
    f.accounts[0]!.nextLink = "https://graph.microsoft.com/v1.0/drives/drive-0/items/folder-0/permissions?$skiptoken=next";
    f.accounts[0]!.pagePermissions = [{
      id: "worker", roles: ["write"], grantedToV2: { application: { id: workerClientId } },
    }];
    expect(await setupOneDriveTargets(f.targets, f.graph, f.options)).toMatchObject({ ready: 1 });
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
  });
  it.each(["wrong-drive", "drive-root", "wrong-folder", "hostile-page"] as const)(
    "refuses %s before granting access", async failure => {
      const f = fixture(1, true);
      if (failure === "wrong-drive") f.targets[0]!.driveId = "another-drive";
      if (failure === "drive-root") f.accounts[0]!.folder!.id = f.accounts[0]!.rootId;
      if (failure === "wrong-folder") f.accounts[0]!.folder!.name = "Personal";
      if (failure === "hostile-page") {
        f.accounts[0]!.nextLink = "https://graph.microsoft.com/v1.0/drives/other/items/other/permissions";
      }
      expect(await setupOneDriveTargets(f.targets, f.graph, f.options)).toMatchObject({ ready: 0, failed: 1 });
      expect(f.calls.every(call => call.method === "GET")).toBe(true);
      expect(f.checkpoint).not.toHaveBeenCalled();
    },
  );
  it("reconciles ambiguous creations against actual folders and grants instead of blindly resending", async () => {
    const f = fixture(1);
    f.accounts[0]!.ambiguousFolder = true;
    f.accounts[0]!.ambiguousGrant = true;
    expect(await setupOneDriveTargets(f.targets, f.graph, f.options)).toMatchObject({ ready: 1, failed: 0 });
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(2);
    expect(f.telemetry.emit.mock.calls.filter(([event]) => event === "onedrive-setup-mutation-reconciled")).toHaveLength(2);
  });
  it("waits for grant propagation without issuing duplicate writes or checkpointing early", async () => {
    const f = fixture(1);
    f.accounts[0]!.hiddenGrantReads = 2;
    expect(await setupOneDriveTargets(f.targets, f.graph, f.options)).toMatchObject({ ready: 1, failed: 0 });
    expect(f.sleep).toHaveBeenCalledTimes(2);
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(2);
    expect(f.checkpoint).toHaveBeenCalledOnce();
  });
  it("does not checkpoint a grant that was acknowledged but cannot be read back", async () => {
    const f = fixture(1);
    f.accounts[0]!.omitGrant = true;
    expect(await setupOneDriveTargets(f.targets, f.graph, f.options)).toMatchObject({ ready: 0, failed: 1 });
    expect(f.checkpoint).not.toHaveBeenCalled();
    expect(f.accounts[0]!.folder).toBeDefined();
  });
});

describe("private root configuration checkpoints", () => {
  it("persists only verified bindings, preserves unrelated settings/default omissions, and cleans its lock", async () => {
    const f = fixture();
    f.accounts[1]!.denied = true;
    const profile = await privateProfile(f.targets);
    const options = parseSetupArguments([...profile.args, "--apply"]);
    expect(await runSetupCommand(options, f.graph, f.telemetry, f.options.signal)).toMatchObject({ ready: 1, failed: 1 });
    const written = await readProjectConfig(profile.file);
    expect(written.services.onedrive.targets[0]).toMatchObject({ driveId: "drive-0", folderId: "folder-account-0" });
    expect(written.services.onedrive.targets[1]).not.toHaveProperty("folderId");
    const raw = JSON.parse(await readFile(profile.file, "utf8"));
    expect(raw.services.exchange).toEqual(profile.original.services.exchange);
    expect(raw.services.teams).toEqual(profile.original.services.teams);
    expect(raw.healthModel).toEqual(profile.original.healthModel);
    expect(raw).not.toHaveProperty("serviceHealth");
    expect((await stat(profile.file)).mode & 0o777).toBe(0o600);
    expect(await readdir(profile.directory)).toEqual(["monitoring.private.json"]);
    f.accounts[1]!.denied = false;
    expect(await runSetupCommand(options, f.graph, f.telemetry, f.options.signal)).toMatchObject({ ready: 2, failed: 0 });
    expect((await readProjectConfig(profile.file)).services.onedrive.targets.every(target => target.folderId)).toBe(true);
  });
  it("does not rewrite the profile in plan mode", async () => {
    const f = fixture();
    const profile = await privateProfile(f.targets);
    const before = await readFile(profile.file, "utf8");
    await runSetupCommand(parseSetupArguments(profile.args), f.graph, f.telemetry, f.options.signal);
    expect(await readFile(profile.file, "utf8")).toBe(before);
    expect(await readdir(profile.directory)).toEqual(["monitoring.private.json"]);
  });
  it("refuses a second apply against a locked profile before authentication or mutations", async () => {
    const f = fixture();
    const profile = await privateProfile(f.targets);
    await writeFile(`${profile.file}.onedrive-setup.lock`, "other process");
    await expect(runSetupCommand(parseSetupArguments([...profile.args, "--apply"]), f.graph, f.telemetry, f.options.signal))
      .rejects.toThrow("Another setup holds");
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(await readFile(`${profile.file}.onedrive-setup.lock`, "utf8")).toBe("other process");
  });
  it("stops scheduling on an external config edit without overwriting it or rolling back verified cloud resources", async () => {
    const f = fixture(3);
    const profile = await privateProfile(f.targets);
    const external = `${JSON.stringify({ ...profile.original, healthModel: {
      ...profile.original.healthModel, reportTtlMinutes: 45,
    } }, null, 2)}\n`;
    f.hooks.afterMutation = async () => { await writeFile(profile.file, external); };
    const options = parseSetupArguments([...profile.args, "--apply", "--concurrency", "1"]);
    expect(await runSetupCommand(options, f.graph, f.telemetry, f.options.signal)).toMatchObject({
      ready: 0, failed: 1, notStarted: 2,
    });
    expect(await readFile(profile.file, "utf8")).toBe(external);
    expect(f.accounts[0]!.folder).toBeDefined();
    expect(f.accounts[0]!.permissions).toHaveLength(1);
    expect(await readdir(profile.directory)).toEqual(["monitoring.private.json"]);
  });
  it("retains completed checkpoints on cancellation and starts no more accounts", async () => {
    const f = fixture(3);
    const profile = await privateProfile(f.targets);
    const stop = new AbortController();
    f.telemetry.emit.mockImplementation((event, data) => {
      if (event === "onedrive-setup-target" && data.status === "ready") stop.abort();
    });
    const options = parseSetupArguments([...profile.args, "--apply", "--concurrency", "1"]);
    expect(await runSetupCommand(options, f.graph, f.telemetry, stop.signal)).toMatchObject({
      ready: 1, failed: 0, notStarted: 2,
    });
    const written = await readProjectConfig(profile.file);
    expect(written.services.onedrive.targets.filter(target => target.folderId)).toHaveLength(1);
    expect(await readdir(profile.directory)).toEqual(["monitoring.private.json"]);
  });
});

describe("explicit setup authentication", () => {
  it("requires explicit credentials and refuses the worker as the privileged setup application", async () => {
    const profile = await privateProfile(fixture().targets);
    expect(() => parseSetupArguments(profile.args.filter(value => !["--authentication", "azure-cli"].includes(value)))).toThrow("Usage");
    expect(() => parseSetupArguments([...profile.args, "--concurrency", "11"])).toThrow("Usage");
    expect(() => parseSetupArguments([
      profile.file, "--tenant-id", tenantId, "--worker-client-id", workerClientId,
      "--authentication", "managed-identity", "--setup-client-id", workerClientId,
    ])).toThrow("separate from");
  });
  it("shares one credential request across a large batch and refreshes before expiry without inspecting opaque tokens", async () => {
    vi.useFakeTimers();
    const getToken = vi.fn<TokenCredential["getToken"]>(async () => ({
      token: "opaque-token", expiresOnTimestamp: Date.now() + 3600000,
    }));
    const credential = cachedSetupCredential({ getToken });
    await Promise.all(Array.from({ length: 500 }, () => credential.getToken("scope")));
    expect(getToken).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3360000);
    await credential.getToken("scope");
    expect(getToken).toHaveBeenCalledTimes(2);
  });
});
