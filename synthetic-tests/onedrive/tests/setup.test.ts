import type { TokenCredential } from "@azure/identity";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readBindings } from "../../utils/src/bindings.js";
import { IntegrationError } from "../../utils/src/http.js";
import { canonicalProjectFile } from "../../utils/src/paths.js";
import { parseProjectDocument, readProjectDocument, selectTenant, type ProjectConfig } from "../../utils/src/project-config.js";
import { documentFixture, multiTenantFixture } from "../../utils/tests/fixtures.js";
import { cachedSetupCredential, parseSetupArguments, selectedSetupOptions, runSetupCommand } from "../src/setup-command.js";
import { setupOneDriveTargets, type SetupGraph, type SetupOptions } from "../src/setup.js";

const workerClientId = "22222222-2222-4222-8222-222222222222";
const tenantId = "33333333-3333-4333-8333-333333333333";
const sample = documentFixture();
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

async function configWorkspace(targets: Target[], concurrency = 4) {
  const directory = await mkdtemp(join(tmpdir(), "ahm-onedrive-setup-"));
  directories.push(directory);
  const file = join(directory, "monitoring.config.json");
  const { serviceHealth: _serviceHealth, ...root } = structuredClone(sample);
  const tenant = root.tenants[0]!;
  tenant.tenantId = tenantId;
  for (const target of [...tenant.services.teams.targets, ...tenant.services.teams.callTargets]) target.tenantId = tenantId;
  tenant.services.onedrive.targets = targets;
  tenant.services.onedrive.setup = { authentication: "azure-cli", workerClientId, concurrency, targetTimeoutSeconds: 300 };
  const original = root;
  await writeFile(file, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
  const args = ["--config", file];
  return { directory, file, env: join(directory, ".env"), original, args };
}
const listing = async (directory: string) => (await readdir(directory)).sort();

describe("bulk dedicated-folder setup", () => {
  it("refuses apply without a binding checkpoint before authentication or mutations", async () => {
    const f = fixture();
    const { checkpoint: _checkpoint, ...options } = f.options;
    await expect(setupOneDriveTargets(f.targets, f.graph, options)).rejects.toThrow("configuration checkpoint");
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
  it("tells an account without a userId to run npm run setup first, before authentication or any Graph request", async () => {
    const f = fixture();
    delete f.targets[1]!.userId;
    await expect(setupOneDriveTargets(f.targets, f.graph, f.options)).rejects.toThrow(
      "run npm run setup first: it looks each userId up from its userPrincipalName and writes it to .env",
    );
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

describe("bindings saved to the .env next to the config", () => {
  it("saves the selected tenant's bindings to the .env and never rewrites the config", async () => {
    const f = fixture();
    const workspace = await configWorkspace(f.targets);
    const document = multiTenantFixture();
    document.tenants[0]!.services.onedrive.targets = f.targets;
    document.tenants[0]!.services.onedrive.setup = { authentication: "azure-cli", workerClientId, concurrency: 4, targetTimeoutSeconds: 300 };
    await writeFile(workspace.file, JSON.stringify(document));
    const configText = await readFile(workspace.file, "utf8");
    const args = ["--config", workspace.file, "--tenant", "contoso", "--apply"];
    expect(await runSetupCommand(parseSetupArguments(args), f.graph, f.telemetry, f.options.signal))
      .toMatchObject({ ready: 2, total: 2, failed: 0 });
    const saved = {
      CONTOSO__ACCOUNT_0__DRIVE_ID: "drive-0", CONTOSO__ACCOUNT_0__FOLDER_ID: "folder-account-0",
      CONTOSO__ACCOUNT_1__DRIVE_ID: "drive-1", CONTOSO__ACCOUNT_1__FOLDER_ID: "folder-account-1",
    };
    expect(await readBindings(workspace.file)).toEqual(saved);
    expect(await readFile(workspace.file, "utf8")).toBe(configText);
    expect(await listing(workspace.directory)).toEqual([".env", "monitoring.config.json"]);
    expect((await stat(workspace.env)).mode & 0o777).toBe(0o600);
    expect(selectTenant(await readProjectDocument(workspace.file), "contoso").services.onedrive.targets).toMatchObject([
      { driveId: "drive-0", folderId: "folder-account-0" }, { driveId: "drive-1", folderId: "folder-account-1" },
    ]);
    f.authenticate.mockClear();
    const unselected = parseSetupArguments(["--config", workspace.file, "--apply"]);
    await expect(runSetupCommand(unselected, f.graph, f.telemetry, f.options.signal)).rejects.toThrow("Select one tenant");
    await expect(runSetupCommand({ ...unselected, tenant: "missing" }, f.graph, f.telemetry, f.options.signal))
      .rejects.toThrow("Unknown --tenant");
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(await readBindings(workspace.file)).toEqual(saved);
  });

  it("saves only verified bindings, keeps the other .env lines and completes the rest on a rerun", async () => {
    const f = fixture();
    f.accounts[1]!.denied = true;
    const workspace = await configWorkspace(f.targets);
    await writeFile(workspace.env, "# my notes\nOTHER=2\n");
    const configText = await readFile(workspace.file, "utf8");
    const options = parseSetupArguments([...workspace.args, "--apply"]);
    expect(await runSetupCommand(options, f.graph, f.telemetry, f.options.signal)).toMatchObject({ ready: 1, failed: 1 });
    expect(await readFile(workspace.env, "utf8")).toBe(
      "# my notes\nOTHER=2\nCONTOSO__ACCOUNT_0__DRIVE_ID=drive-0\nCONTOSO__ACCOUNT_0__FOLDER_ID=folder-account-0\n",
    );
    const written = selectTenant(await readProjectDocument(workspace.file));
    expect(written.services.onedrive.targets[0]).toMatchObject({ driveId: "drive-0", folderId: "folder-account-0" });
    expect(written.services.onedrive.targets[1]).not.toHaveProperty("folderId");
    expect(await readFile(workspace.file, "utf8")).toBe(configText);
    f.accounts[1]!.denied = false;
    expect(await runSetupCommand(options, f.graph, f.telemetry, f.options.signal)).toMatchObject({ ready: 2, failed: 0 });
    expect(selectTenant(await readProjectDocument(workspace.file)).services.onedrive.targets.every(target => target.folderId)).toBe(true);
    expect((await readFile(workspace.env, "utf8")).startsWith("# my notes\nOTHER=2\n")).toBe(true);
    expect(await readFile(workspace.file, "utf8")).toBe(configText);
  });
  it("never creates or changes the .env in plan mode", async () => {
    const f = fixture();
    const workspace = await configWorkspace(f.targets);
    await runSetupCommand(parseSetupArguments(workspace.args), f.graph, f.telemetry, f.options.signal);
    expect(await listing(workspace.directory)).toEqual(["monitoring.config.json"]);
    await writeFile(workspace.env, "OTHER=2\n");
    await runSetupCommand(parseSetupArguments(workspace.args), f.graph, f.telemetry, f.options.signal);
    expect(await readFile(workspace.env, "utf8")).toBe("OTHER=2\n");
  });
  it("keeps the bindings of accounts that finish at the same time", async () => {
    const f = fixture(24);
    const workspace = await configWorkspace(f.targets, 8);
    const options = parseSetupArguments([...workspace.args, "--apply"]);
    expect(await runSetupCommand(options, f.graph, f.telemetry, f.options.signal)).toMatchObject({ ready: 24, failed: 0 });
    const saved = await readBindings(workspace.file);
    expect(Object.keys(saved)).toHaveLength(48);
    for (const index of [0, 11, 23]) {
      expect(saved[`CONTOSO__ACCOUNT_${index}__DRIVE_ID`]).toBe(`drive-${index}`);
      expect(saved[`CONTOSO__ACCOUNT_${index}__FOLDER_ID`]).toBe(`folder-account-${index}`);
    }
  });
  it("stops before any Graph request when a saved binding conflicts with the config", async () => {
    const f = fixture();
    const workspace = await configWorkspace(f.targets.map((target, index) => index ? target : { ...target, driveId: "configured-drive" }));
    await writeFile(workspace.env, "CONTOSO__ACCOUNT_0__DRIVE_ID=another-drive\n");
    await expect(runSetupCommand(parseSetupArguments([...workspace.args, "--apply"]), f.graph, f.telemetry, f.options.signal))
      .rejects.toThrow("CONTOSO__ACCOUNT_0__DRIVE_ID");
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(await readFile(workspace.env, "utf8")).toBe("CONTOSO__ACCOUNT_0__DRIVE_ID=another-drive\n");
  });
  it("stops scheduling accounts when a binding cannot be saved, without rolling back verified cloud resources", async () => {
    const f = fixture(3);
    const workspace = await configWorkspace(f.targets, 1);
    f.hooks.afterMutation = async () => { await mkdir(workspace.env, { recursive: true }); };
    const options = parseSetupArguments([...workspace.args, "--apply"]);
    const summary = await runSetupCommand(options, f.graph, f.telemetry, f.options.signal);
    expect(summary).toMatchObject({ ready: 0, failed: 1, notStarted: 2 });
    expect(summary.outcomes[0]).toMatchObject({ status: "failed", stage: "configuration", category: "configuration-failure" });
    expect(f.accounts[0]!.folder).toBeDefined();
    expect(f.accounts[0]!.permissions).toHaveLength(1);
  });
  it("retains completed bindings on cancellation and starts no more accounts", async () => {
    const f = fixture(3);
    const workspace = await configWorkspace(f.targets, 1);
    const stop = new AbortController();
    f.telemetry.emit.mockImplementation((event, data) => {
      if (event === "onedrive-setup-target" && data.status === "ready") stop.abort();
    });
    const options = parseSetupArguments([...workspace.args, "--apply"]);
    expect(await runSetupCommand(options, f.graph, f.telemetry, stop.signal)).toMatchObject({
      ready: 1, failed: 0, notStarted: 2,
    });
    const written = selectTenant(await readProjectDocument(workspace.file));
    expect(written.services.onedrive.targets.filter(target => target.folderId)).toHaveLength(1);
    expect(await listing(workspace.directory)).toEqual([".env", "monitoring.config.json"]);
  });
});

describe("explicit setup authentication", () => {
  it("parses only the root config, an optional tenant and the apply flag", () => {
    expect(parseSetupArguments([])).toEqual({ projectFile: canonicalProjectFile, apply: false });
    expect(parseSetupArguments(["--apply", "--tenant", "contoso", "--config", "root.json"]))
      .toEqual({ projectFile: "root.json", tenant: "contoso", apply: true });
    for (const args of [["--tenant"], ["--tenant", "a", "--tenant", "b"], ["--apply", "--apply"], ["--unknown", "x"], ["root.json"]]) {
      expect(() => parseSetupArguments(args)).toThrow("Usage");
    }
  });

  it("requires explicit credentials and refuses the worker as the privileged setup application", async () => {
    const workspace = await configWorkspace(fixture().targets);
    const project = selectTenant(parseProjectDocument(workspace.original));
    delete project.services.onedrive.setup;
    expect(() => selectedSetupOptions(parseSetupArguments(workspace.args), project)).toThrow("explicit privileged");
    expect(() => parseSetupArguments([...workspace.args, "--concurrency", "11"])).toThrow("Usage");
    project.services.onedrive.setup = {
      authentication: "managed-identity", workerClientId, setupClientId: workerClientId, concurrency: 4, targetTimeoutSeconds: 300,
    };
    expect(() => selectedSetupOptions(parseSetupArguments(workspace.args), project)).toThrow("separate from");
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
