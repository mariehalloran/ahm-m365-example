import { bindingKey, saveBindings } from "../../utils/src/configuration/bindings.js";
import { ConfigurationError } from "../../utils/src/configuration/config.js";
import { readProjectService } from "../../utils/src/configuration/project-config.js";
import { consoleTelemetry, type Telemetry } from "../../utils/src/contracts.js";
import { serviceEnvironment, validateProjectTenantBinding, validateRuntimeConsent } from "../../utils/src/execution/runtime.js";
import { createLiveGraphClient } from "../../utils/src/integrations/auth.js";
import type { GraphOperations } from "../../utils/src/integrations/graph.js";
import { canonicalProjectFile } from "../../utils/src/paths.js";
import { discoverSharePointBindings } from "./targets.js";

/** Discovers approved targets, saving local bindings or verifying the deployed immutable configuration. */
export async function setupSharePointIds(options: {
  file?: string;
  tenant?: string;
  env?: NodeJS.ProcessEnv;
  graph?: GraphOperations;
  telemetry?: Telemetry;
  save?: typeof saveBindings;
} = {}): Promise<{ targets: number; skipped: boolean }> {
  const file = options.file ?? canonicalProjectFile;
  const { project, service } = await readProjectService("sharepoint", file, options.tenant);
  const telemetry = options.telemetry ?? consoleTelemetry;
  if (!service.enabled) {
    telemetry.emit("sharepoint-setup-skipped", { tenant: project.tenant.id, reason: "service-disabled", targets: 0 });
    return { targets: 0, skipped: true };
  }
  if (service.type !== "sharepoint" || service.mode !== "live" || service.graphAuthentication !== "managed-identity") {
    throw new ConfigurationError("SharePoint ID setup requires the selected live service and explicit managed-identity authentication");
  }
  const env = serviceEnvironment(project, service, options.env ?? process.env, file);
  validateRuntimeConsent(service, env);
  validateProjectTenantBinding(project.tenant, service, env);
  const graph = options.graph ?? createLiveGraphClient(env, "managed-identity");
  const hosted = env.MONITORING_CONFIG_BLOB_URL !== undefined;
  for (const target of service.targets) {
    const signal = AbortSignal.timeout(120000);
    await graph.authenticate(signal);
    const ids = await discoverSharePointBindings(graph, target, signal);
    const entries = Object.fromEntries(([
      ["SITE_ID", ids.siteId], ["DRIVE_ID", ids.driveId], ["FOLDER_ID", ids.folderId], ["LIST_ID", ids.listId],
    ] as const).map(([field, value]) => [bindingKey(project.tenant.id, target.id, field), value]));
    if (hosted) {
      if (target.siteId !== ids.siteId || target.driveId !== ids.driveId ||
          target.folderId !== ids.folderId || target.listId !== ids.listId) {
        throw new ConfigurationError("Discovered SharePoint IDs differ from the deployed immutable configuration; refresh generated bindings and redeploy");
      }
    } else {
      await (options.save ?? saveBindings)(file, entries);
    }
    telemetry.emit("sharepoint-ids-resolved", {
      tenant: project.tenant.id, targetId: target.id, fields: Object.keys(entries),
      bindings: hosted ? "verified-deployed-snapshot" : "saved-env",
    });
  }
  return { targets: service.targets.length, skipped: false };
}
