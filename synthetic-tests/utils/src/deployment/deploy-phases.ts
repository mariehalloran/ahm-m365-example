import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ConfigurationError } from "../configuration/config.js";
import { readBindingsText } from "../configuration/bindings.js";
import { readProjectDocument } from "../configuration/project-config.js";
import { nodeProjectDirectory, repositoryDirectory } from "../paths.js";
import { prepareProjectDeployment, deploymentParameters, type PreparedDeployment } from "./prepare-deployment.js";
import type { DeploymentCommand, DeploymentCommandRunner } from "./deploy.js";
import { detectLegacyResources } from "./legacy-resources.js";
import { serviceProbes } from "../configuration/service-config.js";
import { probeServices } from "../contracts.js";
import { laneFreshnessSeconds } from "../../../functions/src/dispatch.js";

export interface DeploymentRun {
  prepared: PreparedDeployment;
  configFile: string;
  configText: string;
  bindingsText: string;
  projectDocumentSha256: string;
  sourceHash: string;
  runId: string;
  directory: string;
  tmpDirectory: string;
  subscription: string[];
  phase: string;
  mutated: boolean;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  runner: DeploymentCommandRunner;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  emit: (event: Record<string, unknown>) => void;
  deploymentPrincipalId?: string;
  deploymentPrincipalType?: "User" | "ServicePrincipal";
  previousCoordinator?: boolean;
  image?: string;
}
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const runFile = (run: DeploymentRun, name: string) => join(run.directory, name);

/** Records protected deployment state without printing accounts, targets or resource identifiers. */
export async function saveProvenance(run: DeploymentRun, status: string, extra: Record<string, unknown> = {}) {
  await writeFile(runFile(run, "provenance.json"), JSON.stringify({
    runId: run.runId, status, phase: run.phase, mutated: run.mutated,
    configSha256: hash(run.configText), bindingsSha256: hash(run.bindingsText),
    projectDocumentSha256: run.projectDocumentSha256,
    sourceSha256: run.sourceHash, runtimeConfigSha256: runtimeConfiguration(run).sha256,
    updatedAt: new Date(run.now()).toISOString(), ...extra,
  }, null, 2), { mode: 0o600 });
}

/** Runs a bounded command; all generated state and tool scratch files stay inside the project. */
export async function execute(
  run: DeploymentRun, tool: DeploymentCommand["tool"], phase: string, args: string[],
  cwd = nodeProjectDirectory, timeoutSeconds = run.prepared.settings.commandTimeoutSeconds,
): Promise<string> {
  run.signal.throwIfAborted();
  run.phase = phase;
  run.emit({ event: "monitoring-deployment-phase", phase });
  return run.runner({
    tool, args, phase, cwd, timeoutSeconds, signal: run.signal, env: { ...run.env, TMPDIR: run.tmpDirectory },
  });
}

/** Uses the selected Azure subscription and disables noisy CLI progress output. */
export function az(run: DeploymentRun, phase: string, args: string[], timeoutSeconds?: number) {
  return execute(run, "az", phase, [...args, "--only-show-errors"], nodeProjectDirectory, timeoutSeconds);
}

/** Parses CLI JSON without echoing credential-bearing output on failure. */
export async function azJson<T>(run: DeploymentRun, phase: string, args: string[], timeoutSeconds?: number): Promise<T> {
  const text = await az(run, phase, [...args, "--output", "json"], timeoutSeconds);
  try { return JSON.parse(text) as T; }
  catch { throw new ConfigurationError(`${phase} returned invalid JSON; inspect protected deployment diagnostics`); }
}

/** Computes the immutable resolved root snapshot consumed by both Functions and the coordinator. */
export function runtimeConfiguration(run: DeploymentRun) {
  const text = `${JSON.stringify(run.prepared.document, null, 2)}\n`;
  const sha256 = hash(text);
  return {
    text, sha256,
    url: `https://${run.prepared.settings.configurationStorageAccount}.blob.core.windows.net/configuration/${sha256}.json`,
  };
}

