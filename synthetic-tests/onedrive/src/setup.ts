import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigurationError } from "../../utils/src/configuration/config.js";
import { maxOneDriveTargets, type DiagnosticCategory, type Telemetry } from "../../utils/src/contracts.js";
import { graphNextPagePath, type GraphClient } from "../../utils/src/integrations/graph.js";
import { categoryOf, IntegrationError } from "../../utils/src/integrations/http.js";
import type { ProjectConfig } from "../../utils/src/configuration/project-config.js";

type Target = ProjectConfig["services"]["onedrive"]["targets"][number];
export type SetupGraph = Pick<GraphClient, "json" | "authenticate">;
export interface FolderBinding { targetId: string; driveId: string; folderId: string }
type Stage = "drive" | "folder" | "permission" | "configuration";
type PermissionAction = "retain" | "grant" | "upgrade";
export type SetupOutcome =
  | { targetId: string; status: "ready" | "planned"; folderAction: "retain" | "create"; permissionAction: PermissionAction }
  | { targetId: string; status: "failed"; stage: Stage; category: DiagnosticCategory; httpStatus?: number; message?: string };
export interface SetupSummary {
  total: number; ready: number; planned: number; failed: number; notStarted: number; outcomes: SetupOutcome[];
}
export interface SetupOptions {
  workerClientId: string;
  apply: boolean;
  concurrency: number;
  targetTimeoutSeconds: number;
  signal: AbortSignal;
  telemetry: Telemetry;
  checkpoint?: (binding: FolderBinding) => Promise<void>;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const driveSchema = z.object({ id: z.string().min(1), driveType: z.literal("business") });
const rootSchema = z.object({ id: z.string().min(1) });
const folderSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), folder: z.object({}),
  parentReference: z.object({ id: z.string().min(1), driveId: z.string().min(1) }),
  root: z.object({}).nullish(),
});
const applicationIdentity = z.object({ application: z.object({ id: z.string().min(1) }).nullish() });
const permissionSchema = z.object({
  id: z.string().min(1), roles: z.array(z.string()).min(1),
  grantedToV2: applicationIdentity.nullish(),
  grantedToIdentitiesV2: z.array(applicationIdentity).nullish(),
  inheritedFrom: z.object({}).nullish(),
});
type Permission = z.infer<typeof permissionSchema>;
const permissionsSchema = z.object({
  value: z.array(permissionSchema).max(200), "@odata.nextLink": z.string().optional(),
});
const encoded = encodeURIComponent;

async function optionalFolder(graph: SetupGraph, path: string, signal: AbortSignal) {
  try { return await graph.json(path, folderSchema, signal); }
  catch (error) {
    if (error instanceof IntegrationError && error.status === 404) return undefined;
    throw error;
  }
}

function ambiguousMutation(error: unknown): error is IntegrationError {
  return error instanceof IntegrationError && error.category === "graph-unavailable" &&
    (error.status === undefined || [409, 500, 502, 503, 504].includes(error.status));
}

async function ensureFolder(
  graph: SetupGraph, target: Target, driveId: string, options: SetupOptions, signal: AbortSignal,
) {
  const drive = `/drives/${encoded(driveId)}`;
  const root = await graph.json(`${drive}/root?$select=id`, rootSchema, signal);
  const path = target.folderId ? `${drive}/items/${encoded(target.folderId)}`
    : `${drive}/root:/${encoded(target.folderName!)}`;
  let folder = await optionalFolder(graph, path, signal);
  const folderAction = folder ? "retain" : "create";
  if (!folder && target.folderId) {
    throw new ConfigurationError("The configured folderId no longer resolves; review and remove the stale binding before rerunning setup");
  }
  if (!folder && options.apply) {
    try {
      folder = await graph.json(`${drive}/root/children`, folderSchema, signal, "POST", {
        name: target.folderName, folder: {}, "@microsoft.graph.conflictBehavior": "fail",
      }, false);
    } catch (error) {
      if (!ambiguousMutation(error) || signal.aborted) throw error;
      folder = await optionalFolder(graph, path, signal);
      if (!folder) throw error;
      options.telemetry.emit("onedrive-setup-mutation-reconciled", { targetId: target.id, operation: "create-folder" });
    }
  }
  if (folder && (folder.root || folder.id === root.id || folder.id === folder.parentReference.id ||
      folder.name !== target.folderName || folder.parentReference.driveId !== driveId ||
      (target.folderId ? folder.id !== target.folderId : folder.parentReference.id !== root.id))) {
    throw new ConfigurationError("The dedicated folder does not match the approved name, drive and non-root location");
  }
  return { folder, folderAction } as const;
}

async function listPermissions(graph: SetupGraph, collection: string, signal: AbortSignal): Promise<Permission[]> {
  const permissions: Permission[] = [];
  let path: string | undefined = collection;
  for (let page = 0; path && page < 10; page++) {
    const result: z.infer<typeof permissionsSchema> = await graph.json(path, permissionsSchema, signal);
    permissions.push(...result.value);
    path = result["@odata.nextLink"] ? graphNextPagePath(result["@odata.nextLink"], collection) : undefined;
  }
  if (path) throw new IntegrationError("read-failure");
  return permissions;
}

function forApplication(permission: Permission, clientId: string): boolean {
  const identities = [permission.grantedToV2, ...permission.grantedToIdentitiesV2 ?? []];
  return identities.some(identity => identity?.application?.id.toLowerCase() === clientId.toLowerCase());
}

function writable(permission: Permission): boolean {
  return permission.roles.some(role => ["write", "owner", "fullcontrol"].includes(role.toLowerCase()));
}

