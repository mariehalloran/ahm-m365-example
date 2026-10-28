import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../src/config.js";
import { parseProjectDocument } from "../src/project-config.js";
import { expandReferences } from "../src/references.js";
import { documentFixture, multiTenantFixture } from "./fixtures.js";

// Raw config JSON, which `expandReferences` navigates without a schema.
type Raw = Record<string, any>;

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const providerClientId = "33333333-3333-4333-8333-333333333333";
const peerClientId = "44444444-4444-4444-8444-444444444444";
const otherId = "55555555-5555-4555-8555-555555555555";
const teamId = "66666666-6666-4666-8666-666666666666";
const meetingThreadId = "19:meeting_DEDICATED_TEST_MEETING@thread.v2";
const identityType = "Microsoft.ManagedIdentity/userAssignedIdentities";
const botType = "Microsoft.BotService/botServices";
const inGroup = `/subscriptions/${subscriptionId}/resourceGroups/rg-demo/providers`;
const elsewhere = "/subscriptions/77777777-7777-4777-8777-777777777777/resourceGroups/rg-shared/providers";
const teamsServiceUrl = "https://smba.trafficmanager.net/teams/";

/** A document as a user writes it: names, intent and defaults. `expandReferences` does not validate, so it holds only what these tests read. */
function userDocument(): Raw {
  return {
    healthModel: { subscriptionId, resourceGroup: "rg-demo" },
    deployment: { location: "eastus2", foundation: { mode: "existing", environment: "cae-demo", registry: "crdemo01" } },
    tenants: [{
      id: "contoso", tenantId, providerClientId,
      services: {
        exchange: { execution: { serviceHealth: true }, worker: { appName: "demo-exchange", identity: "uami-exchange" } },
        teams: {
          execution: { serviceActivity: { enabled: true } }, worker: { appName: "demo-teams", identity: "uami-teams" },
          access: { bot: "bot-demo", peerBot: "bot-demo-peer", peerIdentity: "uami-peer", botPeerClientId: peerClientId },
          targets: [{ id: "channel-001", teamId, channelName: "General" }],
          callTargets: [{ id: "meeting-001", meetingThreadId, organizer: "organizer@example.invalid" }],
        },
        onedrive: { execution: { mode: "simulation" }, worker: { appName: "demo-onedrive", identity: "uami-onedrive" } },
      },
    }],
  };
}

/** What `userDocument()` means in the canonical shape the schema validates. */
function canonicalDocument(): Raw {
  return {
    healthModel: { subscriptionId, resourceGroup: "rg-demo" },
    deployment: {
      location: "eastus2", azureTenantId: tenantId,
      foundation: {
        mode: "existing",
        environmentResourceId: `${inGroup}/Microsoft.App/managedEnvironments/cae-demo`,
        registryResourceId: `${inGroup}/Microsoft.ContainerRegistry/registries/crdemo01`,
      },
    },
    tenants: [{
      id: "contoso", tenantId,
      services: {
        exchange: {
          execution: { serviceHealth: true, providerClientId },
          worker: { appName: "demo-exchange", identityResourceId: `${inGroup}/${identityType}/uami-exchange` },
        },
        teams: {
          execution: { serviceActivity: { enabled: true }, providerClientId },
          worker: { appName: "demo-teams", identityResourceId: `${inGroup}/${identityType}/uami-teams` },
          access: {
            botResourceId: `${inGroup}/${botType}/bot-demo`, botPeerResourceId: `${inGroup}/${botType}/bot-demo-peer`,
            botPeerManagedIdentityResourceId: `${inGroup}/${identityType}/uami-peer`, botPeerClientId: peerClientId,
          },
          targets: [{ id: "channel-001", teamId, channelName: "General", tenantId, serviceUrl: teamsServiceUrl }],
          callTargets: [{ id: "meeting-001", meetingThreadId, tenantId, peerBotClientId: peerClientId }],
        },
        onedrive: {
          execution: { mode: "simulation" },
          worker: { appName: "demo-onedrive", identityResourceId: `${inGroup}/${identityType}/uami-onedrive` },
        },
      },
    }],
  };
}

