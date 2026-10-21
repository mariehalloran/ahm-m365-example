import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareDeploymentParameters } from "../src/prepare-deployment.js";
import { readProjectConfig } from "../src/project-config.js";
import { readServiceConfig } from "../src/service-config.js";

let directory: string;
let projectFile: string;
const checkedIn = await readProjectConfig("../monitoring.config.json");
beforeEach(async () => {
  directory = `.deployment-test-${randomUUID()}`;
  await mkdir(directory);
  projectFile = join(directory, "monitoring.json");
  await mkdir(join(directory, "profiles"));
  const project = structuredClone(checkedIn);
  project.healthModel.subscriptionId = "11111111-1111-4111-8111-111111111111";
  for (const type of ["exchange", "teams", "sharepoint"] as const) {
    project.services[type].configFile = `profiles/${type}.json`;
    await writeFile(join(directory, project.services[type].configFile), JSON.stringify(await readServiceConfig(`${type}/config.json`)));
  }
  await writeFile(projectFile, JSON.stringify(project));
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("deployment parameter preparation", () => {
  it("resolves service files relative to the private root config without duplicating root fields", async () => {
    const parameters = await prepareDeploymentParameters(projectFile);
    expect(parameters.parameters.deployWorkers.value).toBe(false);
    expect(parameters.parameters.enableLiveProbes.value).toBe(false);
    expect(Object.keys(parameters.parameters).sort()).toEqual([
      "deployWorkers", "enableLiveProbes", "projectConfig", "serviceConfigs", "workerImage",
    ]);
    for (const profile of Object.values(parameters.parameters.serviceConfigs.value)) {
      expect(profile.mode).toBe("simulation");
      for (const key of ["enabled", "targets", "telemetry"]) expect(profile).not.toHaveProperty(key);
    }
  });
  it("requires a separate live-deployment opt-in instead of silently enabling M365 operations", async () => {
    const exchange = await readServiceConfig("exchange/config.live.example.json");
    await writeFile(join(directory, "profiles/exchange.json"), JSON.stringify(exchange));
    const image = "example.azurecr.io/m365-synthetic:test";
    await expect(prepareDeploymentParameters(projectFile, image)).rejects.toThrow("explicit --enable-live");
    const parameters = await prepareDeploymentParameters(projectFile, image, true);
    expect(parameters.parameters.enableLiveProbes.value).toBe(true);
    expect(parameters.parameters.deployWorkers.value).toBe(true);
  });
  it("rejects a service-file type mismatch before preparing cloud parameters", async () => {
    await writeFile(join(directory, "profiles/exchange.json"), JSON.stringify(await readServiceConfig("teams/config.json")));
    await expect(prepareDeploymentParameters(projectFile)).rejects.toThrow("requires a exchange service config");
  });
  it("rejects missing deployment destinations and empty image references", async () => {
    await expect(prepareDeploymentParameters(projectFile, "")).rejects.toThrow("nonempty image reference");
    await writeFile(projectFile, JSON.stringify(checkedIn));
    await expect(prepareDeploymentParameters(projectFile)).rejects.toThrow("approved healthModel.subscriptionId");
  });
});
