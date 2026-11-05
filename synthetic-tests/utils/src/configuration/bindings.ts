import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { ConfigurationError } from "./config.js";
import { at, isRecord, records } from "./raw-config.js";
import { accountTargetId } from "./account-identity.js";
import { sharePointTargetId } from "./sharepoint-target.js";

/**
 * Generated IDs live in a gitignored `.env` next to the config file, one `TENANT__ID__FIELD=value` per line. The ID is
 * derived from an account address, a Teams target's id, or the service name for its own settings.
 */
export type Bindings = NodeJS.Dict<string>;
export type BindingField =
  | "REPLY_SEED_MESSAGE_ID" | "REPLY_SEED_CORRELATION_ID" | "CHANNEL_ID" | "DRIVE_ID" | "FOLDER_ID" | "USER_ID"
  | "ORGANIZER_USER_ID" | "BOT_CLIENT_ID" | "BOT_PEER_CLIENT_ID" | "CALLING_CALLBACK_URL" | "SITE_ID" | "LIST_ID"
  | "IDENTITY_CLIENT_ID";
type BindingGroup = Partial<Record<BindingField, string>>;
type ServiceBindings = Partial<Record<"service" | "targets" | "callTargets" | "botPairs", BindingGroup[]>>;

// The fields each service takes from the bindings, for its own settings and for each list of targets. The keys of one group are set together or not at all.
const serviceBindings: Record<string, ServiceBindings> = {
  exchange: {
    service: [{ IDENTITY_CLIENT_ID: "identityClientId" }],
    targets: [{ REPLY_SEED_MESSAGE_ID: "replySeed.messageId", REPLY_SEED_CORRELATION_ID: "replySeed.correlationId" }],
  },
  teams: {
    service: [{ CALLING_CALLBACK_URL: "execution.teamsCallingCallbackUrl" }, { IDENTITY_CLIENT_ID: "identityClientId" }],
    botPairs: [{ BOT_CLIENT_ID: "botClientId", BOT_PEER_CLIENT_ID: "botPeerClientId" }],
    targets: [{ CHANNEL_ID: "channelId" }],
    callTargets: [{ ORGANIZER_USER_ID: "organizerUserId" }],
  },
  onedrive: {
    service: [{ IDENTITY_CLIENT_ID: "identityClientId" }],
    targets: [{ USER_ID: "userId" }, { DRIVE_ID: "driveId" }, { FOLDER_ID: "folderId" }],
  },
  sharepoint: {
    service: [{ IDENTITY_CLIENT_ID: "identityClientId" }],
    targets: [{ SITE_ID: "siteId" }, { DRIVE_ID: "driveId", FOLDER_ID: "folderId" }, { LIST_ID: "listId" }],
  },
};

const keyPart = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
const idPrefix = (tenantAlias: string, id: string) => `${keyPart(tenantAlias)}__${keyPart(id)}`;
export const bindingKey = (tenantAlias: string, id: string, field: BindingField) =>
  `${idPrefix(tenantAlias, id)}__${field}`;

export const bindingsFile = (configFile: string) => join(dirname(resolve(configFile)), ".env");

/** The `.env` text next to the config file; empty when there is none. */
export async function readBindingsText(configFile: string): Promise<string> {
  try { return (await readFile(bindingsFile(configFile), "utf8")).replace(/^\uFEFF/, ""); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
    throw new ConfigurationError("Cannot read the .env bindings file next to the project config");
  }
}

export const parseBindings = (text: string): Bindings => parseEnv(text);

export async function readBindings(configFile: string): Promise<Bindings> {
  return parseBindings(await readBindingsText(configFile));
}

/**
 * Returns a copy of the raw config JSON with every generated field filled in from the bindings, matched by tenant alias
 * and target id (or service name). Anything that is not the expected shape is left for the config schema to report.
 */