const expanded = (document: unknown = userDocument()) => expandReferences(document) as Raw;
const holder = (document: Raw, where: string): Raw => where.split(".").reduce<Raw>((value, name) => value[name], document);
const teamsOf = (document: Raw): Raw => document.tenants[0].services.teams;

function failure(run: () => unknown): Error {
  try { run(); }
  catch (error) { return error as Error; }
  throw new Error("Expected the call to throw");
}

// Each key that names a resource: where it lives, the canonical key it expands to, the resource type and the name in userDocument().
const references = [
  ["deployment.foundation", "environment", "environmentResourceId", "Microsoft.App/managedEnvironments", "cae-demo"],
  ["deployment.foundation", "registry", "registryResourceId", "Microsoft.ContainerRegistry/registries", "crdemo01"],
  ["tenants.0.services.exchange.worker", "identity", "identityResourceId", identityType, "uami-exchange"],
  ["tenants.0.services.teams.worker", "identity", "identityResourceId", identityType, "uami-teams"],
  ["tenants.0.services.onedrive.worker", "identity", "identityResourceId", identityType, "uami-onedrive"],
  ["tenants.0.services.teams.access", "bot", "botResourceId", botType, "bot-demo"],
  ["tenants.0.services.teams.access", "peerBot", "botPeerResourceId", botType, "bot-demo-peer"],
  ["tenants.0.services.teams.access", "peerIdentity", "botPeerManagedIdentityResourceId", identityType, "uami-peer"],
] as const;

