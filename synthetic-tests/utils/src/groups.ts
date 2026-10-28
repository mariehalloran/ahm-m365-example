import { ConfigurationError } from "./config.js";
import { probeServices, testTypes, type SyntheticResult, type TestType } from "./contracts.js";
import type { ResultContext } from "./otel.js";
import type { ProjectConfig, ProjectDocument } from "./project-config.js";
import type { ServiceConfig } from "./service-config.js";

type TenantInventory = ProjectDocument["tenants"][number];
type ServiceType = ServiceConfig["type"];
/** Target ids per service; the Teams list holds both channel and meeting target ids. */
export type TargetIds = Record<ServiceType, string[]>;
export interface TenantGroup { id: string; displayName: string; targetIds: TargetIds }
interface Member { tenant: TenantInventory; targetIds: TargetIds }
interface ResolvedGroup { id: string; displayName: string; members: Member[] }
interface Match { tenant: string; service: ServiceType; id: string }
interface Owners { accounts: Map<string, Match[]>; teams: Map<string, Match[]> }

export function groupSignalName(groupId: string, tenantAlias: string, signal: string): `group-${string}` {
  return `group-${groupId}--tenant-${tenantAlias}--${signal}`;
}

/** Overall signals carry their tenant when the document has several, so workers of one service never overwrite each other. */
export function tenantSignalName(tenantAlias: string, signal: string): `tenant-${string}` {
  return `tenant-${tenantAlias}--${signal}`;
}

// The targets each account (an Exchange mailbox or OneDrive owner, case-insensitive) or Teams id selects in any tenant.
function indexOwners(tenants: TenantInventory[]): Owners {
  const owners: Owners = { accounts: new Map(), teams: new Map() };
  const add = (index: Map<string, Match[]>, key: string | undefined, match: Match) => {
    if (key) index.set(key, [...(index.get(key) ?? []), match]);
  };
  for (const { id: tenant, services } of tenants) {
    for (const target of services.exchange.targets) {
      add(owners.accounts, target.mailbox?.toLowerCase(), { tenant, service: "exchange", id: target.id });
    }
    for (const target of services.onedrive.targets) {
      add(owners.accounts, target.userPrincipalName?.toLowerCase(), { tenant, service: "onedrive", id: target.id });
    }
    for (const id of new Set([...services.teams.targets, ...services.teams.callTargets].map(target => target.id))) {
      add(owners.teams, id, { tenant, service: "teams", id });
    }
  }
  return owners;
}

// Errors name the group and list position, never the configured account or target value.
function inOneTenant(where: string, matches: Match[]): Match[] {
  const tenants = new Set(matches.map(match => match.tenant)).size;
  if (tenants === 0) throw new ConfigurationError(`${where} matches no configured target`);
  if (tenants > 1) throw new ConfigurationError(`${where} matches targets in more than one tenant`);
  return matches;
}

function rejectRepeats(where: string, values: string[]): void {
  if (new Set(values).size !== values.length) throw new ConfigurationError(`${where} must not repeat entries`);
}

function resolveGroup(
  tenants: TenantInventory[], owners: Owners, group: ProjectDocument["groups"][number],
): ResolvedGroup {
  const label = `Group "${group.id}"`;
  if (!group.accounts.length && !group.teams.length) {
    throw new ConfigurationError(`${label} needs at least one account or Teams target`);
  }
  rejectRepeats(`${label} accounts`, group.accounts.map(account => account.toLowerCase()));
  rejectRepeats(`${label} teams`, group.teams);
  const matches = [
    ...group.accounts.flatMap((account, index) =>
      inOneTenant(`${label} accounts[${index}]`, owners.accounts.get(account.toLowerCase()) ?? [])),
    ...group.teams.flatMap((id, index) => inOneTenant(`${label} teams[${index}]`, owners.teams.get(id) ?? [])),
  ];
  const members = tenants.flatMap(tenant => {
    const owned = matches.filter(match => match.tenant === tenant.id);
    const targetIds: TargetIds = { exchange: [], teams: [], onedrive: [] };
    for (const match of owned) targetIds[match.service].push(match.id);
    return owned.length ? [{ tenant, targetIds }] : [];
  });
  return { id: group.id, displayName: group.displayName, members };
}

/** Validates every group against the tenant inventories and derives each member's tenant. */
export function resolveGroups(document: ProjectDocument): ResolvedGroup[] {
  rejectRepeats("Group ids", document.groups.map(group => group.id));
  const owners = indexOwners(document.tenants);
  return document.groups.map(group => resolveGroup(document.tenants, owners, group));
}

export function tenantGroups(document: ProjectDocument, tenantAlias: string): TenantGroup[] {
  return resolveGroups(document).flatMap(({ id, displayName, members }) => {
    const member = members.find(member => member.tenant.id === tenantAlias);
    return member ? [{ id, displayName, targetIds: member.targetIds }] : [];
  });
}

const journeyTargets = (tenant: TenantInventory, type: TestType): readonly { id: string }[] =>
  type === "teams-call" ? tenant.services.teams.callTargets : tenant.services[probeServices[type].service].targets;

// Each enabled journey the member can observe, grouped by service in catalogue order.
function memberScopes({ tenant, targetIds }: Member) {
  const journeys = new Map<ServiceType, string[]>();
  for (const type of testTypes) {
    const { service, journey } = probeServices[type];
    const selected = tenant.services[service];
    const observed = journeyTargets(tenant, type).some(target => targetIds[service].includes(target.id));
    if (selected.enabled && (selected.scenarios as Record<string, boolean>)[journey] && observed) {
      journeys.set(service, [...(journeys.get(service) ?? []), journey]);
    }
  }
  return [...journeys].map(([service, names]) => ({ tenant: tenant.id, service, journeys: names }));
}

/** The flat `reportingGroups` Bicep parameter; groups without a runnable journey are omitted. */
export function reportingGroups(document: ProjectDocument) {
  return resolveGroups(document).flatMap(group => {
    const scopes = group.members.flatMap(memberScopes);
    return scopes.length ? [{ id: group.id, displayName: group.displayName, scopes }] : [];
  });
}

// The accounts a result exercised: the Exchange initiating mailbox and its recipient, or the OneDrive owner.
// Teams participants are bots, not users.
function resultAccounts(services: ProjectConfig["services"], result: SyntheticResult): Pick<ResultContext, "user" | "peer"> {
  switch (probeServices[result.testType].service) {
    case "exchange": {
      const target = services.exchange.targets.find(target => target.id === result.testId);
      return {
        ...(target?.mailbox ? { user: target.mailbox } : {}),
        ...(target?.recipientMailbox ? { peer: target.recipientMailbox } : {}),
      };
    }
    case "onedrive": {
      const user = services.onedrive.targets.find(target => target.id === result.testId)?.userPrincipalName;
      return user ? { user } : {};
    }
    case "teams": return {};
  }
}

/** What the OTEL logs say about a result: its tenant, the account it exercised and every group its target belongs to. */
export function resultContext(project: ProjectConfig, result: SyntheticResult): ResultContext {
  const { service } = probeServices[result.testType];
  return {
    tenant: project.tenant.id,
    ...resultAccounts(project.services, result),
    groups: project.groups.filter(group => group.targetIds[service].includes(result.testId))
      .map(({ id, displayName }) => ({ id, displayName })),
  };
}
