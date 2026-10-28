import { parseProjectDocument, selectTenant, type ProjectConfig, type ProjectDocument } from "../src/project-config.js";
import { parseServiceExecution, type ServiceConfig } from "../src/service-config.js";

export const fixtureTenantId = "11111111-1111-4111-8111-111111111111";
/** Live workers must bind the Azure identity and bot tenants to the selected project's tenant. */
export const liveTenantEnv = { AZURE_TENANT_ID: fixtureTenantId, BOT_TENANT_ID: fixtureTenantId };

/** One tenant mirroring the checked-in root config: two mailbox/drive accounts, one channel, one meeting, two groups. */
export function documentFixture(): ProjectDocument {
  const tenantId = fixtureTenantId;
  const execution = { mode: "simulation", cohort: "test", maxConcurrentProbes: 3, cycleTimeoutSeconds: 170 };
  const accounts = ["test-user-1@example.invalid", "test-user-2@example.invalid"];
  const identityRoot = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-m365-demo/providers/Microsoft.ManagedIdentity/userAssignedIdentities";
  return parseProjectDocument({
    schemaVersion: "2.0",
    healthModel: {
      name: "m365-experience-poc", subscriptionId: "00000000-0000-0000-0000-000000000000",
      resourceGroup: "rg-m365-demo", reportTtlMinutes: 15,
      successDegradedPercent: 99, successUnhealthyPercent: 95,
      latencyDegradedMilliseconds: 15000, latencyUnhealthyMilliseconds: 60000,
    },
    deployment: {
      location: "eastus2", azureTenantId: tenantId,
      foundation: { mode: "create", environmentName: "cae-m365-experience-poc", registryName: "crm365example" },
      image: { mode: "build", repository: "m365-synthetic", tag: "monitoring" },
    },
    tenants: [{
      id: "contoso", displayName: "Example tenant", tenantId,
      services: {
        exchange: {
          execution: {
            ...execution, cohort: "exchange-global", intervalSeconds: 60, timeoutSeconds: 15,
            executionLanes: [
              { name: "mail", intervalSeconds: 60, timeoutSeconds: 15, journeys: ["send-receive-mail"] },
              { name: "extended", intervalSeconds: 300, timeoutSeconds: 15, journeys: [
                "edit-reopen-draft", "attachment-mail", "reply-mail", "distribution-list-mail", "recurring-calendar", "meeting-invitation",
              ] },
            ],
          },
          worker: { appName: "m365-example-exchange", identityResourceId: `${identityRoot}/uami-m365-experience-poc-exchange` },
          scenarios: {},
          targets: accounts.map((mailbox, index) => ({
            id: `exchange-probe-00${index + 1}`, mailbox, recipientMailbox: accounts[1 - index],
            distributionList: { address: "dedicated-list@example.invalid", expectedRecipients: accounts },
          })),
        },
        teams: {
          execution: {
            ...execution, cohort: "teams-global", intervalSeconds: 120, timeoutSeconds: 45,
            executionLanes: [{ name: "teams", intervalSeconds: 120, timeoutSeconds: 45, journeys: ["channel-conversation", "scheduled-meeting"] }],
          },
          worker: { appName: "m365-example-teams", identityResourceId: `${identityRoot}/uami-m365-experience-poc-teams` },
          scenarios: {},
          targets: [{
            id: "teams-probe-001", tenantId, teamId: "33333333-3333-4333-8333-333333333333",
            channelId: "dedicated-standard-channel", serviceUrl: "https://smba.trafficmanager.net/teams/",
          }],
          callTargets: [{
            id: "teams-meeting-001", tenantId, meetingThreadId: "19:meeting_DEDICATED_TEST_MEETING@thread.v2",
            organizerUserId: "44444444-4444-4444-8444-444444444444", peerBotClientId: "22222222-2222-4222-8222-222222222222",
          }],
        },
        onedrive: {
          execution: {
            ...execution, cohort: "onedrive-global", intervalSeconds: 300, timeoutSeconds: 120,
            executionLanes: [
              { name: "user-drive", intervalSeconds: 300, timeoutSeconds: 120, journeys: ["user-drive-roundtrip"] },
              { name: "app-folder", intervalSeconds: 300, timeoutSeconds: 120, journeys: ["app-folder-lifecycle"] },
              { name: "versions", intervalSeconds: 300, timeoutSeconds: 120, journeys: ["document-versions"] },
            ],
          },
          worker: { appName: "m365-example-onedrive", identityResourceId: `${identityRoot}/uami-m365-experience-poc-onedrive` },
          scenarios: {},
          targets: accounts.map((userPrincipalName, index) => ({
            id: `onedrive-probe-00${index + 1}`,
            userId: `${index ? "66666666-6666-4666-8666-666666666666" : "55555555-5555-4555-8555-555555555555"}`,
            userPrincipalName, folderName: "AHM-Synthetic-Tests", restoreVersion: false,
          })),
        },
      },
    }],
    groups: [
      { id: "centralus", displayName: "Central US", accounts: [accounts[0]], teams: ["teams-probe-001", "teams-meeting-001"] },
      { id: "uksouth", displayName: "UK South", accounts: [accounts[1]] },
    ],
  });
}