export function applyBindings(raw: unknown, bindings: Bindings): unknown {
  const document = structuredClone(raw);
  const deployment = at(document, "deployment");
  if (isRecord(deployment)) {
    if (isRecord(deployment.functions) && bindings.FUNCTION_API_CLIENT_ID) {
      setField(deployment.functions, "apiClientId", bindings.FUNCTION_API_CLIENT_ID, "FUNCTION_API_CLIENT_ID");
    }
    if (isRecord(deployment.coordinator) && bindings.COORDINATOR_CLIENT_ID) {
      setField(deployment.coordinator, "identityClientId", bindings.COORDINATOR_CLIENT_ID, "COORDINATOR_CLIENT_ID");
    }
  }
  for (const tenant of records(at(document, "tenants"))) {
    if (typeof tenant.id !== "string") continue;
    for (const [name, fields] of Object.entries(serviceBindings)) {
      const service = at(tenant, "services", name);
      if (isRecord(service)) bindService(tenant.id, name, service, fields, bindings);
    }
  }
  return document;
}

function bindService(
  tenantAlias: string, name: string, service: Record<string, unknown>, fields: ServiceBindings, bindings: Bindings,
): void {
  const targets = name === "teams" || name === "sharepoint" ? records(service.targets)
    : Object.values(isRecord(service.targets) ? service.targets : {}).flatMap(group => records(at(group, "users")));
  const callTargets = records(service.callTargets);
  const botPairs = records(service.botPairs);
  const targetId = (target: Record<string, unknown>) => {
    if (name === "teams") return target.id;
    if (name === "sharepoint") {
      const { siteUrl, libraryName, folderName, listName } = target;
      return typeof siteUrl === "string" && typeof libraryName === "string" &&
        typeof folderName === "string" && typeof listName === "string"
        ? sharePointTargetId({ siteUrl, libraryName, folderName, listName }) : undefined;
    }
    const address = name === "exchange" ? target.mailbox : target.userPrincipalName;
    return typeof address === "string" ? accountTargetId(address) : undefined;
  };
  rejectCollidingTargets(tenantAlias, [{ id: name }, ...targets.map(target => ({ id: targetId(target) })), ...callTargets, ...botPairs]);
  bindFields(tenantAlias, name, service, fields.service, bindings);
  for (const target of targets) bindFields(tenantAlias, targetId(target), target, fields.targets, bindings);
  for (const target of callTargets) bindFields(tenantAlias, target.id, target, fields.callTargets, bindings);
  for (const pair of botPairs) bindFields(tenantAlias, pair.id, pair, fields.botPairs, bindings);
}

function rejectCollidingTargets(tenantAlias: string, targets: Record<string, unknown>[]): void {
  const owners = new Map<string, string>();
  for (const { id } of targets) {
    if (typeof id !== "string") continue;
    const prefix = idPrefix(tenantAlias, id);
    const owner = owners.get(prefix) ?? id;
    if (owner !== id) {
      throw new ConfigurationError(`Targets ${owner} and ${id} of tenant ${tenantAlias} share the .env key prefix ${prefix}; rename one so they differ by more than letter case and punctuation`);
    }
    owners.set(prefix, id);
  }
}

function bindFields(
  tenantAlias: string, id: unknown, holder: Record<string, unknown>, groups: BindingGroup[] | undefined, bindings: Bindings,
): void {
  if (typeof id !== "string" || groups === undefined) return;
  for (const group of groups) {
    const parts = (Object.entries(group) as [BindingField, string][]).map(([field, path]) => {
      const key = bindingKey(tenantAlias, id, field);
      return { key, path, value: bindings[key] || undefined };
    });
    const present = parts.filter(part => part.value !== undefined);
    if (present.length === 0) continue;
    if (present.length < parts.length) {
      throw new ConfigurationError(`${parts.map(part => part.key).join(" and ")} must be set together in .env`);
    }
    for (const { key, path, value } of parts) setField(holder, path, value!, key);
  }
}

function setField(target: Record<string, unknown>, path: string, value: string, key: string): void {
  const names = path.split(".");
  const field = names.pop()!;
  let holder = target;
  for (const name of names) {
    if (holder[name] === undefined) holder[name] = {};
    const next = holder[name];
    if (!isRecord(next)) return;
    holder = next;
  }
  if (holder[field] === undefined) holder[field] = value;
  else if (holder[field] !== value) {
    throw new ConfigurationError(`${key} in .env conflicts with ${path} in the project config; keep generated IDs only in .env`);
  }
}