/** Recursively enumerates only the owned deployment/runtime source trees. */
async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(repositoryDirectory, directory), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new ConfigurationError("Deployment sources must not contain symbolic links");
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Fingerprints every runtime, Function, coordinator, model and setup source included in this architecture. */
export async function sourceFingerprint(): Promise<string> {
  const files: string[] = [];
  for (const directory of [
    "health-model/infra", "health-model/queries", "synthetic-tests/infra", "synthetic-tests/utils/src",
    "synthetic-tests/exchange/src", "synthetic-tests/teams/src", "synthetic-tests/onedrive/src",
    "synthetic-tests/sharepoint/src", "synthetic-tests/functions", "synthetic-tests/coordinator", "synthetic-tests/setup",
  ]) files.push(...await sourceFiles(directory));
  files.push(...["package.json", "package-lock.json", "Dockerfile", ".dockerignore", "tsconfig.json", "tsconfig.build.json"]
    .map(file => `synthetic-tests/${file}`));
  const digest = createHash("sha256");
  for (const file of files.sort()) digest.update(file).update(await readFile(join(repositoryDirectory, file)));
  return digest.digest("hex");
}

/** Rejects changed root inputs or source after preflight instead of deploying a different configuration. */
export async function assertUnchanged(run: DeploymentRun): Promise<void> {
  const currentDocumentSha256 = hash(JSON.stringify(await readProjectDocument(run.configFile)));
  if (await readFile(run.configFile, "utf8") !== run.configText ||
      await readBindingsText(run.configFile) !== run.bindingsText ||
      currentDocumentSha256 !== run.projectDocumentSha256 ||
      await sourceFingerprint() !== run.sourceHash) {
    throw new ConfigurationError("Root configuration, generated bindings or sources changed during deployment");
  }
}

