import { isDeepStrictEqual } from "node:util";
import { ConfigurationError } from "./config.js";
import { maxServiceTargets, probeServices, type SyntheticResult } from "./contracts.js";
import type { ResultContext } from "./otel.js";
import type { ProjectConfig, ProjectDocument } from "./project-config.js";

type TenantInventory = ProjectDocument["tenants"][number];
const userServices = ["exchange", "onedrive"] as const;
type UserService = (typeof userServices)[number];
export interface TenantGroup { id: string; displayName: string; service: UserService; targetIds: string[] }
interface Member { tenant: TenantInventory; targetIds: string[] }
interface ResolvedGroup { id: string; displayName: string; service: UserService; members: Member[] }

/** A user shared by several groups still runs once, with one consistent set of target settings. */
export function userGroupTargets<T extends { id: string }>(
  groups: Readonly<Record<string, { users: readonly T[] }>>,
): T[] {
  const targets = new Map<string, T>();
  for (const [id, group] of Object.entries(groups)) {
    if (new Set(group.users.map(user => user.id)).size !== group.users.length) {
      throw new ConfigurationError(`User group "${id}" must not repeat target IDs`);
    }
    for (const user of group.users) {
      const previous = targets.get(user.id);
      if (previous !== undefined && !isDeepStrictEqual(previous, user)) {
        throw new ConfigurationError(`User group "${id}" changes the settings of a target shared with another group`);
      }
      targets.set(user.id, user);
    }
  }
  if (targets.size > maxServiceTargets) {
    throw new ConfigurationError(`A service supports at most ${maxServiceTargets} unique user targets`);
  }
  return structuredClone([...targets.values()]);
}

export function groupSignalName(groupId: string, tenantAlias: string, signal: string): `group-${string}` {
  return `group-${groupId}--tenant-${tenantAlias}--${signal}`;
}

/** Overall signals carry their tenant when the document has several, so workers of one service never overwrite each other. */
export function tenantSignalName(tenantAlias: string, signal: string): `tenant-${string}` {
  return `tenant-${tenantAlias}--${signal}`;
}

/** Group IDs are service-local; matching IDs and names combine the same service's tenant views. */
export function resolveGroups(document: ProjectDocument): ResolvedGroup[] {
  const groups = new Map<string, ResolvedGroup>();
  for (const tenant of document.tenants) {
    for (const service of userServices) {
      const serviceGroups: Record<string, { userGroupName: string; users: { id: string }[] }> = tenant.services[service].targets;
      for (const [id, { userGroupName, users }] of Object.entries(serviceGroups)) {
        const key = `${service}:${id.toLowerCase()}`;
        const group: ResolvedGroup = groups.get(key) ?? { id, displayName: userGroupName, service, members: [] };
        if (group.id !== id || group.displayName !== userGroupName) {
          throw new ConfigurationError(`User group "${id}" must use the same ID casing and userGroupName throughout ${service}`);
        }
        group.members.push({ tenant, targetIds: users.map(user => user.id) });
        groups.set(key, group);
      }
    }
  }
  return [...groups.values()];
}

export function tenantGroups(document: ProjectDocument, tenantAlias: string): TenantGroup[] {
  return resolveGroups(document).flatMap(({ id, displayName, service, members }) => {
    const member = members.find(member => member.tenant.id === tenantAlias);
    return member ? [{ id, displayName, service, targetIds: member.targetIds }] : [];
  });
}

/** The flat `reportingGroups` Bicep parameter; groups without a runnable journey are omitted. */
export function reportingGroups(document: ProjectDocument) {
  return resolveGroups(document).flatMap(group => {
    const scopes = group.members.flatMap(({ tenant, targetIds }) => {
      const selected = tenant.services[group.service];
      const journeys = Object.entries(selected.scenarios).flatMap(([journey, enabled]) => enabled ? [journey] : []);
      return selected.enabled && targetIds.length && journeys.length ? [{ tenant: tenant.id, journeys }] : [];
    });
    return scopes.length ? [{ id: group.id, displayName: group.displayName, service: group.service, scopes }] : [];
  });
}

// The account a result exercised: the independent Exchange mailbox or the OneDrive owner.
// Teams participants are bots, not users.
function resultAccounts(services: ProjectConfig["services"], result: SyntheticResult): Pick<ResultContext, "user" | "peer"> {
  switch (probeServices[result.testType].service) {
    case "exchange": {
      const target = services.exchange.targets.find(target => target.id === result.testId);
      return target ? { user: target.mailbox } : {};
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
    groups: project.groups.filter(group => group.service === service && group.targetIds.includes(result.testId))
      .map(({ id, displayName }) => ({ id, displayName })),
  };
}
