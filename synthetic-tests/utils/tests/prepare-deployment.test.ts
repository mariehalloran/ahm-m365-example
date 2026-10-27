import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDeploymentArguments, prepareDeploymentParameters } from "../src/prepare-deployment.js";
import { readProjectConfig } from "../src/project-config.js";
import { readServiceConfig } from "../src/service-config.js";

let directory: string;
let projectFile: string;
const checkedIn = await readProjectConfig("../monitoring.config.json");
beforeEach(async () => {
  directory = `.deployment-test-${randomUUID()}`;
  await mkdir(directory);
  projectFile = join(directory, "monitoring.json");
  await mkdir(join(directory, "profiles"));
  const project = structuredClone(checkedIn);
  project.serviceHealth.enabled = true;
  project.services.teams.scenarios["scheduled-meeting"] = false;
  project.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
  for (const type of ["exchange", "teams", "onedrive"] as const) {
    project.services[type].configFile = `profiles/${type}.json`;
    await writeFile(join(directory, project.services[type].configFile), JSON.stringify(await readServiceConfig(`${type}/config.json`)));
  }
  await writeFile(projectFile, JSON.stringify(project));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("deployment parameter preparation", () => {
  it.each(["omitted", "disabled"])("disables mounted provider settings and beta consent when Service Health is %s", async mode => {
    const project = JSON.parse(await readFile(projectFile, "utf8"));
    if (mode === "omitted") delete project.serviceHealth;
    else project.serviceHealth = { enabled: false };
    await writeFile(projectFile, JSON.stringify(project));
    await writeFile(join(directory, "profiles/exchange.json"), JSON.stringify({
      ...await readServiceConfig("exchange/config.json"), serviceHealth: true, serviceActivity: { enabled: true },
    }));
    const prepared = await prepareDeploymentParameters(projectFile, "image:test");
    expect(prepared.parameters.projectConfig.value.serviceHealth.enabled).toBe(false);
    expect(prepared.parameters.serviceConfigs.value.exchange.serviceHealth).toBe(false);
    expect(prepared.parameters.serviceConfigs.value.exchange.serviceActivity.enabled).toBe(false);
    expect(prepared.parameters.enableBetaServiceActivity.value).toBe(false);
  });
  const peer = {
    botPeerClientId: checkedIn.services.teams.callTargets[0]!.peerBotClientId,
    botPeerManagedIdentityResourceId: "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/approved/providers/Microsoft.ManagedIdentity/userAssignedIdentities/teams-peer",
  };
  async function callingProfile() {
    const project = JSON.parse(await readFile(projectFile, "utf8"));
    project.services.teams.scenarios["scheduled-meeting"] = true;
    await writeFile(projectFile, JSON.stringify(project));
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify({
      ...await readServiceConfig("teams/config.live.example.json"),
      teamsCallingCallbackUrl: "https://approved.example.invalid/api/calls",
    }));
    return project;
  }
  it("packages only approved existing peer MI metadata with the selected live meeting profile", async () => {
    await callingProfile();
    await expect(prepareDeploymentParameters(projectFile, "image:test", true)).rejects.toThrow("existing approved peer UAMI");
    const accessFile = join(directory, "peer.json");
    await writeFile(accessFile, JSON.stringify({ teams: peer }));
    const prepared = await prepareDeploymentParameters(projectFile, "image:test", true, accessFile);
    expect(prepared.parameters.serviceAccess.value).toEqual({ teams: peer });
    expect(prepared.parameters.projectConfig.value.services.teams.callTargets[0]?.peerBotClientId).toBe(peer.botPeerClientId);
    expect(prepared.parameters.serviceConfigs.value.teams).not.toHaveProperty("botPeerClientId");
  });
  it.each([
    { botPeerClientId: peer.botPeerClientId },
    { botPeerManagedIdentityResourceId: peer.botPeerManagedIdentityResourceId },
    { ...peer, botPeerClientId: "77777777-7777-4777-8777-777777777777" },
    { ...peer, botPeerManagedIdentityResourceId: "/not-an-identity" },
  ])("rejects incomplete, invalid or non-allowlisted peer access %j", async metadata => {
    await callingProfile();
    const accessFile = join(directory, "peer.json");
    await writeFile(accessFile, JSON.stringify({ teams: metadata }));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true, accessFile)).rejects.toThrow();
  });
  it.each(["exchange", "teams", "onedrive"])("never attaches a peer for disabled/non-Teams calling: %s", async type => {
    const accessFile = join(directory, "peer.json");
    await writeFile(accessFile, JSON.stringify({ [type]: peer }));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true, accessFile)).rejects.toThrow("needs the peer bot");
  });
  it("packages an independently hosted live OneDrive MI worker with root-owned accounts and selected-folder bindings", async () => {
    const onedrive = await readServiceConfig("onedrive/config.live.example.json");
    await writeFile(join(directory, "profiles/onedrive.json"), JSON.stringify(onedrive));
    await expect(prepareDeploymentParameters(projectFile, "image:test")).rejects.toThrow("--enable-live");
    const prepared = await prepareDeploymentParameters(projectFile, "image:test", true);
    expect(prepared.parameters.serviceConfigs.value.onedrive).toMatchObject({
      type: "onedrive", mode: "live", graphAuthentication: "managed-identity", serviceHealth: true,
    });
    expect(prepared.parameters.serviceConfigs.value.onedrive).not.toHaveProperty("targets");
    expect(prepared.parameters.projectConfig.value.services.onedrive.targets).toHaveLength(2);
    expect(prepared.parameters.projectConfig.value.services).not.toHaveProperty("sharepoint");
    expect(prepared.parameters.serviceAccess.value).toEqual({});
  });
  it("preserves all 500 provisioned OneDrive accounts and their execution budgets in worker deployment parameters", async () => {
    const project = await readProjectConfig(projectFile);
    project.healthModel.reportTtlMinutes = 75;
    project.services.onedrive.targets = Array.from({ length: 500 }, (_, index) => ({
      id: `account-${index}`, userId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
      userPrincipalName: `account-${index}@example.invalid`, folderName: "AHM-Synthetic-Tests",
      driveId: `drive-${index}`, folderId: `folder-${index}`,
    }));
    await writeFile(projectFile, JSON.stringify(project));
    await writeFile(join(directory, "profiles/onedrive.json"), JSON.stringify({
      ...await readServiceConfig("onedrive/config.live.example.json"),
      maxConcurrentProbes: 20, cycleTimeoutSeconds: 3600,
    }));
    const prepared = await prepareDeploymentParameters(projectFile, "image:test", true);
    expect(prepared.parameters.projectConfig.value.services.onedrive.targets).toEqual(project.services.onedrive.targets);
    expect(prepared.parameters.serviceConfigs.value.onedrive).toMatchObject({
      maxConcurrentProbes: 20, cycleTimeoutSeconds: 3600,
    });
    expect(prepared.parameters.serviceConfigs.value.onedrive).not.toHaveProperty("targets");
  });
  it("requires migration of legacy private profiles rather than injecting an unselected service", async () => {
    const project = JSON.parse(await readFile(projectFile, "utf8"));
    delete project.services.onedrive;
    await writeFile(projectFile, JSON.stringify(project));
    await expect(prepareDeploymentParameters(projectFile, "image:test")).rejects.toThrow("services.onedrive");
  });
  it("requires explicit beta deployment approval and preserves the provider cadence/functions/thresholds", async () => {
    await writeFile(join(directory, "profiles/exchange.json"), JSON.stringify({
      ...await readServiceConfig("exchange/config.json"), providerIntervalSeconds: 300,
      serviceActivity: {
        enabled: true, maxAgeMinutes: 60,
        thresholds: { getConnectivityMetricsForExchange: { degradedBelow: 99, unhealthyBelow: 95 } },
      },
    }));
    await expect(prepareDeploymentParameters(projectFile, "image:test")).rejects.toThrow("--enable-beta-service-activity");
    const parameters = await prepareDeploymentParameters(projectFile, "image:test", false, undefined, true);
    expect(parameters.parameters.enableBetaServiceActivity.value).toBe(true);
    expect(parameters.parameters.serviceConfigs.value.exchange).toMatchObject({
      providerIntervalSeconds: 300,
      serviceActivity: { enabled: true, thresholds: { getConnectivityMetricsForExchange: { degradedBelow: 99, unhealthyBelow: 95 } } },
    });
    expect(parseDeploymentArguments(["root.json", "out.json", "image:test", "--enable-live", "--enable-beta-service-activity"]))
      .toMatchObject({ enableLiveProbes: true, enableBetaServiceActivity: true });
  });
  it("mounts execution lane settings and explicit Exchange participants without moving root-owned selection", async () => {
    const executionLanes = [
      { name: "mail", intervalSeconds: 60, timeoutSeconds: 45, journeys: ["send-receive-mail"] },
      { name: "extended", intervalSeconds: 300, timeoutSeconds: 120, journeys: [
        "edit-reopen-draft", "attachment-mail", "reply-mail", "distribution-list-mail", "recurring-calendar", "meeting-invitation",
      ] },
    ];
    await writeFile(join(directory, "profiles/exchange.json"), JSON.stringify({
      ...await readServiceConfig("exchange/config.json"), executionLanes,
      providerClientId: "88888888-8888-4888-8888-888888888888",
    }));
    const prepared = await prepareDeploymentParameters(projectFile, "image:test");
    expect(prepared.parameters.serviceConfigs.value.exchange.executionLanes).toEqual(executionLanes);
    expect(prepared.parameters.serviceConfigs.value.exchange.providerClientId).toBe("88888888-8888-4888-8888-888888888888");
    expect(prepared.parameters.projectConfig.value.services.exchange.targets[0]).toMatchObject({
      recipientMailbox: "dedicated-recipient@example.invalid",
      distributionList: { expectedRecipients: ["dedicated-synthetic@example.invalid", "dedicated-recipient@example.invalid"] },
    });
    expect(prepared.parameters.serviceConfigs.value.exchange).not.toHaveProperty("targets");
    expect(prepared.parameters.projectConfig.value.services.exchange).not.toHaveProperty("executionLanes");
  });
  it("preserves the explicit readback application in the mounted Teams service config without credentials", async () => {
    const teamsReadbackClientId = "77777777-7777-4777-8777-777777777777";
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify({
      ...await readServiceConfig("teams/config.live.example.json"), teamsReadbackClientId,
      providerClientId: "88888888-8888-4888-8888-888888888888",
    }));
    const prepared = await prepareDeploymentParameters(projectFile, "image:test", true);
    expect(prepared.parameters.serviceConfigs.value.teams.teamsReadbackClientId).toBe(teamsReadbackClientId);
    expect(prepared.parameters.serviceConfigs.value.teams.providerClientId).toBe("88888888-8888-4888-8888-888888888888");
    expect(prepared.parameters.projectConfig.value.services.teams).not.toHaveProperty("teamsReadbackClientId");
    expect(prepared.parameters.serviceAccess.value).toEqual({});
  });
  it("packages default live MI bot workers without public-client/cache/certificate metadata", async () => {
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify(await readServiceConfig("teams/config.live.example.json")));
    const prepared = await prepareDeploymentParameters(projectFile, "image:test", true);
    expect(prepared.parameters.serviceConfigs.value.teams).toMatchObject({
      teamsAuthentication: "bot", botAuthentication: "managed-identity",
      teamsCleanupEnabled: true, exchangeCleanupEnabled: true,
    });
    expect(prepared.parameters.serviceAccess.value).toEqual({});
    expect(prepared.parameters.projectConfig.value.services.teams.targets).toHaveLength(1);
    expect(prepared.parameters.projectConfig.value.services.teams.targets[0]).not.toHaveProperty("userPrincipalName");
  });
  it("rejects removed bot certificate authentication", async () => {
    const service = { ...await readServiceConfig("teams/config.live.example.json"), botAuthentication: "certificate" };
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify(service));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true)).rejects.toThrow("botAuthentication");
  });
  it("preserves Exchange retention in the selected service profile, not the root targets", async () => {
    const exchange = { ...await readServiceConfig("exchange/config.json"), exchangeCleanupEnabled: false };
    await writeFile(join(directory, "profiles/exchange.json"), JSON.stringify(exchange));
    const prepared = await prepareDeploymentParameters(projectFile, "image:test");
    expect(prepared.parameters.serviceConfigs.value.exchange.exchangeCleanupEnabled).toBe(false);
    expect(prepared.parameters.projectConfig.value.services.exchange).not.toHaveProperty("exchangeCleanupEnabled");
  });
  it("preserves Teams retention in the mounted service profile without copying it into root targets", async () => {
    const teams = { ...await readServiceConfig("teams/config.json"), teamsCleanupEnabled: false };
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify(teams));
    const prepared = await prepareDeploymentParameters(projectFile, "image:test");
    expect(prepared.parameters.serviceConfigs.value.teams.teamsCleanupEnabled).toBe(false);
    expect(prepared.parameters.projectConfig.value.services.teams).not.toHaveProperty("teamsCleanupEnabled");
  });
  it("rejects removed public-client metadata, bot certificates, SharePoint and embedded cache content", async () => {
    const accessFile = join(directory, "access.json");
    for (const access of [
      { exchange: { teamsPublicClientId: "44444444-4444-4444-8444-444444444444" } },
      { teams: { cache: "must-not-be-in-config" } },
      { sharepoint: {} },
      { teams: {
        botTenantId: "22222222-2222-4222-8222-222222222222",
        botClientId: "44444444-4444-4444-8444-444444444444",
        botCertificateSecretUri: "https://approved.vault.azure.net/secrets/bot",
      } },
    ]) {
      await writeFile(accessFile, JSON.stringify(access));
      await expect(prepareDeploymentParameters(projectFile, undefined, false, accessFile)).rejects.toThrow();
    }
  });
  it("resolves service files relative to the private root config without duplicating root fields", async () => {
    const parameters = await prepareDeploymentParameters(projectFile);
    expect(parameters.parameters.deployWorkers.value).toBe(false);
    expect(parameters.parameters.enableLiveProbes.value).toBe(false);
    expect(Object.keys(parameters.parameters).sort()).toEqual([
      "deployWorkers", "enableBetaServiceActivity", "enableLiveProbes", "projectConfig", "serviceAccess", "serviceConfigs", "workerImage",
    ]);
    for (const profile of Object.values(parameters.parameters.serviceConfigs.value)) {
      expect(profile.mode).toBe("simulation");
      for (const key of ["enabled", "targets", "telemetry"]) expect(profile).not.toHaveProperty(key);
    }
  });
  it("requires a separate live-deployment opt-in instead of silently enabling M365 operations", async () => {
    const exchange = await readServiceConfig("exchange/config.live.example.json");
    await writeFile(join(directory, "profiles/exchange.json"), JSON.stringify(exchange));
    const image = "example.azurecr.io/m365-synthetic:test";
    await expect(prepareDeploymentParameters(projectFile, image)).rejects.toThrow("explicit --enable-live");
    const parameters = await prepareDeploymentParameters(projectFile, image, true);
    expect(parameters.parameters.enableLiveProbes.value).toBe(true);
    expect(parameters.parameters.deployWorkers.value).toBe(true);
  });
  it("rejects a service-file type mismatch before preparing cloud parameters", async () => {
    await writeFile(join(directory, "profiles/exchange.json"), JSON.stringify(await readServiceConfig("teams/config.json")));
    await expect(prepareDeploymentParameters(projectFile)).rejects.toThrow("requires a exchange service config");
  });
  it("rejects missing deployment destinations and empty image references", async () => {
    await expect(prepareDeploymentParameters(projectFile, "")).rejects.toThrow("nonempty image reference");
    await writeFile(projectFile, JSON.stringify(checkedIn));
    await expect(prepareDeploymentParameters(projectFile)).rejects.toThrow("approved healthModel.subscriptionId");
  });
  it("requires complete hosted M365 certificate settings without replacing the Azure identity", async () => {
    const exchange = { ...await readServiceConfig("exchange/config.live.example.json"), graphAuthentication: "certificate" };
    await writeFile(join(directory, "profiles/exchange.json"), JSON.stringify(exchange));
    const image = "example.azurecr.io/m365-synthetic:test";
    await expect(prepareDeploymentParameters(projectFile, image, true)).rejects.toThrow("--access-config");
    const accessFile = join(directory, "access.json");
    const access = {
      exchange: {
        m365TenantId: "22222222-2222-4222-8222-222222222222",
        m365ClientId: "33333333-3333-4333-8333-333333333333",
        m365CertificateSecretUri: "https://probe.vault.azure.net/secrets/exchange-pem/version1",
      },
    };
    await writeFile(accessFile, JSON.stringify(access));
    const parameters = await prepareDeploymentParameters(projectFile, image, true, accessFile);
    expect(parameters.parameters.serviceAccess.value).toEqual(access);
    expect(parameters.parameters.serviceConfigs.value.exchange).toMatchObject({
      graphAuthentication: "certificate", healthReportAuthentication: "managed-identity",
    });
    expect(parameters.parameters.projectConfig.value.healthModel.subscriptionId).toBe("11111111-1111-4111-8111-111111111111");
  });
  it("rejects certificate report credentials for hosted workers", async () => {
    const exchange = { ...await readServiceConfig("exchange/config.live.example.json"), healthReportAuthentication: "certificate" };
    await writeFile(join(directory, "profiles/exchange.json"), JSON.stringify(exchange));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true)).rejects.toThrow("Hosted workers require");
  });
  it("prepares an explicitly approved native certificate without embedding credential contents", async () => {
    const exchange = { ...await readServiceConfig("exchange/config.live.example.json"), graphAuthentication: "certificate" };
    await writeFile(join(directory, "profiles/exchange.json"), JSON.stringify(exchange));
    const accessFile = join(directory, "access.json");
    const access = { exchange: {
      m365TenantId: "22222222-2222-4222-8222-222222222222",
      m365ClientId: "33333333-3333-4333-8333-333333333333",
      m365CertificateSource: "container-app",
      m365CertificateRevision: "a".repeat(64),
    } };
    await writeFile(accessFile, JSON.stringify(access));
    const prepared = await prepareDeploymentParameters(projectFile, "image:test", true, accessFile);
    expect(prepared.parameters.serviceAccess.value).toEqual(access);
    expect(prepared.parameters).not.toHaveProperty("serviceCertificates");
    expect(JSON.stringify(prepared)).not.toContain("PRIVATE KEY");
    await writeFile(accessFile, JSON.stringify({ exchange: { ...access.exchange, m365CertificateRevision: undefined } }));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true, accessFile)).rejects.toThrow("access requires");
    await writeFile(accessFile, JSON.stringify({ exchange: {
      ...access.exchange, m365CertificateSecretUri: "https://probe.vault.azure.net/secrets/exchange-pem",
    } }));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true, accessFile)).rejects.toThrow("only one source");
    await writeFile(accessFile, JSON.stringify({ exchange: {
      ...access.exchange, m365CertificateSource: "key-vault",
      m365CertificateSecretUri: "https://probe.vault.azure.net/secrets/exchange-pem",
    } }));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true, accessFile)).rejects.toThrow("revision requires");
  });
  it.each([
    { exchange: { m365TenantId: "22222222-2222-4222-8222-222222222222" } },
    { exchange: { botTenantId: "22222222-2222-4222-8222-222222222222", botClientId: "33333333-3333-4333-8333-333333333333", botCertificateSecretUri: "https://probe.vault.azure.net/secrets/bot-pem" } },
    { teams: { botClientId: "33333333-3333-4333-8333-333333333333" } },
  ])("rejects partial or misplaced application metadata %j", async access => {
    const accessFile = join(directory, "access.json");
    await writeFile(accessFile, JSON.stringify(access));
    await expect(prepareDeploymentParameters(projectFile, undefined, false, accessFile)).rejects.toThrow();
  });
  it.each([
    "https://probe.vault.azure.net/secrets/cert?token=secret",
    "http://probe.vault.azure.net/secrets/cert",
    "https://other.example/secrets/cert",
  ])("rejects unapproved Key Vault references without leaking their values", async uri => {
    const accessFile = join(directory, "access.json");
    await writeFile(accessFile, JSON.stringify({ exchange: { m365CertificateSecretUri: uri } }));
    const result = prepareDeploymentParameters(projectFile, undefined, false, accessFile);
    await expect(result).rejects.toThrow("exchange.m365CertificateSecretUri");
    await expect(result).rejects.not.toThrow(uri);
  });
  it("rejects inline credentials and application settings ignored by managed-identity mode", async () => {
    const accessFile = join(directory, "access.json");
    await writeFile(accessFile, JSON.stringify({ exchange: { privateKey: "do-not-accept" } }));
    await expect(prepareDeploymentParameters(projectFile, undefined, false, accessFile)).rejects.toThrow("Invalid service access config fields: exchange");
    await writeFile(accessFile, JSON.stringify({ exchange: {
      m365TenantId: "22222222-2222-4222-8222-222222222222",
      m365ClientId: "33333333-3333-4333-8333-333333333333",
      m365CertificateSecretUri: "https://probe.vault.azure.net/secrets/exchange-pem",
    } }));
    await expect(prepareDeploymentParameters(projectFile, undefined, false, accessFile)).rejects.toThrow("graphAuthentication: certificate");
  });
  it("rejects mismatched Teams Graph observer and target tenants without changing bot authentication", async () => {
    const teams = { ...await readServiceConfig("teams/config.live.example.json"), graphAuthentication: "certificate" };
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify(teams));
    const accessFile = join(directory, "access.json");
    const teamsAccess = {
      m365TenantId: "22222222-2222-4222-8222-222222222222",
      m365ClientId: "33333333-3333-4333-8333-333333333333",
      m365CertificateSecretUri: "https://probe.vault.azure.net/secrets/teams-pem",
    };
    await writeFile(accessFile, JSON.stringify({ teams: teamsAccess }));
    await expect(prepareDeploymentParameters(projectFile, undefined, false, accessFile)).rejects.toThrow("target and M365");
    const project = await readProjectConfig(projectFile);
    for (const target of [...project.services.teams.targets, ...project.services.teams.callTargets]) target.tenantId = teamsAccess.m365TenantId;
    await writeFile(projectFile, JSON.stringify(project));
    const parameters = await prepareDeploymentParameters(projectFile, "image:test", true, accessFile);
    expect(parameters.parameters.serviceAccess.value.teams?.m365ClientId).toBe(teamsAccess.m365ClientId);
    expect(parameters.parameters.serviceConfigs.value.teams.botAuthentication).toBe("managed-identity");
  });
  it("reports unreadable, malformed, and invalid access files explicitly", async () => {
    const accessFile = join(directory, "access.json");
    await expect(prepareDeploymentParameters(projectFile, undefined, false, accessFile)).rejects.toThrow("Cannot read");
    await writeFile(accessFile, "{");
    await expect(prepareDeploymentParameters(projectFile, undefined, false, accessFile)).rejects.toThrow("valid JSON");
    await writeFile(accessFile, "[]");
    await expect(prepareDeploymentParameters(projectFile, undefined, false, accessFile)).rejects.toThrow("(root)");
  });
});