/** Validates the actual Azure account, Entra API application and every selected managed identity. */
export async function preflight(run: DeploymentRun): Promise<void> {
  const { document, settings } = run.prepared;
  if (!settings.functions.apiClientId) throw new ConfigurationError("Run npm run setup:function-auth before deployment; Function keys are not supported");
  const account = await azJson<{ id: string; tenantId: string }>(run, "azure-account", [
    "account", "show", ...run.subscription, "--query", "{id:id,tenantId:tenantId}",
  ]);
  if (account.id.toLowerCase() !== document.healthModel.subscriptionId.toLowerCase() ||
      account.tenantId.toLowerCase() !== settings.azureTenantId.toLowerCase()) {
    throw new ConfigurationError("Azure account does not match the root subscription and Azure tenant");
  }
  const token = await azJson<{ accessToken: string }>(run, "deployment-identity", [
    "account", "get-access-token", "--resource", "https://management.azure.com/", "--tenant", settings.azureTenantId,
  ]);
  const claims = z.object({ oid: z.string().uuid(), tid: z.string().uuid(), idtyp: z.string().optional() })
    .parse(JSON.parse(Buffer.from(token.accessToken.split(".")[1]!, "base64url").toString("utf8")));
  if (claims.tid.toLowerCase() !== settings.azureTenantId.toLowerCase()) throw new ConfigurationError("Deployment token tenant mismatch");
  run.deploymentPrincipalId = claims.oid;
  run.deploymentPrincipalType = claims.idtyp === "app" ? "ServicePrincipal" : "User";
  const app = await azJson<{ signInAudience: string; api: { requestedAccessTokenVersion: number } }>(run, "function-api-binding", [
    "ad", "app", "show", "--id", settings.functions.apiClientId,
    "--query", "{signInAudience:signInAudience,api:api}",
  ]);
  if (app.signInAudience !== "AzureADMyOrg" || app.api.requestedAccessTokenVersion !== 2) {
    throw new ConfigurationError("Function API registration must be single-tenant with v2 application tokens for its client-ID audience");
  }
  const assignmentRequired = await azJson<boolean>(run, "function-api-enterprise-application", [
    "ad", "sp", "show", "--id", settings.functions.apiClientId, "--query", "appRoleAssignmentRequired",
  ]);
  if (assignmentRequired) throw new ConfigurationError("The explicitly selected Function API enterprise application must allow roleless application tokens; the Function enforces its single caller ACL");
  await detectLegacyResources(run);
  const coordinatorId = settings.coordinator.identityResourceId ??
    `/subscriptions/${document.healthModel.subscriptionId}/resourceGroups/${document.healthModel.resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${settings.coordinator.identityName}`;
  const ids = new Set([coordinatorId, ...run.prepared.owners.map(owner => owner.identityResourceId),
    ...run.prepared.owners.filter(owner => owner.type === "teams").flatMap(owner =>
      owner.project.services.teams.botPairs.flatMap(pair => [pair.identityResourceId, pair.botPeerManagedIdentityResourceId]))]);
  const identities = new Map<string, { clientId: string; principalId: string }>();
  for (const id of ids) {
    const identity = await azJson<{ id: string; tenantId: string; clientId: string; principalId: string }>(run, "managed-identity-binding", [
      "identity", "show", "--ids", id, ...run.subscription, "--query", "{id:id,tenantId:tenantId,clientId:clientId,principalId:principalId}",
    ]);
    if (identity.id.toLowerCase() !== id.toLowerCase() || identity.tenantId.toLowerCase() !== settings.azureTenantId.toLowerCase()) {
      throw new ConfigurationError("A selected identity belongs to a different resource or Azure tenant");
    }
    z.string().uuid().parse(identity.clientId);
    z.string().uuid().parse(identity.principalId);
    identities.set(id.toLowerCase(), identity);
  }
  const resolved = structuredClone(document);
  const coordinatorClient = identities.get(coordinatorId.toLowerCase())!.clientId;
  if (settings.coordinator.identityClientId && settings.coordinator.identityClientId !== coordinatorClient) {
    throw new ConfigurationError("The generated dispatcher client ID does not match its selected managed identity");
  }
  resolved.deployment!.coordinator.identityClientId = coordinatorClient;
  for (const tenant of resolved.tenants) {
    for (const type of ["exchange", "teams", "onedrive", "sharepoint"] as const) {
      const selected = tenant.services[type];
      if (!selected.identityResourceId) continue;
      const identity = identities.get(selected.identityResourceId.toLowerCase());
      if (!identity) continue;
      if (selected.identityClientId && selected.identityClientId !== identity.clientId) {
        throw new ConfigurationError("An execution identity client binding does not match its selected Azure resource");
      }
      selected.identityClientId = identity.clientId;
      if (type === "teams") for (const pair of tenant.services.teams.botPairs) {
        for (const [resourceId, clientId, botId] of [
          [pair.identityResourceId, pair.botClientId, pair.botResourceId],
          [pair.botPeerManagedIdentityResourceId, pair.botPeerClientId, pair.botPeerResourceId],
        ] as const) {
          if (identities.get(resourceId.toLowerCase())?.clientId !== clientId) throw new ConfigurationError("Teams bot managed-identity binding mismatch");
          const bot = await azJson<{ msaAppId: string; msaAppTenantId: string; msaAppMSIResourceId: string; msaAppType: string }>(run, "teams-bot-binding", [
            "resource", "show", "--ids", botId, "--api-version", "2022-09-15", ...run.subscription, "--query", "properties",
          ]);
          if (bot.msaAppId !== clientId || bot.msaAppTenantId !== settings.azureTenantId ||
              bot.msaAppMSIResourceId.toLowerCase() !== resourceId.toLowerCase() || bot.msaAppType !== "UserAssignedMSI") {
            throw new ConfigurationError("A Teams bot registration does not match its configured managed identity");
          }
        }
      }
    }
  }
  run.prepared = prepareProjectDeployment(resolved);
}

/** Builds all deployment templates locally before any cloud mutation. */
export async function buildBicep(run: DeploymentRun): Promise<void> {
  for (const [name, path] of [
    ["models", "health-model/infra/main.bicep"], ["configuration", "synthetic-tests/infra/configuration.bicep"],
    ["execution", "synthetic-tests/infra/main.bicep"], ["freshness", "health-model/infra/observation-alerts.bicep"],
  ] as const) {
    const template = await az(run, `build-${name}-bicep`, ["bicep", "build", "--file", join(repositoryDirectory, path), "--stdout"]);
    await writeFile(runFile(run, `${name}.template.json`), template, { mode: 0o600 });
  }
}