async function waitForWritePermission(
  graph: SetupGraph, collection: string, options: SetupOptions, signal: AbortSignal,
): Promise<boolean> {
  const sleep = options.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await sleep(500 * 2 ** (attempt - 1), signal);
    const observed = await listPermissions(graph, collection, signal);
    if (observed.some(permission => forApplication(permission, options.workerClientId) && writable(permission))) return true;
  }
  return false;
}

async function ensurePermission(
  graph: SetupGraph, driveId: string, folderId: string, targetId: string, options: SetupOptions, signal: AbortSignal,
): Promise<PermissionAction> {
  const collection = `/drives/${encoded(driveId)}/items/${encoded(folderId)}/permissions`;
  const existing = (await listPermissions(graph, collection, signal))
    .filter(permission => forApplication(permission, options.workerClientId));
  if (existing.some(writable)) return "retain";
  const direct = existing.find(permission => !permission.inheritedFrom);
  const action = direct ? "upgrade" : "grant";
  if (!options.apply) return action;
  let mutationError: IntegrationError | undefined;
  try {
    if (direct) {
      await graph.json(`${collection}/${encoded(direct.id)}`, permissionSchema, signal, "PATCH", { roles: ["write"] });
    } else {
      await graph.json(collection, permissionSchema, signal, "POST", {
        grantedToV2: { application: { id: options.workerClientId } }, roles: ["write"],
      }, false);
    }
  } catch (error) {
    if (!ambiguousMutation(error) || signal.aborted) throw error;
    mutationError = error;
  }
  if (!await waitForWritePermission(graph, collection, options, signal)) {
    throw mutationError ?? new IntegrationError("permission-failure");
  }
  if (mutationError) {
    options.telemetry.emit("onedrive-setup-mutation-reconciled", { targetId, operation: "grant-folder-write" });
  }
  return action;
}

export async function setupOneDriveTargets(
  targets: Target[], graph: SetupGraph, options: SetupOptions,
): Promise<SetupSummary> {
  if (!z.string().uuid().safeParse(options.workerClientId).success ||
      !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 10 ||
      !Number.isInteger(options.targetTimeoutSeconds) || options.targetTimeoutSeconds < 30 || options.targetTimeoutSeconds > 3600 ||
      targets.length === 0 || targets.length > maxOneDriveTargets ||
      targets.some(target => !target.userId || !target.userPrincipalName || !target.folderName)) {
    throw new ConfigurationError("Setup requires approved userId/userPrincipalName/folderName targets (run npm run setup:ids first: it looks each userId up from its userPrincipalName and writes it to .env), a worker client ID, concurrency 1-10 and target timeout 30-3600 seconds");
  }
  if (options.apply && !options.checkpoint) {
    throw new ConfigurationError("Applying setup requires a configuration checkpoint for verified account bindings");
  }
  options.signal.throwIfAborted();
  await graph.authenticate(AbortSignal.any([options.signal, AbortSignal.timeout(options.targetTimeoutSeconds * 1000)]));
  const stopped = new AbortController();
  const signal = AbortSignal.any([options.signal, stopped.signal]);
  const outcomes: SetupOutcome[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency, targets.length) }, async () => {
    while (next < targets.length && !signal.aborted) {
      const target = targets[next++]!;
      const targetSignal = AbortSignal.any([signal, AbortSignal.timeout(options.targetTimeoutSeconds * 1000)]);
      let stage: Stage = "drive";
      let outcome: SetupOutcome;
      try {
        const drive = await graph.json(`/users/${encoded(target.userId!)}/drive?$select=id,driveType`, driveSchema, targetSignal);
        if (target.driveId && drive.id !== target.driveId) {
          throw new ConfigurationError("The configured driveId does not belong to the selected user");
        }
        stage = "folder";
        const { folder, folderAction } = await ensureFolder(graph, target, drive.id, options, targetSignal);
        stage = "permission";
        const permissionAction = folder
          ? await ensurePermission(graph, drive.id, folder.id, target.id, options, targetSignal) : "grant";
        if (options.apply) {
          if (!folder || !options.checkpoint) throw new IntegrationError("collector-failure");
          targetSignal.throwIfAborted();
          stage = "configuration";
          await options.checkpoint({ targetId: target.id, driveId: drive.id, folderId: folder.id });
        }
        outcome = { targetId: target.id, status: options.apply ? "ready" : "planned", folderAction, permissionAction };
      } catch (error) {
        outcome = {
          targetId: target.id, status: "failed", stage,
          category: error instanceof ConfigurationError ? "configuration-failure"
            : targetSignal.aborted ? "cancelled" : categoryOf(error),
          ...(error instanceof IntegrationError && error.status !== undefined ? { httpStatus: error.status } : {}),
          ...(error instanceof ConfigurationError ? { message: error.message } : {}),
        };
        if (stage === "configuration" || (error instanceof IntegrationError && error.category === "authentication-failure")) {
          stopped.abort();
        }
      }
      outcomes.push(outcome);
      options.telemetry.emit("onedrive-setup-target", { ...outcome, completed: outcomes.length, total: targets.length });
    }
  }));
  const summary = {
    total: targets.length, ready: outcomes.filter(outcome => outcome.status === "ready").length,
    planned: outcomes.filter(outcome => outcome.status === "planned").length,
    failed: outcomes.filter(outcome => outcome.status === "failed").length,
    notStarted: targets.length - outcomes.length, outcomes,
  };
  options.telemetry.emit("onedrive-setup-summary", {
    total: summary.total, ready: summary.ready, planned: summary.planned, failed: summary.failed, notStarted: summary.notStarted,
    apply: options.apply, concurrency: options.concurrency,
  });
  return summary;
}