describe("expandReferences", () => {
  it("expands a document of names, intent and defaults into the canonical shape", () => {
    expect(expanded()).toEqual(canonicalDocument());
  });

  it.each(references)("resolves %s %s to a resource in the health model's resource group", (where, name, canonical, type, value) => {
    const target = holder(expanded(), where);
    expect(target[canonical]).toBe(`${inGroup}/${type}/${value}`);
    expect(target).not.toHaveProperty(name);
  });

  it.each(references)("keeps a full resource ID given as %s %s, in any resource group or subscription", (where, name, canonical, type) => {
    for (const id of [`${elsewhere}/${type}/shared`, `/SUBSCRIPTIONS/${otherId}/resourceGroups/rg-other/providers/${type}/shared`]) {
      const document = userDocument();
      holder(document, where)[name] = id;
      const target = holder(expanded(document), where);
      expect(target[canonical]).toBe(id);
      expect(target).not.toHaveProperty(name);
    }
  });

  it.each(references)("rejects %s %s together with its canonical twin, naming both", (where, name, canonical, type) => {
    const document = userDocument();
    holder(document, where)[canonical] = `${elsewhere}/${type}/shared`;
    const error = failure(() => expandReferences(document));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toBe(`${where} sets both ${name} and ${canonical}; set only one of them`);
  });

  it("keeps the canonical keys working on their own", () => {
    const canonical = canonicalDocument();
    expect(expandReferences(canonical)).toEqual(canonical);
    expect(expandReferences(expanded())).toEqual(canonical);
  });

  it("defaults deployment.azureTenantId to the only tenant's tenantId and keeps an explicit one", () => {
    expect(expanded().deployment.azureTenantId).toBe(tenantId);
    const document = userDocument();
    document.deployment.azureTenantId = otherId;
    expect(expanded(document).deployment.azureTenantId).toBe(otherId);
  });

  it("requires deployment.azureTenantId when there are several tenants, and without a deployment section needs none", () => {
    const document = userDocument();
    document.tenants.push({ ...document.tenants[0], id: "fabrikam", tenantId: otherId });
    const error = failure(() => parseProjectDocument(document));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toBe("deployment.azureTenantId is required when the config has several tenants; set it to the tenant ID of the Azure subscription");
    document.deployment.azureTenantId = tenantId;
    expect(expanded(document).deployment.azureTenantId).toBe(tenantId);
    delete document.deployment;
    expect(expanded(document)).not.toHaveProperty("deployment");
  });

  it("defaults each Teams target's tenantId and serviceUrl and each call target's tenantId and peerBotClientId", () => {
    const teams = teamsOf(expanded());
    expect(teams.targets[0]).toMatchObject({ tenantId, serviceUrl: teamsServiceUrl });
    expect(teams.callTargets[0]).toMatchObject({ tenantId, peerBotClientId: peerClientId });
  });

  it("keeps the values a target sets itself, for the schema to judge, and defaults nothing without a peer bot client ID", () => {
    const document = userDocument();
    const teams = teamsOf(document);
    Object.assign(teams.targets[0], { tenantId: otherId, serviceUrl: "https://smba.trafficmanager.net/emea/" });
    Object.assign(teams.callTargets[0], { tenantId: otherId, peerBotClientId: otherId });
    expect(teamsOf(expanded(document)).targets[0]).toMatchObject({ tenantId: otherId, serviceUrl: "https://smba.trafficmanager.net/emea/" });
    expect(teamsOf(expanded(document)).callTargets[0]).toMatchObject({ tenantId: otherId, peerBotClientId: otherId });
    delete teams.callTargets[0].peerBotClientId;
    delete teams.access.botPeerClientId;
    expect(teamsOf(expanded(document)).callTargets[0]).not.toHaveProperty("peerBotClientId");
  });

  it("gives the tenant's providerClientId to the services that collect Service Health or service activity, and only to them", () => {
    const [tenant] = expanded().tenants;
    expect(tenant).not.toHaveProperty("providerClientId");
    expect(Object.entries<Raw>(tenant.services).map(([name, service]) => [name, service.execution.providerClientId]))
      .toEqual([["exchange", providerClientId], ["teams", providerClientId], ["onedrive", undefined]]);
  });

  it.each([
    ["not mentioned", {}], ["serviceHealth off", { serviceHealth: false }],
    ["serviceActivity off", { serviceActivity: { enabled: false } }], ["serviceActivity not enabled", { serviceActivity: {} }],
  ])("gives it to no service with Service Health and service activity %s", (_label, execution) => {
    const document = userDocument();
    for (const service of Object.values<Raw>(document.tenants[0].services)) service.execution = { ...execution };
    const [tenant] = expanded(document).tenants;
    expect(tenant).not.toHaveProperty("providerClientId");
    for (const service of Object.values<Raw>(tenant.services)) expect(service.execution).toEqual(execution);
  });

  it("keeps a providerClientId a service sets itself and adds none when the tenant has none", () => {
    const document = userDocument();
    document.tenants[0].services.exchange.execution.providerClientId = otherId;
    expect(expanded(document).tenants[0].services.exchange.execution.providerClientId).toBe(otherId);
    delete document.tenants[0].providerClientId;
    expect(expanded(document).tenants[0].services.teams.execution).toEqual({ serviceActivity: { enabled: true } });
  });

  it("drops organizer, which only the setup script reads, and keeps an organizerUserId beside it", () => {
    const document = userDocument();
    expect(teamsOf(expanded(document)).callTargets[0]).not.toHaveProperty("organizer");
    teamsOf(document).callTargets[0].organizerUserId = otherId;
    const [target] = teamsOf(expanded(document)).callTargets;
    expect(target).not.toHaveProperty("organizer");
    expect(target.organizerUserId).toBe(otherId);
  });

  it.each([
    ["a user document", userDocument], ["the fixture document", documentFixture], ["the multi-tenant fixture", multiTenantFixture],
  ])("is idempotent on %s and returns canonical documents unchanged", (_label, build) => {
    const once = expandReferences(build());
    expect(expandReferences(once)).toEqual(once);
    if (build !== userDocument) expect(once).toEqual(build());
  });

  it("returns a copy and never mutates its input", () => {
    const raw = userDocument();
    const before = structuredClone(raw);
    const copy = expandReferences(raw);
    expect(raw).toEqual(before);
    expect(copy).not.toBe(raw);
    expect(expandReferences(documentFixture())).not.toBe(expandReferences(documentFixture()));
  });

  it.each([
    undefined, null, 7, "text", [], {}, { tenants: "x" }, { tenants: [null, 7, "x", [], {}, { id: 5, services: "x" }] },
    { healthModel: "x", deployment: "x" },
    { healthModel: { subscriptionId: 7, resourceGroup: [] }, deployment: { foundation: { environment: "cae-demo", registry: 7 } } },
    { deployment: { foundation: { mode: "existing", environment: "cae-demo" } } },
    { healthModel: { subscriptionId, resourceGroup: "rg-demo" }, deployment: { foundation: "x" }, tenants: [{ tenantId: 7, services: {
      exchange: null, teams: { access: "x", targets: [null, 7, "x"], callTargets: "x", worker: 7 }, onedrive: { execution: [], worker: [] },
    } }] },
  ])("leaves malformed input %j for the schema to report", raw => {
    expect(expandReferences(raw)).toEqual(raw);
  });
});

