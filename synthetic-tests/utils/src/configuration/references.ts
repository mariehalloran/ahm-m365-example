import { ConfigurationError } from "./config.js";
import { at, isRecord, records } from "./raw-config.js";

export const managedIdentityType = "Microsoft.ManagedIdentity/userAssignedIdentities";
const botType = "Microsoft.BotService/botServices";
const defaultTeamsServiceUrl = "https://smba.trafficmanager.net/teams/";

/** A key that names an Azure resource, the canonical key holding its resource ID and the resource type. */
type Reference = readonly [name: string, canonical: string, type: string];
const foundationReferences: Reference[] = [
  ["environment", "environmentResourceId", "Microsoft.App/managedEnvironments"],
  ["registry", "registryResourceId", "Microsoft.ContainerRegistry/registries"],
];
const workerReferences: Reference[] = [["identity", "identityResourceId", managedIdentityType]];
const teamsPairReferences: Reference[] = [
  ["bot", "botResourceId", botType],
  ["identity", "identityResourceId", managedIdentityType],
  ["peerBot", "botPeerResourceId", botType],
  ["peerIdentity", "botPeerManagedIdentityResourceId", managedIdentityType],
];

interface Scope {
  subscriptionId: string;
  resourceGroup: string;
}

/** Resolves a bare resource name in the health model's resource group to a full ARM resource ID, or returns an existing ARM ID unchanged. */
export function healthModelResourceId(scope: Scope, type: string, nameOrId: string): string {
  if (/^\/subscriptions\//i.test(nameOrId)) {
    return nameOrId;
  }
  return `/subscriptions/${scope.subscriptionId}/resourceGroups/${scope.resourceGroup}/providers/${type}/${nameOrId}`;
}

/** Extracts the subscription ID and resource group scope from the document's `healthModel` section when both are strings. */
function healthModelScope(document: Record<string, unknown>): Scope | undefined {
  const subscriptionId = at(document, "healthModel", "subscriptionId");
  const resourceGroup = at(document, "healthModel", "resourceGroup");
  if (typeof subscriptionId === "string" && typeof resourceGroup === "string") {
    return { subscriptionId, resourceGroup };
  }
  return undefined;
}

/** Expands shorthand resource name properties into canonical ARM resource ID properties within a configuration object. */
function expandResourceReferences(holder: unknown, references: readonly Reference[], scope: Scope | undefined, where: string): void {
  if (!isRecord(holder)) {
    return;
  }
  for (const [name, canonical, type] of references) {
    const value = holder[name];
    if (value === undefined) {
      continue;
    }
    if (holder[canonical] !== undefined) {
      throw new ConfigurationError(`${where} sets both ${name} and ${canonical}; set only one of them`);
    }
    if (typeof value !== "string" || scope === undefined) {
      continue;
    }
    holder[canonical] = healthModelResourceId(scope, type, value);
    delete holder[name];
  }
}

/** Populates a missing string property on a configuration object when a string default value is available. */
function defaultString(holder: Record<string, unknown>, key: string, value: unknown): void {
  if (holder[key] === undefined && typeof value === "string") {
    holder[key] = value;
  }
}

/** Defaults `deployment.azureTenantId` from a single-tenant inventory, or requires an explicit setting for multi-tenant configs. */
function defaultAzureTenantId(deployment: Record<string, unknown>, tenants: unknown[]): void {
  if (deployment.azureTenantId !== undefined) {
    return;
  }
  if (tenants.length > 1) {
    throw new ConfigurationError("deployment.azureTenantId is required when the config has several tenants; set it to the tenant ID of the Azure subscription");
  }
  defaultString(deployment, "azureTenantId", at(tenants[0], "tenantId"));
}

/** Propagates a tenant-level `providerClientId` to a service's execution block when provider collection is enabled. */
function inheritProviderClientId(execution: unknown, providerClientId: unknown): void {
  if (!isRecord(execution) || providerClientId === undefined || execution.providerClientId !== undefined) {
    return;
  }
  const usesProviderCollection =
    execution.serviceHealth === true ||
    execution.serviceMessages === true ||
    at(execution, "serviceActivity", "enabled") === true;
  if (usesProviderCollection) {
    execution.providerClientId = providerClientId;
  }
}

/** Expands shorthand resource references and default fields on a tenant's Teams configuration block. */
function expandTeams(teams: unknown, tenantId: unknown, scope: Scope | undefined, where: string): void {
  if (!isRecord(teams)) {
    return;
  }
  for (const [index, pair] of records(teams.botPairs).entries()) {
    expandResourceReferences(pair, teamsPairReferences, scope, `${where}.botPairs.${index}`);
  }
  for (const target of records(teams.targets)) {
    defaultString(target, "tenantId", tenantId);
    defaultString(target, "serviceUrl", defaultTeamsServiceUrl);
  }
  for (const target of records(teams.callTargets)) {
    defaultString(target, "tenantId", tenantId);
    delete target.organizer; // Read only by the setup script, which writes organizerUserId to .env.
  }
}

/** Expands worker resource references, provider client IDs, and Teams target defaults for a single tenant entry. */
function expandTenant(tenant: Record<string, unknown>, index: number, scope: Scope | undefined): void {
  const providerClientId = tenant.providerClientId;
  delete tenant.providerClientId;
  for (const service of ["exchange", "teams", "onedrive"]) {
    const where = `tenants.${index}.services.${service}`;
    expandResourceReferences(at(tenant, "services", service, "worker"), workerReferences, scope, `${where}.worker`);
    inheritProviderClientId(at(tenant, "services", service, "execution"), providerClientId);
  }
  expandTeams(at(tenant, "services", "teams"), tenant.tenantId, scope, `tenants.${index}.services.teams`);
}

/**
 * Returns a copy of the raw config JSON in the canonical shape the schema validates: resource names become resource IDs
 * (full IDs are kept), omitted IDs and URLs take their defaults, the tenant's provider app reaches its services and the
 * setup-only `organizer` is dropped. Canonical documents come back unchanged. Anything that is not the expected shape is
 * left for the config schema to report.
 */
export function expandReferences(raw: unknown): unknown {
  const document = structuredClone(raw);
  if (!isRecord(document)) {
    return document;
  }
  const scope = healthModelScope(document);
  const tenants = Array.isArray(document.tenants) ? document.tenants : [];
  if (isRecord(document.deployment)) {
    expandResourceReferences(document.deployment.foundation, foundationReferences, scope, "deployment.foundation");
    defaultAzureTenantId(document.deployment, tenants);
  }
  for (const [index, tenant] of tenants.entries()) {
    if (isRecord(tenant)) {
      expandTenant(tenant, index, scope);
    }
  }
  return document;
}