/** Writes generated ARM parameters for one known stack, not a second monitoring profile. */
export async function stackParameters(run: DeploymentRun, stack: string, deployCoordinator = false) {
  const { document, settings, reportingGroups } = run.prepared;
  const snapshot = runtimeConfiguration(run);
  const shared = { projectConfig: document, location: settings.location };
  const values = stack === "models" ? {
    ...shared, location: settings.healthModelLocation ?? settings.location, reportingGroups,
    workspaceName: settings.workspaceName ?? `law-${document.healthModel.name}`,
    applicationInsightsName: settings.applicationInsightsName ?? `appi-${document.healthModel.name}`,
  } : stack === "configuration" ? {
    ...shared, deploymentPrincipalId: run.deploymentPrincipalId, deploymentPrincipalType: run.deploymentPrincipalType,
    executionStorageExists: run.previousCoordinator ?? false,
    workspaceName: settings.workspaceName ?? `law-${document.healthModel.name}`,
    applicationInsightsName: settings.applicationInsightsName ?? `appi-${document.healthModel.name}`,
  } : stack === "freshness" ? {
    ...shared, workspaceName: settings.workspaceName ?? `law-${document.healthModel.name}`,
    configSha256: snapshot.sha256,
    expectedExecutions: run.prepared.owners.filter(owner => owner.service.mode === "live").flatMap(owner => {
      const probes = serviceProbes(owner.service, owner.project.services[owner.type].scenarios);
      return [...new Set(probes.map(probe => probe.type))].map(type => ({
        tenant: owner.tenant, service: owner.type, journey: probeServices[type].journey,
        targets: probes.filter(probe => probe.type === type).length,
        maxAgeSeconds: Math.max(...run.prepared.lanes.filter(lane =>
          lane.tenant === owner.tenant && lane.service === owner.type && lane.journey === probeServices[type].journey)
          .map(lane => laneFreshnessSeconds(document, lane))),
      }));
    }),
  } : {
    ...shared, deploymentPrincipalId: run.deploymentPrincipalId, deploymentPrincipalType: run.deploymentPrincipalType,
    deployCoordinator, coordinatorImage: run.image ?? "", configBlobUrl: snapshot.url, configSha256: snapshot.sha256,
  };
  const file = `${stack}.parameters.json`;
  await writeFile(runFile(run, file), JSON.stringify(deploymentParameters(values)), { mode: 0o600 });
  return file;
}

/** Applies one explicitly previewed ARM stack and checks its actual terminal provisioning state. */
export async function deployStack(run: DeploymentRun, stack: string, operation: "what-if" | "create", deployCoordinator = false): Promise<void> {
  const parameters = await stackParameters(run, stack, deployCoordinator);
  const result = await azJson<{ error?: unknown; status?: string; properties?: { provisioningState?: string } }>(run, `${stack}-${operation}`, [
    "deployment", "group", operation, "--resource-group", run.prepared.document.healthModel.resourceGroup,
    ...run.subscription, "--name", `${stack}-${run.runId}`, "--template-file", runFile(run, `${stack}.template.json`),
    "--parameters", `@${runFile(run, parameters)}`, ...(operation === "what-if" ? ["--no-pretty-print"] : []),
  ]);
  await writeFile(runFile(run, `${stack}-${operation}.json`), JSON.stringify(result), { mode: 0o600 });
  if (result.error || result.status === "Failed" || operation === "create" && result.properties?.provisioningState !== "Succeeded") {
    throw new ConfigurationError(`${stack} did not complete successfully; inspect protected ARM deployment output`);
  }
}

