import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalProjectFile, nodeProjectDirectory, repositoryDirectory } from "../src/paths.js";
import { deployMonitoring, DeploymentCommandError, parseDeployArguments, type DeploymentCommand, type DeploymentCommandRunner } from "../src/deploy.js";
import { readProjectService } from "../src/project-config.js";
import { documentFixture } from "./fixtures.js";

const ownedDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(ownedDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const digest = `sha256:${"a".repeat(64)}`;

async function fixture() {
  const document = documentFixture();
  document.healthModel.subscriptionId = document.tenants[0]!.tenantId;
  const base = `/subscriptions/${document.healthModel.subscriptionId}/resourceGroups/${document.healthModel.resourceGroup}/providers`;
  const environmentId = `${base}/Microsoft.App/managedEnvironments/existing-environment`;
  const registryId = `${base}/Microsoft.ContainerRegistry/registries/approvedregistry`;
  document.deployment!.foundation = { mode: "existing", environmentResourceId: environmentId, registryResourceId: registryId };
  document.deployment!.image = { mode: "existing", reference: `approvedregistry.azurecr.io/monitoring@${digest}` };
  document.deployment!.stateDirectory = `.deploy-test-${randomUUID()}`;
  document.deployment!.rolloutTimeoutSeconds = 30;
  const directory = await mkdtemp(join(tmpdir(), "ahm-deploy-"));
  const stateRoot = join(repositoryDirectory, document.deployment!.stateDirectory);
  ownedDirectories.push(directory, stateRoot);
  const file = join(directory, "monitoring.json");
  const identities = new Map<string, { id: string; clientId: string; principalId: string; tenantId: string }>();
  const clientIds = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  const selections = Object.values(document.tenants[0]!.services);
  for (const [index, selected] of selections.entries()) {
    selected.worker!.identityResourceId = `${base}/Microsoft.ManagedIdentity/userAssignedIdentities/identity-${index}`;
    selected.worker!.identityClientId = clientIds[index]!;
    identities.set(selected.worker!.identityResourceId.toLowerCase(), {
      id: selected.worker!.identityResourceId, clientId: clientIds[index]!, principalId: clientIds[index]!,
      tenantId: document.deployment!.azureTenantId,
    });
  }
  const apps = () => selections.map(selected => ({
    name: selected.worker!.appName, environmentId, latestRevisionName: "old", latestReadyRevisionName: "old",
    images: ["old-image@sha256:old"], identities: { [selected.worker!.identityResourceId!]: {} },
    fqdn: `${selected.worker!.appName}.approved.invalid`,
  }));
  const calls: DeploymentCommand[] = [];
  const emit = vi.fn<(event: Record<string, unknown>) => void>();
  const hook: { run?: (command: DeploymentCommand) => string | undefined | void | Promise<string | undefined | void> } = {};
  const run: DeploymentCommandRunner = async command => {
    calls.push(command);
    const overridden = await hook.run?.(command);
    if (typeof overridden === "string") return overridden;
    const argument = (flag: string) => command.args[command.args.indexOf(flag) + 1]!;
    switch (command.phase) {
      case "source-revision": return "c261956afd52745f3b2c4cce8ce9375310f8f853\n";
      case "azure-account": return JSON.stringify({ id: document.healthModel.subscriptionId, tenantId: document.deployment!.azureTenantId });
      case "registry-binding": return JSON.stringify({ id: registryId, loginServer: "approvedregistry.azurecr.io" });
      case "environment-binding": return JSON.stringify({ id: environmentId, defaultDomain: "approved.invalid", location: "East US 2" });
      case "previous-worker-revisions": return JSON.stringify(apps());
      case "identity-binding": return JSON.stringify(identities.get(argument("--ids").toLowerCase()));
      case "bot-binding": {
        const teams = document.tenants[0]!.services.teams;
        const peer = argument("--url").includes("peer-bot");
        const identity = identities.get((peer ? teams.access.botPeerManagedIdentityResourceId! : teams.worker!.identityResourceId!).toLowerCase())!;
        return JSON.stringify({ properties: {
          msaAppId: identity.clientId, msaAppTenantId: identity.tenantId, msaAppMSIResourceId: identity.id,
          msaAppType: "UserAssignedMSI", endpoint: "",
        } });
      }
      case "build-model-bicep":
      case "build-worker-bicep": return "{}";
      case "models-what-if":
      case "foundation-what-if":
      case "workers-preview-what-if":
      case "workers-what-if": return JSON.stringify({ status: "Succeeded", changes: [] });
      case "models-create":
      case "foundation-create":
      case "workers-create": return JSON.stringify({ properties: { provisioningState: "Succeeded" } });
      case "build-image": return "{}";
      case "resolve-image-digest":
      case "existing-image": return JSON.stringify(digest);
      case "verify-rollout": return JSON.stringify({
        name: argument("--name"), latestRevisionName: "new", latestReadyRevisionName: "new", provisioningState: "Succeeded",
        images: [`approvedregistry.azurecr.io/${document.deployment!.image.mode === "build" ? document.deployment!.image.repository : "monitoring"}@${digest}`],
      });
      case "retirement-preflight":
      case "retirement-preflight-entities": return JSON.stringify({ value: [] });
      case "retire-obsolete-relationship":
      case "retire-obsolete-entity": return "";
      default: throw new Error(`Unexpected mocked deployment phase: ${command.phase}`);
    }
  };
  const write = () => writeFile(file, JSON.stringify(document), { mode: 0o600 });
  const execute = async (options: Partial<Parameters<typeof deployMonitoring>[0]> = {}): Promise<Record<string, unknown>> => {
    await write();
    return deployMonitoring({ file, run, emit, ...options });
  };
  return { document, file, directory, stateRoot, base, identities, apps, calls, emit, hook, write, execute };
}

describe("config-driven npm deployment", () => {
  it("forwards the single optional input and keeps plan entirely local", async () => {
    expect(parseDeployArguments([])).toEqual({ plan: false });
    expect(parseDeployArguments(["--config", "chosen.json", "--plan"])).toEqual({ file: "chosen.json", plan: true });
    expect(() => parseDeployArguments(["--access-file", "removed.json"])).toThrow("Usage");
    const f = await fixture();
    const before = await readdir(f.directory);
    const result = await f.execute({ plan: true });
    expect(result).toMatchObject({ cloudChanges: false, configFile: f.file, workerCount: 3, reportingGroups: ["centralus", "uksouth"] });
    expect(f.calls).toEqual([]);
    await expect(stat(f.stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(f.directory)).toEqual([...before, "monitoring.json"]);
    for (const type of ["exchange", "teams", "onedrive"] as const) {
      const selected = await readProjectService(type, f.file);
      expect(selected.service.targets).toEqual(f.document.tenants[0]!.services[type].targets);
    }
    expect(canonicalProjectFile).toBe(join(repositoryDirectory, "monitoring.config.json"));
  });

  it("runs every initial what-if before mutations, deploys models first and pins the same input into workers", async () => {
    const f = await fixture();
    const result = await f.execute();
    expect(result).toMatchObject({ event: "monitoring-deployment-completed", workerCount: 3 });
    const phases = f.calls.map(command => command.phase);
    const firstMutation = phases.indexOf("models-create");
    for (const phase of ["models-what-if", "foundation-what-if", "workers-preview-what-if", "existing-image"]) {
      expect(phases.indexOf(phase)).toBeLessThan(firstMutation);
    }
    expect(phases.indexOf("models-create")).toBeLessThan(phases.indexOf("workers-create"));
    expect(phases.indexOf("workers-what-if")).toBeLessThan(phases.indexOf("workers-create"));
    for (const phase of ["models-create", "workers-create"]) {
      const command = f.calls.find(command => command.phase === phase)!;
      const path = command.args[command.args.indexOf("--parameters") + 1]!.slice(1);
      expect(JSON.parse(await readFile(path, "utf8")).parameters.projectConfig.value).toEqual(f.document);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    const state = String(result.stateDirectory);
    expect((await stat(state)).mode & 0o777).toBe(0o700);
    const provenance = JSON.parse(await readFile(join(state, "provenance.json"), "utf8"));
    expect(provenance.previousWorkers).toEqual(f.apps());
    expect(provenance.image).toBe(f.document.deployment!.image.mode === "existing" ? f.document.deployment!.image.reference : "");
    expect(f.calls.every(command => command.cwd === nodeProjectDirectory && command.timeoutSeconds <= 1800)).toBe(true);
    expect(f.calls.some(command => command.args.includes("account") && command.args.includes("set"))).toBe(false);
    await expect(stat(join(state, "certificates.parameters.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("addresses an existing registry by name because `az acr` commands have no --ids argument", async () => {
    const f = await fixture();
    await f.execute();
    const binding = f.calls.find(command => command.phase === "registry-binding")!;
    expect(binding.args.slice(0, 2)).toEqual(["acr", "show"]);
    expect(binding.args).not.toContain("--ids");
    expect(binding.args[binding.args.indexOf("--name") + 1]).toBe("approvedregistry");
    expect(binding.args[binding.args.indexOf("--resource-group") + 1]).toBe(f.document.healthModel.resourceGroup);
    expect(f.calls.filter(command => command.args[0] === "acr").every(command => !command.args.includes("--ids"))).toBe(true);
  });

  it("uses ACR build after models and resolves an immutable digest before worker deployment", async () => {
    const f = await fixture();
    f.document.deployment!.image = { mode: "build", repository: "monitoring", tag: "release", platform: "linux/amd64" };
    const result = await f.execute();
    const phases = f.calls.map(command => command.phase);
    expect(phases.indexOf("models-create")).toBeLessThan(phases.indexOf("build-image"));
    expect(phases.indexOf("resolve-image-digest")).toBeLessThan(phases.indexOf("workers-create"));
    const build = f.calls.find(command => command.phase === "build-image")!;
    expect(build.args).toContain("--no-logs");
    expect(build.args.some(argument => /^SOURCE_FINGERPRINT=[a-f0-9]{64}$/.test(argument))).toBe(true);
    expect(result.image).toBe(`approvedregistry.azurecr.io/monitoring@${digest}`);
  });

  it.each(["tenant", "identity", "environment", "what-if"] as const)("fails %s preflight before any Azure mutations", async fault => {
    const f = await fixture();
    f.hook.run = command => {
      if (fault === "tenant" && command.phase === "azure-account") return JSON.stringify({ id: f.document.healthModel.subscriptionId, tenantId: "22222222-2222-4222-8222-222222222222" });
      if (fault === "identity" && command.phase === "identity-binding") return JSON.stringify({ ...[...f.identities.values()][0], clientId: "22222222-2222-4222-8222-222222222222" });
      if (fault === "environment" && command.phase === "environment-binding") return JSON.stringify({ id: f.document.deployment!.foundation.mode === "existing" ? f.document.deployment!.foundation.environmentResourceId : "", location: "uksouth" });
      if (fault === "what-if" && command.phase === "models-what-if") return JSON.stringify({ status: "Failed" });
    };
    await expect(f.execute()).rejects.toThrow();
    expect(f.calls.some(command => /-create$|build-image|^retire-obsolete/.test(command.phase))).toBe(false);
  });

  it("preserves one actual Teams callback owner and accepts empty Bot MessagingEndpoints", async () => {
    const f = await fixture();
    f.document.deployment!.enableLiveProbes = true;
    const teams = f.document.tenants[0]!.services.teams;
    teams.execution.mode = "live";
    teams.execution.teamsCallingCallbackUrl = `https://${teams.worker!.appName}.approved.invalid/api/calls`;
    const peerId = `${f.base}/Microsoft.ManagedIdentity/userAssignedIdentities/peer-identity`;
    teams.access = {
      botResourceId: `${f.base}/Microsoft.BotService/botServices/primary-bot`,
      botPeerResourceId: `${f.base}/Microsoft.BotService/botServices/peer-bot`,
      botPeerClientId: teams.callTargets[0]!.peerBotClientId, botPeerManagedIdentityResourceId: peerId,
    };
    f.identities.set(peerId.toLowerCase(), {
      id: peerId, clientId: teams.access.botPeerClientId!, principalId: teams.access.botPeerClientId!,
      tenantId: f.document.deployment!.azureTenantId,
    });
    await f.execute();
    expect(f.calls.filter(command => command.phase === "bot-binding")).toHaveLength(2);
    expect(f.calls.filter(command => command.phase === "bot-binding").every(command => command.args.includes("get"))).toBe(true);
    expect(f.calls.filter(command => command.phase === "verify-rollout")).toHaveLength(3);
  });

  it("surfaces unhealthy rollout and bounds every readiness call by the remaining deadline", async () => {
    const f = await fixture();
    let clock = 0;
    f.hook.run = command => command.phase === "verify-rollout" ? JSON.stringify({
      latestRevisionName: "new", latestReadyRevisionName: "old", provisioningState: "Succeeded",
    }) : undefined;
    await expect(f.execute({ now: () => clock, sleep: async milliseconds => { clock += milliseconds; } })).rejects.toThrow("deadline");
    expect(f.calls.filter(command => command.phase === "verify-rollout").every(command => command.timeoutSeconds <= 30)).toBe(true);
    expect(f.emit.mock.calls.at(-1)?.[0]).toMatchObject({ event: "monitoring-deployment-failed", remoteMayStillRun: true });
  });

  it("skips already-absent explicit obsolete entities and never replays server-owned definitions", async () => {
    const f = await fixture();
    f.document.deployment!.retireEntities = [{ service: "exchange", entityName: "obsolete-attachment-reply-step" }];
    await f.execute();
    expect(f.calls.some(command => command.phase === "retirement-preflight-entities")).toBe(true);
    expect(f.calls.some(command => command.phase === "retire-obsolete-entity")).toBe(false);
    expect(f.calls.some(command => command.tool === "az" && command.args.includes("put"))).toBe(false);
  });

  it("protects environment-supplied certificate material and removes secure parameters after failure", async () => {
    const f = await fixture();
    const certificate = "-----BEGIN CERTIFICATE-----\nunit-test-only\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nunit-test-only\n-----END PRIVATE KEY-----";
    f.document.deployment!.enableLiveProbes = true;
    const exchange = f.document.tenants[0]!.services.exchange;
    exchange.execution.mode = "live";
    exchange.execution.graphAuthentication = "certificate";
    for (const target of exchange.targets) target.replySeed = {
      messageId: `received-${target.id}`, correlationId: "33333333-3333-4333-8333-333333333333",
    };
    exchange.access = {
      m365TenantId: f.document.tenants[0]!.tenantId, m365ClientId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      m365CertificateSource: "container-app", m365CertificateEnvironmentVariable: "APPROVED_PEM",
      m365CertificateRevision: createHash("sha256").update(certificate).digest("hex"),
    };
    let securePath = "";
    f.hook.run = async command => {
      if (command.phase !== "foundation-what-if") return;
      securePath = command.args.find(argument => argument.endsWith("certificates.parameters.json"))!.slice(1);
      expect((await stat(securePath)).mode & 0o777).toBe(0o600);
      expect(await readFile(securePath, "utf8")).toContain("unit-test-only");
      throw new DeploymentCommandError(command.phase, "failed", 1);
    };
    await expect(f.execute({ env: { APPROVED_PEM: certificate } })).rejects.toThrow("foundation-what-if");
    expect(securePath).not.toBe("");
    await expect(stat(securePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(f.emit.mock.calls)).not.toContain("unit-test-only");
    expect(f.calls.some(command => command.phase.endsWith("-create"))).toBe(false);
  });
});