describe("deployment argument parsing", () => {
  it("accepts existing invocations and access metadata without enabling live execution implicitly", () => {
    expect(parseDeploymentArguments(["root.json", "out.json"])).toMatchObject({ enableLiveProbes: false, workerImage: undefined });
    expect(parseDeploymentArguments(["root.json", "out.json", "image:test", "--enable-live", "--access-config", "access.json"]))
      .toEqual({ projectFile: "root.json", outputFile: "out.json", workerImage: "image:test", enableLiveProbes: true, enableBetaServiceActivity: false, accessFile: "access.json" });
    expect(parseDeploymentArguments(["root.json", "out.json", "--access-config", "access.json"])).toMatchObject({
      accessFile: "access.json", workerImage: undefined, enableLiveProbes: false,
    });
  });
  it.each([
    [], ["root.json"], ["root.json", "out.json", "--unknown"],
    ["root.json", "out.json", "--access-config"],
    ["root.json", "out.json", "--access-config", "--enable-live"],
    ["root.json", "out.json", "--enable-live", "--enable-live"],
    ["root.json", "out.json", "image:one", "image:two"],
    ["root.json", "out.json", "--access-config", "one", "--access-config", "two"],
  ])("rejects invalid arguments %j", (...args) => {
    expect(() => parseDeploymentArguments(args)).toThrow("Usage:");
  });
});