describe("parseProjectDocument with names and defaults", () => {
  /** The fixture document written with names and defaults, and the canonical document it must give. */
  function fixtureInNames() {
    const canonical = documentFixture();
    const root = `/subscriptions/${canonical.healthModel.subscriptionId}/resourceGroups/${canonical.healthModel.resourceGroup}/providers`;
    const { exchange, teams } = canonical.tenants[0]!.services;
    canonical.deployment!.foundation = {
      mode: "existing",
      environmentResourceId: `${root}/Microsoft.App/managedEnvironments/cae-demo`,
      registryResourceId: `${root}/Microsoft.ContainerRegistry/registries/crdemo01`,
    };
    exchange.execution.serviceHealth = true;
    exchange.execution.providerClientId = providerClientId;
    teams.access = { botResourceId: `${root}/${botType}/bot-demo`, botPeerClientId: peerClientId };
    teams.callTargets[0]!.peerBotClientId = peerClientId;

    const names = structuredClone(canonical) as Raw;
    const tenant = names.tenants[0];
    delete names.deployment.azureTenantId;
    names.deployment.foundation = { mode: "existing", environment: "cae-demo", registry: "crdemo01" };
    tenant.providerClientId = providerClientId;
    delete tenant.services.exchange.execution.providerClientId;
    for (const service of Object.values<Raw>(tenant.services)) {
      service.worker = { appName: service.worker.appName, identity: service.worker.identityResourceId.split("/").at(-1) };
    }
    tenant.services.teams.access = { bot: "bot-demo", botPeerClientId: peerClientId };
    for (const target of tenant.services.teams.targets) { delete target.tenantId; delete target.serviceUrl; }
    for (const target of tenant.services.teams.callTargets) {
      delete target.tenantId;
      delete target.peerBotClientId;
      target.organizer = "organizer@example.invalid";
    }
    return { names, canonical };
  }

  it("gives the canonical document for the same deployment written with names and defaults", () => {
    const { names, canonical } = fixtureInNames();
    expect(parseProjectDocument(names)).toEqual(parseProjectDocument(canonical));
    expect(parseProjectDocument(names).tenants[0]!.services.teams.callTargets[0]).not.toHaveProperty("organizer");
  });

  it("reports a name that is no valid resource name under the canonical key it expands to", () => {
    const { names } = fixtureInNames();
    names.deployment.foundation.registry = "no";
    const error = failure(() => parseProjectDocument(names));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.message).toContain("deployment.foundation.registryResourceId");
  });

  it("reports a name given next to its twin before any schema error", () => {
    const { names } = fixtureInNames();
    names.deployment.foundation.registryResourceId = names.deployment.foundation.registry;
    expect(() => parseProjectDocument(names)).toThrow("deployment.foundation sets both registry and registryResourceId");
  });
});