/** Builds or verifies the single immutable coordinator image; no service Graph-worker images remain. */
export async function pinCoordinatorImage(run: DeploymentRun): Promise<string> {
  const { image, foundation } = run.prepared.settings;
  const registry = foundation.mode === "create" ? foundation.registryName : foundation.registryResourceId.split("/").at(-1)!;
  const server = z.string().min(1).parse(await azJson<unknown>(run, "registry-server", [
    "acr", "show", "--name", registry, ...run.subscription, "--query", "loginServer",
  ]));
  if (image.mode === "existing") {
    if (!image.reference.startsWith(`${server}/`)) throw new ConfigurationError("The immutable coordinator image must belong to the selected registry");
    const digest = await azJson<string>(run, "coordinator-image-binding", [
      "acr", "manifest", "show-metadata", "--registry", registry, "--name", image.reference.slice(server.length + 1),
      ...run.subscription, "--query", "digest",
    ]);
    if (digest !== image.reference.split("@")[1]) throw new ConfigurationError("Coordinator image digest mismatch");
    return image.reference;
  }
  const tagged = `${image.repository}:${image.tag}-${run.runId}`;
  await az(run, "build-coordinator-image", [
    "acr", "build", "--registry", registry, ...run.subscription, "--image", tagged, "--platform", image.platform,
    "--file", "Dockerfile", "--build-arg", `SOURCE_FINGERPRINT=${run.sourceHash}`, "--no-logs", "--output", "none", ".",
  ]);
  const digest = await azJson<string>(run, "coordinator-image-digest", [
    "acr", "manifest", "show-metadata", "--registry", registry, "--name", tagged, ...run.subscription, "--query", "digest",
  ]);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new ConfigurationError("Coordinator image did not resolve to an immutable digest");
  await assertUnchanged(run);
  return `${server}/${image.repository}@${digest}`;
}

/** Confirms the coordinator is ready, has one selected identity, and executes only the dispatcher entrypoint. */
export async function verifyCoordinator(run: DeploymentRun): Promise<void> {
  const deadline = run.now() + run.prepared.settings.rolloutTimeoutSeconds * 1000;
  const settings = run.prepared.settings;
  const expectedIdentity = settings.coordinator.identityResourceId ??
    `/subscriptions/${run.prepared.document.healthModel.subscriptionId}/resourceGroups/${run.prepared.document.healthModel.resourceGroup}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${settings.coordinator.identityName}`;
  while (run.now() < deadline) {
    const app = await azJson<{
      latestRevisionName?: string; latestReadyRevisionName?: string; provisioningState?: string;
      containers: { image: string; args: string[] }[]; identities: Record<string, unknown>;
    }>(run, "verify-coordinator-rollout", [
      "containerapp", "show", "--name", settings.coordinator.appName, "--resource-group", run.prepared.document.healthModel.resourceGroup,
      ...run.subscription, "--query", "{latestRevisionName:properties.latestRevisionName,latestReadyRevisionName:properties.latestReadyRevisionName,provisioningState:properties.provisioningState,containers:properties.template.containers,identities:identity.userAssignedIdentities}",
    ]);
    if (app.provisioningState === "Failed") throw new ConfigurationError("Coordinator rollout failed");
    const identities = Object.keys(app.identities);
    if (identities.length !== 1 || identities[0]!.toLowerCase() !== expectedIdentity.toLowerCase()) throw new ConfigurationError("The coordinator must have only its explicitly selected dispatcher identity");
    if (app.containers.length !== 1 || app.containers[0]!.args.join(" ") !== "dist/coordinator/src/index.js") {
      throw new ConfigurationError("The Container App is not a dispatch-only coordinator");
    }
    if (app.latestRevisionName && app.latestRevisionName === app.latestReadyRevisionName && app.containers[0]!.image === run.image) return;
    await run.sleep(Math.min(5000, deadline - run.now()));
  }
  throw new ConfigurationError("Coordinator rollout did not become ready within its configured deadline");
}

/** Creates protected local deployment state, never a temporary directory outside the repository. */
export async function createStateDirectory(stateDirectory: string, runId: string): Promise<string> {
  const directory = join(repositoryDirectory, stateDirectory, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** Creates a short per-run TMPDIR path so tsx IPC sockets stay within OS path-length limits. */
export async function createCommandTempDirectory(runId: string): Promise<string> {
  const directory = join(nodeProjectDirectory, ".monitoring-tmp", runId.slice(-8));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