/** The ungrouped single-tenant project the aggregation and worker tests run against (one Exchange pair, no groups). */
export function projectFixture(): ProjectConfig {
  const document = documentFixture();
  document.tenants[0]!.services.exchange.targets = document.tenants[0]!.services.exchange.targets.slice(0, 1);
  document.groups = [];
  return selectTenant(document);
}

/** Re-validates a project-shaped object (tenant, services, shared settings) as a one-tenant, ungrouped document. */
export function parseTestProjectConfig(raw: unknown): ProjectConfig {
  const { tenant, services, groups: _groups, multiTenant: _multiTenant, ...shared } = raw as ProjectConfig;
  return selectTenant(parseProjectDocument({ ...shared, tenants: [{ ...tenant, services }] }));
}

export function executionFixture(type: ServiceConfig["type"], mode: "simulation" | "live" = "simulation") {
  return parseServiceExecution({ ...documentFixture().tenants[0]!.services[type].execution, type, mode });
}

/**
 * Two tenants with unique Teams target ids and three groups: `priority` spans both tenants, `field` has
 * Exchange/OneDrive members in one tenant, and `bridge` has a single Teams channel member.
 */
export function multiTenantFixture(): ProjectDocument {
  const document = documentFixture();
  const contoso = document.tenants[0]!;
  const fabrikam = structuredClone(contoso);
  fabrikam.id = "fabrikam";
  fabrikam.displayName = "Fabrikam";
  fabrikam.tenantId = "22222222-2222-4222-8222-222222222222";
  document.tenants = [contoso, fabrikam];
  for (const tenant of document.tenants) {
    const { exchange, teams, onedrive } = tenant.services;
    exchange.targets = ["a", "b"].map(suffix => ({
      id: `pair-${suffix}`, mailbox: `probe-${suffix}@${tenant.id}.example.invalid`,
      recipientMailbox: `recipient@${tenant.id}.example.invalid`,
    }));
    onedrive.targets = ["a", "b"].map((suffix, index) => ({
      id: `drive-${suffix}`, userId: `${tenant.id === "contoso" ? "33333333" : "44444444"}-3333-4333-8333-${String(index).padStart(12, "0")}`,
      userPrincipalName: `probe-${suffix}@${tenant.id}.example.invalid`, folderName: "AHM-Synthetic-Tests",
    }));
    teams.targets = [{ ...teams.targets[0]!, id: `${tenant.id}-channel`, tenantId: tenant.tenantId }];
    teams.callTargets = [{ ...teams.callTargets[0]!, id: `${tenant.id}-meeting`, tenantId: tenant.tenantId }];
    for (const [type, selected] of Object.entries(tenant.services)) {
      selected.worker = { appName: `${tenant.id}-${type}`, identityName: `uami-${tenant.id}-${type}`, cpu: 0.25, memory: "0.5Gi" };
    }
  }
  document.groups = [
    {
      id: "priority", displayName: "Priority accounts",
      accounts: ["probe-a@contoso.example.invalid", "probe-a@fabrikam.example.invalid"],
      teams: ["contoso-channel", "fabrikam-meeting"],
    },
    { id: "field", displayName: "Field accounts", accounts: ["probe-b@contoso.example.invalid"], teams: [] },
    { id: "bridge", displayName: "Bridge", accounts: [], teams: ["fabrikam-channel"] },
  ];
  return parseProjectDocument(document);
}
