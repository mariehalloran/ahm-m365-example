import { writeFile } from "node:fs/promises";
import { ConfigurationError } from "../configuration/config.js";
import { azJson, runFile, type DeploymentRun } from "./deploy-phases.js";

interface LegacyResource { id: string; name: string; type: string; tags?: Record<string, string>; runningStatus?: string }

/** Detects obsolete execution/transport resources without deleting historical data or cloud resources. */
export async function detectLegacyResources(run: DeploymentRun): Promise<void> {
  const { document, settings } = run.prepared;
  const resources = await azJson<LegacyResource[]>(run, "legacy-resource-inventory", [
    "resource", "list", "--resource-group", document.healthModel.resourceGroup, ...run.subscription,
    "--query", "[].{id:id,name:name,type:type,tags:tags}",
  ]);
  const owned = resources.filter(resource => resource.tags?.workload === document.healthModel.name);
  const legacy = owned.filter(resource =>
    resource.tags?.purpose === "synthetic-worker" && resource.type.toLowerCase() === "microsoft.app/containerapps" ||
    resource.tags?.purpose === "synthetic-observations" &&
      ["microsoft.web/sites", "microsoft.eventhub/namespaces", "microsoft.web/serverfarms", "microsoft.managedidentity/userassignedidentities", "microsoft.storage/storageaccounts"].includes(resource.type.toLowerCase()));
  const active: LegacyResource[] = [];
  for (const resource of legacy) {
    if (resource.type.toLowerCase() === "microsoft.app/containerapps") {
      const status = await azJson<{ runningStatus?: string }>(run, "legacy-worker-state", [
        "containerapp", "show", "--ids", resource.id, ...run.subscription, "--query", "{runningStatus:properties.runningStatus}",
      ]);
      if (status.runningStatus !== "Stopped") active.push({ ...resource, runningStatus: status.runningStatus ?? "unknown" });
    } else if (resource.type.toLowerCase() === "microsoft.web/sites") {
      const status = await azJson<{ state?: string }>(run, "legacy-ingestion-state", [
        "functionapp", "show", "--ids", resource.id, ...run.subscription, "--query", "{state:properties.state}",
      ]);
      if (status.state !== "Stopped") active.push({ ...resource, runningStatus: status.state ?? "unknown" });
    }
  }
  const coordinator = owned.find(resource => resource.type.toLowerCase() === "microsoft.app/containerapps" && resource.name === settings.coordinator.appName);
  run.previousCoordinator = Boolean(coordinator);
  await writeFile(runFile(run, "legacy-resources.json"), JSON.stringify({ legacy, active }, null, 2), { mode: 0o600 });
  run.emit({ event: "legacy-resource-prerequisites", legacyResourceCount: legacy.length, activeLegacyExecutorCount: active.length, automaticDeletion: false });
  if (active.length) throw new ConfigurationError("Stop obsolete Graph workers and the old ingestion Function before migrating; inspect legacy-resources.json and run setup/stop-legacy-execution.ps1 explicitly");
}
