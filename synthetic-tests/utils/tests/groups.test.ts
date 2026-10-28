import { describe, expect, it } from "vitest";
import { groupSignalName, reportingGroups, resolveGroups, tenantSignalName } from "../src/groups.js";
import { teamsCallSignals } from "../src/health-reports.js";
import { parseProjectDocument, selectTenant, type ProjectDocument } from "../src/project-config.js";
import { activityFunctionNames } from "../src/provider-catalog.js";
import { documentFixture, multiTenantFixture } from "./fixtures.js";

const mail = [
  "send-receive-mail", "edit-reopen-draft", "attachment-mail", "reply-mail",
  "distribution-list-mail", "recurring-calendar", "meeting-invitation",
];
const drive = ["user-drive-roundtrip", "app-folder-lifecycle", "document-versions"];

function rejection(mutate: (document: ProjectDocument) => void, document = multiTenantFixture()): string {
  mutate(document);
  try { parseProjectDocument(document); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
  throw new Error("Expected the document to be rejected");
}

describe("group resolution", () => {
  it("selects Exchange targets by initiating mailbox and OneDrive targets by owner, case-insensitively", () => {
    const document = documentFixture();
    document.groups[0]!.accounts = ["TEST-USER-1@Example.Invalid"];
    expect(resolveGroups(document).map(group => [group.id, group.members.map(member => [member.tenant.id, member.targetIds])])).toEqual([
      ["centralus", [["contoso", {
        exchange: ["exchange-probe-001"], teams: ["teams-probe-001", "teams-meeting-001"], onedrive: ["onedrive-probe-001"],
      }]]],
      ["uksouth", [["contoso", { exchange: ["exchange-probe-002"], teams: [], onedrive: ["onedrive-probe-002"] }]]],
    ]);
  });

  it("never matches a recipient or distribution-list member as an account", () => {
    const document = documentFixture();
    document.tenants[0]!.services.exchange.targets[0]!.recipientMailbox = "only-a-recipient@example.invalid";
    document.groups[0]!.accounts = ["only-a-recipient@example.invalid"];
    expect(() => resolveGroups(document)).toThrow('Group "centralus" accounts[0] matches no configured target');
  });

  it("derives each member's tenant, including a group that spans tenants and ids reused across tenants", () => {
    const document = multiTenantFixture();
    const [priority, field, bridge] = resolveGroups(document);
    expect(priority!.members.map(member => [member.tenant.id, member.targetIds])).toEqual([
      ["contoso", { exchange: ["pair-a"], teams: ["contoso-channel"], onedrive: ["drive-a"] }],
      ["fabrikam", { exchange: ["pair-a"], teams: ["fabrikam-meeting"], onedrive: ["drive-a"] }],
    ]);
    expect(field!.members.map(member => [member.tenant.id, member.targetIds])).toEqual([
      ["contoso", { exchange: ["pair-b"], teams: [], onedrive: ["drive-b"] }],
    ]);
    expect(bridge!.members.map(member => [member.tenant.id, member.targetIds])).toEqual([
      ["fabrikam", { exchange: [], teams: ["fabrikam-channel"], onedrive: [] }],
    ]);
  });

  it("defaults to no groups, leaving the document unchanged", () => {
    const document = documentFixture();
    const { groups: _groups, ...withoutGroups } = document;
    expect(parseProjectDocument(withoutGroups).groups).toEqual([]);
    expect(resolveGroups(parseProjectDocument(withoutGroups))).toEqual([]);
    expect(reportingGroups(parseProjectDocument(withoutGroups))).toEqual([]);
  });

  it("uses the checked-in test-user labels without any extra account", () => {
    const [central, uk] = resolveGroups(documentFixture());
    expect(central!.members[0]!.targetIds.exchange).toEqual(["exchange-probe-001"]);
    expect(uk!.members[0]!.targetIds.exchange).toEqual(["exchange-probe-002"]);
    expect(JSON.stringify(documentFixture())).not.toContain("test-user-3");
  });
});

describe("group validation", () => {
  it.each([
    ["an unknown account", (document: ProjectDocument) => { document.groups[0]!.accounts[1] = "nobody@contoso.example.invalid"; },
      'Group "priority" accounts[1] matches no configured target'],
    ["an unknown Teams target", (document: ProjectDocument) => { document.groups[0]!.teams[0] = "missing-channel"; },
      'Group "priority" teams[0] matches no configured target'],
    ["a repeated account in a different case", (document: ProjectDocument) => { document.groups[0]!.accounts.push("PROBE-A@CONTOSO.EXAMPLE.INVALID"); },
      'Group "priority" accounts must not repeat entries'],
    ["a repeated Teams target", (document: ProjectDocument) => { document.groups[0]!.teams.push("contoso-channel"); },
      'Group "priority" teams must not repeat entries'],
    ["a group without members", (document: ProjectDocument) => { document.groups[1]!.accounts = []; },
      'Group "field" needs at least one account or Teams target'],
    ["a repeated group id", (document: ProjectDocument) => { document.groups[1]!.id = "priority"; },
      "Group ids must not repeat entries"],
    ["an account owned by two tenants", (document: ProjectDocument) => {
      document.tenants[1]!.services.exchange.targets[0]!.mailbox = "probe-a@contoso.example.invalid";
    }, 'Group "priority" accounts[0] matches targets in more than one tenant'],
    ["a Teams target id reused by two tenants", (document: ProjectDocument) => {
      document.tenants[1]!.services.teams.targets[0]!.id = "contoso-channel";
    }, 'Group "priority" teams[0] matches targets in more than one tenant'],
    ["an account that is only a recipient", (document: ProjectDocument) => {
      document.groups[1]!.accounts = ["recipient@contoso.example.invalid"];
    }, 'Group "field" accounts[0] matches no configured target'],
  ])("rejects %s, naming the group and position", (_label, mutate, message) => {
    expect(rejection(mutate)).toBe(message);
  });

  it("never echoes configured account or Teams target values in resolution errors", () => {
    const secrets = ["secret.person@contoso.example.invalid", "secret-private-channel"];
    for (const message of [
      rejection(document => { document.groups[0]!.accounts[0] = secrets[0]!; }),
      rejection(document => { document.groups[0]!.teams[0] = secrets[1]!; }),
      rejection(document => { document.groups[0]!.accounts.push(secrets[0]!, secrets[0]!.toUpperCase()); }),
      rejection(document => { document.groups[0]!.teams.push(secrets[1]!, secrets[1]!); }),
    ]) {
      expect(message).toContain('Group "priority"');
      for (const secret of secrets) expect(message.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it.each([
    ["uppercase", "Priority"], ["a double hyphen", "north--tenant-east"], ["a leading digit", "1north"],
    ["a trailing hyphen", "north-"], ["more than 40 characters", "g".repeat(41)],
  ])("rejects a group id with %s", (_label, id) => {
    expect(rejection(document => { document.groups[0]!.id = id; })).toBe("Invalid project config fields: groups.0.id");
  });

  it.each([
    ["an empty display name", { displayName: " " }, "groups.0.displayName"],
    ["a display name over 260 characters", { displayName: "x".repeat(261) }, "groups.0.displayName"],
    ["a malformed account", { accounts: ["not-an-email"] }, "groups.0.accounts.0"],
    ["a member list of the superseded shape", { teamsTargets: [] }, "groups.0"],
  ])("rejects %s without echoing it", (_label, change, path) => {
    const message = rejection(document => { Object.assign(document.groups[0]!, change); });
    expect(message).toBe(`Invalid project config fields: ${path}`);
  });

  it("accepts an optional description", () => {
    const document = multiTenantFixture();
    document.groups[0]!.description = "Executives";
    expect(parseProjectDocument(document).groups[0]!.description).toBe("Executives");
  });
});

describe("reporting group plan", () => {
  it("lists one scope per tenant and service with the journeys the group's own targets can observe", () => {
    expect(reportingGroups(multiTenantFixture())).toEqual([
      {
        id: "priority", displayName: "Priority accounts", scopes: [
          { tenant: "contoso", service: "exchange", journeys: mail },
          { tenant: "contoso", service: "teams", journeys: ["channel-conversation"] },
          { tenant: "contoso", service: "onedrive", journeys: drive },
          { tenant: "fabrikam", service: "exchange", journeys: mail },
          { tenant: "fabrikam", service: "teams", journeys: ["scheduled-meeting"] },
          { tenant: "fabrikam", service: "onedrive", journeys: drive },
        ],
      },
      {
        id: "field", displayName: "Field accounts", scopes: [
          { tenant: "contoso", service: "exchange", journeys: mail },
          { tenant: "contoso", service: "onedrive", journeys: drive },
        ],
      },
      { id: "bridge", displayName: "Bridge", scopes: [{ tenant: "fabrikam", service: "teams", journeys: ["channel-conversation"] }] },
    ]);
  });

  it("maps a Teams channel member to the channel journey and a meeting member to the meeting journey", () => {
    const document = documentFixture();
    document.groups = [
      { id: "channels", displayName: "Channels", accounts: [], teams: ["teams-probe-001"] },
      { id: "meetings", displayName: "Meetings", accounts: [], teams: ["teams-meeting-001"] },
    ];
    expect(reportingGroups(document)).toEqual([
      { id: "channels", displayName: "Channels", scopes: [{ tenant: "contoso", service: "teams", journeys: ["channel-conversation"] }] },
      { id: "meetings", displayName: "Meetings", scopes: [{ tenant: "contoso", service: "teams", journeys: ["scheduled-meeting"] }] },
    ]);
  });

  it("omits scopes for disabled services and journeys, and groups left without any scope", () => {
    const document = multiTenantFixture();
    document.tenants[0]!.services.teams.enabled = false;
    document.tenants[1]!.services.teams.scenarios["channel-conversation"] = false;
    document.tenants[0]!.services.onedrive.scenarios["document-versions"] = false;
    document.tenants[0]!.services.exchange.scenarios["recurring-calendar"] = false;
    const plan = reportingGroups(parseProjectDocument(document));
    expect(plan.map(group => group.id)).toEqual(["priority", "field"]);
    expect(plan[0]!.scopes.map(scope => `${scope.tenant}/${scope.service}`)).toEqual([
      "contoso/exchange", "contoso/onedrive", "fabrikam/exchange", "fabrikam/teams", "fabrikam/onedrive",
    ]);
    expect(plan[0]!.scopes[0]!.journeys).not.toContain("recurring-calendar");
    expect(plan[0]!.scopes[1]!.journeys).toEqual(["user-drive-roundtrip", "app-folder-lifecycle"]);
  });

  it("lists nothing when no group has a runnable journey", () => {
    const document = documentFixture();
    for (const selected of Object.values(document.tenants[0]!.services)) selected.enabled = false;
    expect(reportingGroups(parseProjectDocument(document))).toEqual([]);
  });

  it("agrees with the groups each tenant worker sees", () => {
    const document = multiTenantFixture();
    for (const group of reportingGroups(document)) {
      for (const scope of group.scopes) {
        const seen = selectTenant(document, scope.tenant).groups.find(candidate => candidate.id === group.id);
        expect(seen).toBeDefined();
        expect(seen!.targetIds[scope.service].length).toBeGreaterThan(0);
      }
    }
  });
});

describe("signal names", () => {
  // Every signal a worker can publish, as typed by HealthReport["body"]["signalName"].
  const everySignal = [
    "synthetic-success-percentage", "synthetic-mean-duration", ...teamsCallSignals,
    "microsoft-reported-service-status", "microsoft-reported-issue-count",
    ...activityFunctionNames.map(name => `microsoft-activity-${name}`),
  ];

  it("carry the group, tenant and signal under one unambiguous delimiter", () => {
    expect(groupSignalName("centralus", "contoso", "synthetic-success-percentage"))
      .toBe("group-centralus--tenant-contoso--synthetic-success-percentage");
    expect(groupSignalName("north-east", "alpha", "synthetic-mean-duration"))
      .not.toBe(groupSignalName("north", "east-alpha", "synthetic-mean-duration"));
  });

  it("qualify an overall signal with its tenant under the same delimiter", () => {
    expect(tenantSignalName("contoso", "synthetic-success-percentage")).toBe("tenant-contoso--synthetic-success-percentage");
    expect(tenantSignalName("north-east", "synthetic-mean-duration"))
      .not.toBe(tenantSignalName("north", "east-synthetic-mean-duration"));
  });

  it("never collide across the plain, tenant and group namespaces", () => {
    expect(everySignal.some(signal => signal.startsWith("tenant-") || signal.startsWith("group-"))).toBe(false);
    const names = everySignal.flatMap(signal => [
      signal, tenantSignalName("contoso", signal), groupSignalName("centralus", "contoso", signal),
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("stay valid model signal names (3-260 alphanumeric or hyphen characters) for every signal at the longest alias and group id", () => {
    const valid = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,258}[a-zA-Z0-9]$/;
    for (const signal of everySignal) {
      expect(signal).toMatch(valid);
      expect(tenantSignalName("t".repeat(40), signal)).toMatch(valid);
      expect(groupSignalName("g".repeat(40), "t".repeat(40), signal)).toMatch(valid);
    }
  });
});
