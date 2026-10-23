import { mkdir, rm, writeFile } from "node:fs/promises";
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
  project.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
  for (const type of ["exchange", "teams", "sharepoint"] as const) {
    project.services[type].configFile = `profiles/${type}.json`;
    await writeFile(join(directory, project.services[type].configFile), JSON.stringify(await readServiceConfig(`${type}/config.json`)));
  }
  await writeFile(projectFile, JSON.stringify(project));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("deployment parameter preparation", () => {
  it("preserves the explicit readback application in the mounted Teams service config without credentials", async () => {
    const teamsReadbackClientId = "77777777-7777-4777-8777-777777777777";
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify({
      ...await readServiceConfig("teams/config.live.example.json"), teamsReadbackClientId,
    }));
    const prepared = await prepareDeploymentParameters(projectFile, "image:test", true);
    expect(prepared.parameters.serviceConfigs.value.teams.teamsReadbackClientId).toBe(teamsReadbackClientId);
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
  it("requires explicit bot certificate selection and complete hosted access metadata", async () => {
    const service = { ...await readServiceConfig("teams/config.live.example.json"), botAuthentication: "certificate" };
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify(service));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true)).rejects.toThrow("bot certificate settings");
    const accessFile = join(directory, "access.json");
    const access = { teams: {
      botTenantId: "11111111-1111-4111-8111-111111111111",
      botClientId: "22222222-2222-4222-8222-222222222222",
      botCertificateSecretUri: "https://probe.vault.azure.net/secrets/bot-pem",
    } };
    await writeFile(accessFile, JSON.stringify(access));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true, accessFile)).rejects.toThrow("target and bot tenants");
    const project = await readProjectConfig(projectFile);
    for (const target of [...project.services.teams.targets, ...project.services.teams.callTargets]) target.tenantId = access.teams.botTenantId;
    await writeFile(projectFile, JSON.stringify(project));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true, accessFile)).resolves.toBeDefined();
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify({ ...service, botAuthentication: "managed-identity" }));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true, accessFile)).rejects.toThrow("botAuthentication: certificate");
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
  async function delegatedProfile() {
    const service = { ...await readServiceConfig("teams/config.live.example.json"), teamsAuthentication: "user-delegated", serviceHealth: false };
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify(service));
    const project = await readProjectConfig(projectFile);
    project.services.teams.targets = [{
      id: "teams-001", tenantId: "22222222-2222-4222-8222-222222222222",
      userPrincipalName: "test@example.invalid", teamId: "33333333-3333-4333-8333-333333333333",
      channelId: "standard-channel",
    }];
    await writeFile(projectFile, JSON.stringify(project));
    return join(directory, "access.json");
  }
  it("allows delegated foundation before bootstrap and requires public-client metadata for workers", async () => {
    const accessFile = await delegatedProfile();
    expect((await prepareDeploymentParameters(projectFile)).parameters.deployWorkers.value).toBe(false);
    await expect(prepareDeploymentParameters(projectFile, "image:test", true)).rejects.toThrow("teamsPublicClientId");
    const access = { teams: { teamsPublicClientId: "44444444-4444-4444-8444-444444444444" } };
    await writeFile(accessFile, JSON.stringify(access));
    const prepared = await prepareDeploymentParameters(projectFile, "image:test", true, accessFile);
    expect(prepared.parameters.serviceAccess.value).toEqual(access);
    expect(prepared.parameters.serviceConfigs.value.teams.teamsAuthentication).toBe("user-delegated");
  });
  it("requires separate application certificate metadata only when delegated Teams providers use it", async () => {
    const accessFile = await delegatedProfile();
    const service = { ...await readServiceConfig(join(directory, "profiles/teams.json")), graphAuthentication: "certificate" };
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify(service));
    await writeFile(accessFile, JSON.stringify({ teams: { teamsPublicClientId: "44444444-4444-4444-8444-444444444444" } }));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true, accessFile)).resolves.toBeDefined();
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify({ ...service, serviceHealth: true }));
    await expect(prepareDeploymentParameters(projectFile, "image:test", true, accessFile)).rejects.toThrow("M365 application settings");
  });
  it("rejects unselected public-client metadata, bot fallback and embedded cache content", async () => {
    const accessFile = await delegatedProfile();
    for (const access of [
      { exchange: { teamsPublicClientId: "44444444-4444-4444-8444-444444444444" } },
      { teams: { cache: "must-not-be-in-config" } },
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
      "deployWorkers", "enableLiveProbes", "projectConfig", "serviceAccess", "serviceConfigs", "workerImage",
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
    await expect(prepareDeploymentParameters(projectFile, undefined, false, accessFile)).rejects.toThrow("access requires");
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
  it("rejects mismatched Teams application, bot, and target tenants", async () => {
    const teams = { ...await readServiceConfig("teams/config.live.example.json"), teamsAuthentication: "bot", botAuthentication: "certificate", graphAuthentication: "certificate" };
    await writeFile(join(directory, "profiles/teams.json"), JSON.stringify(teams));
    const accessFile = join(directory, "access.json");
    const teamsAccess = {
      m365TenantId: "22222222-2222-4222-8222-222222222222",
      m365ClientId: "33333333-3333-4333-8333-333333333333",
      m365CertificateSecretUri: "https://probe.vault.azure.net/secrets/teams-pem",
      botTenantId: "44444444-4444-4444-8444-444444444444",
      botClientId: "55555555-5555-4555-8555-555555555555",
      botCertificateSecretUri: "https://probe.vault.azure.net/secrets/bot-pem",
    };
    await writeFile(accessFile, JSON.stringify({ teams: teamsAccess }));
    await expect(prepareDeploymentParameters(projectFile, undefined, false, accessFile)).rejects.toThrow("bot and M365");
    await writeFile(accessFile, JSON.stringify({ teams: { ...teamsAccess, botTenantId: teamsAccess.m365TenantId } }));
    await expect(prepareDeploymentParameters(projectFile, undefined, false, accessFile)).rejects.toThrow("target and M365");
    const project = await readProjectConfig(projectFile);
    for (const target of [...project.services.teams.targets, ...project.services.teams.callTargets]) target.tenantId = teamsAccess.m365TenantId;
    await writeFile(projectFile, JSON.stringify(project));
    const parameters = await prepareDeploymentParameters(projectFile, "image:test", true, accessFile);
    expect(parameters.parameters.serviceAccess.value.teams?.botCertificateSecretUri).toBe(teamsAccess.botCertificateSecretUri);
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
      .toEqual({ projectFile: "root.json", outputFile: "out.json", workerImage: "image:test", enableLiveProbes: true, accessFile: "access.json" });
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
