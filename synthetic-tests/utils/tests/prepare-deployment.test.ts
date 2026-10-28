import { describe, expect, it } from "vitest";
import { reportingGroups } from "../src/groups.js";
import { prepareProjectDeployment } from "../src/prepare-deployment.js";
import { parseProjectDocument } from "../src/project-config.js";
import { serviceProbes } from "../src/service-config.js";
import { documentFixture, fixtureTenantId, multiTenantFixture } from "./fixtures.js";

const digest = `approved.azurecr.io/synthetic@sha256:${"a".repeat(64)}`;
const providers = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-m365-demo/providers";
const identities = `${providers}/Microsoft.ManagedIdentity/userAssignedIdentities`;

describe("single-document deployment preparation", () => {
  it("derives one worker per tenant and service, each over its tenant's whole inventory", () => {
    const source = multiTenantFixture();
    const prepared = prepareProjectDeployment(source, digest);
    expect(prepared.workers.map(worker => `${worker.tenant}/${worker.type}/${worker.appName}`)).toEqual([
      "contoso/exchange/contoso-exchange", "contoso/teams/contoso-teams", "contoso/onedrive/contoso-onedrive",
      "fabrikam/exchange/fabrikam-exchange", "fabrikam/teams/fabrikam-teams", "fabrikam/onedrive/fabrikam-onedrive",
    ]);
    expect(prepared.modelNames).toEqual([
      "m365-experience-poc", "m365-experience-poc-exchange", "m365-experience-poc-teams", "m365-experience-poc-onedrive",
    ]);
    for (const worker of prepared.workers) {
      expect(Object.keys(worker).sort()).toEqual(["appName", "identityResourceId", "project", "service", "tenant", "type"]);
      expect(worker.project.tenant.id).toBe(worker.tenant);
      expect(worker.service.targets).toEqual(source.tenants.find(tenant => tenant.id === worker.tenant)!.services[worker.type].targets);
    }
    const fabrikamExchange = prepared.workers.find(worker => worker.tenant === "fabrikam" && worker.type === "exchange")!;
    expect(fabrikamExchange.service.targets.map(target => target.id)).toEqual(["pair-a", "pair-b"]);
    expect(fabrikamExchange.identityResourceId).toBe(`${identities}/uami-fabrikam-exchange`);
  });

  it("passes the whole normalized document and the flat reporting groups to the Bicep parameters", () => {
    const source = multiTenantFixture();
    const prepared = prepareProjectDeployment(source, digest);
    expect(Object.keys(prepared.healthParameters.parameters).sort())
      .toEqual(["applicationInsightsName", "location", "projectConfig", "reportingGroups", "workspaceName"]);
    expect(Object.keys(prepared.workerParameters.parameters).sort())
      .toEqual(["deployWorkers", "location", "projectConfig", "workerImage"]);
    expect(prepared.healthParameters.parameters.projectConfig!.value).toEqual(source);
    expect(prepared.workerParameters.parameters.projectConfig!.value).toEqual(source);
    expect(prepared.healthParameters.parameters.reportingGroups!.value).toEqual(reportingGroups(source));
    expect(prepared.reportingGroups.map(group => group.id)).toEqual(["priority", "field", "bridge"]);
    expect(prepared.workerParameters.parameters.workerImage!.value).toBe(digest);
    expect(prepared.workerParameters.parameters.deployWorkers!.value).toBe(true);
  });

  it("normalizes a raw document before planning, so schema defaults reach both parameter sets", () => {
    const { groups: _groups, ...raw } = documentFixture();
    const prepared = prepareProjectDeployment(raw);
    expect(prepared.document.groups).toEqual([]);
    expect(prepared.healthParameters.parameters.reportingGroups!.value).toEqual([]);
    expect((prepared.workerParameters.parameters.projectConfig!.value as typeof prepared.document).tenants[0]!.services.teams.worker)
      .toMatchObject({ cpu: 0.25, memory: "0.5Gi" });
  });

  it("keeps a Teams channelName, read only by the setup tooling, in the normalized document and both parameter sets", () => {
    const document = documentFixture();
    document.tenants[0]!.services.teams.targets[0]!.channelName = "  United Kingdom Users  ";
    const prepared = prepareProjectDeployment(document);
    const channelName = (value: unknown) => (value as typeof prepared.document).tenants[0]!.services.teams.targets[0]!.channelName;
    expect(channelName(prepared.document)).toBe("United Kingdom Users");
    expect(channelName(prepared.healthParameters.parameters.projectConfig!.value)).toBe("United Kingdom Users");
    expect(channelName(prepared.workerParameters.parameters.projectConfig!.value)).toBe("United Kingdom Users");
    const teams = prepared.workers.find(worker => worker.type === "teams")!;
    const probes = serviceProbes(teams.service, teams.project.services.teams.scenarios);
    expect(probes.map(probe => probe.id)).toEqual(["teams-probe-001", "teams-meeting-001"]);
    for (const probe of probes) expect(probe).not.toHaveProperty("channelName");
  });

  it("keeps all reporting groups on one existing tenant/service worker and Teams callback owner", () => {
    const document = documentFixture();
    const prepared = prepareProjectDeployment(document);
    expect(prepared.workers).toHaveLength(3);
    expect(prepared.workers.find(worker => worker.type === "exchange")!.service.targets).toHaveLength(2);
    expect(prepared.reportingGroups.map(group => [group.id, group.scopes.map(scope => scope.service)])).toEqual([
      ["centralus", ["exchange", "teams", "onedrive"]], ["uksouth", ["exchange", "onedrive"]],
    ]);
    expect(new Set(prepared.workers.map(worker => worker.identityResourceId)).size).toBe(3);
    expect(prepared.workers.every(worker => !worker.appName.includes("centralus") && !worker.appName.includes("uksouth"))).toBe(true);
  });

  it("keeps model and actual worker locations independently configurable", () => {
    const document = documentFixture();
    document.deployment!.location = "centralus";
    document.deployment!.healthModelLocation = "eastus2";
    const prepared = prepareProjectDeployment(document);
    expect(prepared.healthParameters.parameters.location!.value).toBe("eastus2");
    expect(prepared.workerParameters.parameters.location!.value).toBe("centralus");
    delete document.deployment!.healthModelLocation;
    expect(prepareProjectDeployment(document).healthParameters.parameters.location!.value).toBe("centralus");
  });

  it("gates stable/beta providers at the root without changing selected journeys", () => {
    const document = documentFixture();
    const execution = document.tenants[0]!.services.exchange.execution;
    execution.serviceHealth = true;
    execution.serviceActivity.enabled = true;
    const disabled = prepareProjectDeployment(document).workers.find(worker => worker.type === "exchange")!;
    expect(disabled.service.serviceHealth).toBe(false);
    expect(disabled.service.serviceActivity.enabled).toBe(false);
    document.serviceHealth.enabled = true;
    const enabled = prepareProjectDeployment(document).workers.find(worker => worker.type === "exchange")!;
    expect(enabled.service.serviceHealth).toBe(true);
    expect(enabled.service.serviceActivity.enabled).toBe(true);
    expect(enabled.project.services.exchange.scenarios).toEqual(disabled.project.services.exchange.scenarios);
  });

  it("preserves 500 inline OneDrive bindings with bounded independent lane budgets", () => {
    const document = documentFixture();
    document.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
    document.healthModel.reportTtlMinutes = 75;
    document.deployment!.enableLiveProbes = true;
    const selected = document.tenants[0]!.services.onedrive;
    selected.execution.mode = "live";
    selected.execution.maxConcurrentProbes = 20;
    selected.execution.cycleTimeoutSeconds = 3300;
    selected.targets = Array.from({ length: 500 }, (_, index) => ({
      id: `account-${index}`, userId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
      userPrincipalName: `account-${index}@example.invalid`, folderName: "AHM-Synthetic-Tests",
      driveId: `drive-${index}`, folderId: `folder-${index}`,
    }));
    const worker = prepareProjectDeployment(document).workers.find(worker => worker.type === "onedrive")!;
    expect(worker.service.targets).toEqual(selected.targets);
    selected.execution.cycleTimeoutSeconds = 3299;
    expect(() => prepareProjectDeployment(document)).toThrow("3300");
    selected.execution.cycleTimeoutSeconds = 3300;
    selected.execution.maxConcurrentProbes = 21;
    expect(() => prepareProjectDeployment(document)).toThrow("maxConcurrentProbes");
  });

  it("fails closed on missing real retained reply/folder bindings instead of disabling journeys", () => {
    const document = documentFixture();
    document.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
    document.deployment!.enableLiveProbes = true;
    document.tenants[0]!.services.exchange.execution.mode = "live";
    expect(() => prepareProjectDeployment(document)).toThrow("retained replySeed bindings for every selected initiating pair; run npm run setup (it writes them to .env)");
    for (const target of document.tenants[0]!.services.exchange.targets) {
      target.replySeed = { messageId: `received-${target.id}`, correlationId: "33333333-3333-4333-8333-333333333333" };
    }
    expect(prepareProjectDeployment(document).workers.find(worker => worker.type === "exchange")!.service.mode).toBe("live");
    document.tenants[0]!.services.onedrive.execution.mode = "live";
    expect(() => prepareProjectDeployment(document)).toThrow("approved driveId/folderId bindings; run npm run onedrive:setup (it writes them to .env)");
    expect(document.tenants[0]!.services.onedrive.scenarios["user-drive-roundtrip"]).toBe(true);
  });

  it("rejects mutable images, conflicting worker owners and retirement of supported entities", () => {
    const document = documentFixture();
    expect(() => prepareProjectDeployment(document, "synthetic:latest")).toThrow("immutable");
    document.tenants[0]!.services.teams.worker!.appName = document.tenants[0]!.services.exchange.worker!.appName;
    expect(() => prepareProjectDeployment(document)).toThrow("unique");
    document.tenants[0]!.services.teams.worker!.appName = "teams-owner";
    document.deployment!.retireEntities = [{ service: "exchange", entityName: "exchange-attachment" }];
    expect(() => prepareProjectDeployment(document)).toThrow("still supported");
  });

  it("requires hosting settings only for services that have an enabled scenario", () => {
    const document = documentFixture();
    delete document.tenants[0]!.services.onedrive.worker;
    expect(() => prepareProjectDeployment(document)).toThrow("worker.appName");
    Object.assign(document.tenants[0]!.services.onedrive.scenarios, {
      "user-drive-roundtrip": false, "app-folder-lifecycle": false, "document-versions": false,
    });
    expect(prepareProjectDeployment(document).workers.map(worker => worker.type)).toEqual(["exchange", "teams"]);
  });

  it("accepts resource names for the foundation and worker.identity, and explains the choice between worker.identity and worker.identityName", () => {
    const raw = structuredClone(documentFixture()) as Record<string, any>;
    const { exchange } = raw.tenants[0].services;
    exchange.worker = { appName: "contoso-exchange", identity: "uami-existing" };
    raw.deployment.foundation = { mode: "existing", environment: "cae-existing", registry: "crexisting01" };
    delete raw.deployment.azureTenantId;
    const prepared = prepareProjectDeployment(raw);
    const exchangeWorker = () => prepareProjectDeployment(raw).workers.find(worker => worker.type === "exchange")!;
    expect(prepared.settings.foundation).toEqual({
      mode: "existing",
      environmentResourceId: `${providers}/Microsoft.App/managedEnvironments/cae-existing`,
      registryResourceId: `${providers}/Microsoft.ContainerRegistry/registries/crexisting01`,
    });
    expect(prepared.settings.azureTenantId).toBe(fixtureTenantId);
    expect(exchangeWorker().identityResourceId).toBe(`${identities}/uami-existing`);
    exchange.worker.identityName = "uami-created";
    expect(() => prepareProjectDeployment(raw)).toThrow("exactly one of worker.identity or worker.identityName");
    delete exchange.worker.identity;
    expect(exchangeWorker().identityResourceId).toBe(`${identities}/uami-created`);
  });

  it("names the keys a user sets when live Teams access or the worker identity is missing", () => {
    const document = documentFixture();
    document.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
    document.deployment!.enableLiveProbes = true;
    const teams = document.tenants[0]!.services.teams;
    teams.execution.mode = "live";
    expect(() => prepareProjectDeployment(document)).toThrow("both bot references (access.bot and access.peerBot)");
    teams.scenarios["scheduled-meeting"] = false;
    expect(() => prepareProjectDeployment(document)).toThrow("Live Teams requires access.bot for");
    teams.access = { botPeerClientId: teams.callTargets[0]!.peerBotClientId };
    expect(() => prepareProjectDeployment(document)).toThrow("requires both access.peerIdentity and its client ID");
    teams.access = {
      botResourceId: "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-m365-demo/providers/Microsoft.BotService/botServices/primary-bot",
    };
    delete teams.worker!.identityResourceId;
    teams.worker!.identityName = "uami-teams";
    expect(() => prepareProjectDeployment(document)).toThrow("approved worker.identity;");
  });

  it("prepares the foundation stage of live Teams meetings before the peer client ID and callback URL exist, which the workers stage still requires", () => {
    const document = documentFixture();
    document.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
    document.deployment!.enableLiveProbes = true;
    const { teams } = document.tenants[0]!.services;
    teams.execution.mode = "live";
    expect(teams.access.botPeerClientId).toBeUndefined();
    expect(teams.execution.teamsCallingCallbackUrl).toBeUndefined();
    document.deployment!.stage = "foundation";
    expect(prepareProjectDeployment(document).workers.find(worker => worker.type === "teams")!.service.mode).toBe("live");
    document.deployment!.stage = "workers";
    expect(() => prepareProjectDeployment(document)).toThrow("Live Teams meetings require port 8080");
  });

  it("prepares the foundation stage of a live certificate worker without its certificate source, which the workers stage still requires", () => {
    const document = documentFixture();
    document.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
    document.deployment!.enableLiveProbes = true;
    const exchange = document.tenants[0]!.services.exchange;
    exchange.execution.mode = "live";
    exchange.execution.graphAuthentication = "certificate";
    document.deployment!.stage = "foundation";
    expect(prepareProjectDeployment(document).workers.find(worker => worker.type === "exchange")!.service.mode).toBe("live");
    document.deployment!.stage = "workers";
    expect(() => prepareProjectDeployment(document)).toThrow("Hosted Graph certificates require");
  });

  it("does not create workers or reporting groups for disabled selections", () => {
    const document = documentFixture();
    for (const selected of Object.values(document.tenants[0]!.services)) selected.enabled = false;
    const prepared = prepareProjectDeployment(parseProjectDocument(document));
    expect(prepared.workers).toEqual([]);
    expect(prepared.reportingGroups).toEqual([]);
    expect(prepared.modelNames).toEqual([document.healthModel.name]);
  });
});
