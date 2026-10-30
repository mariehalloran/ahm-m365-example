// The phases of one deployment run in execution order; deploy.ts orchestrates them.
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigurationError } from "./config.js";
import { readBindingsText } from "./bindings.js";
import type { DeploymentCommand, DeploymentCommandRunner } from "./deploy.js";
import { nodeProjectDirectory, repositoryDirectory } from "./paths.js";
import type { PreparedDeployment } from "./prepare-deployment.js";

const management = "https://management.azure.com";
const entityVersion = "2026-10-01-preview";
const relationshipVersion = "2026-05-01-preview";
const healthTemplate = "health-template.json";
const workerTemplate = "worker-template.json";
const secureParameters = "certificates.parameters.json";
// secure: the deployment also takes the certificate parameter file
const stacks = {
  models: { name: "models", template: healthTemplate, parameters: "health.parameters.json", secure: false },
  foundation: { name: "foundation", template: workerTemplate, parameters: "foundation.parameters.json", secure: true },
  preview: { name: "workers-preview", template: workerTemplate, parameters: "workers-preview.parameters.json", secure: true },
  workers: { name: "workers", template: workerTemplate, parameters: "workers.parameters.json", secure: true },
};
const appListQuery = "[].{name:name,environmentId:not_null(properties.environmentId,properties.managedEnvironmentId),latestRevisionName:properties.latestRevisionName,latestReadyRevisionName:properties.latestReadyRevisionName,images:properties.template.containers[].image,identities:identity.userAssignedIdentities,fqdn:properties.configuration.ingress.fqdn,customDomains:properties.configuration.ingress.customDomains}";
const appStatusQuery = "{name:name,latestRevisionName:properties.latestRevisionName,latestReadyRevisionName:properties.latestReadyRevisionName,provisioningState:properties.provisioningState,images:properties.template.containers[].image}";

interface AppSnapshot {
  name: string; environmentId?: string; latestRevisionName?: string; latestReadyRevisionName?: string; provisioningState?: string;
  images?: string[]; identities?: Record<string, unknown>; fqdn?: string; customDomains?: unknown[];
}
interface Identity { id: string; clientId: string; principalId: string; tenantId: string }
interface Relationship { name: string; properties: { parentEntityName: string; childEntityName: string } }
interface Retirement { modelPath: string; entities: string[]; relationships: Relationship[] }
interface Registry { name: string; server: string }
interface Foundation { registry: Registry; environmentId: string; environmentDomain: string | undefined }
interface Hosting extends Foundation { tenantId: string; apps: AppSnapshot[]; identities: Map<string, Identity> }
interface Stack { name: string; template: string; parameters: string; secure: boolean }
type Worker = PreparedDeployment["workers"][number];
type BuildImage = Extract<PreparedDeployment["settings"]["image"], { mode: "build" }>;
interface Provenance {
  runId: string; status: "preflight" | "deploying" | "succeeded" | "failed" | "cancelled";
  configSha256: string; bindingsSha256: string; sourceSha256: string; subscriptionId: string; resourceGroup: string; models: string[]; startedAt: string;
  sourceRevision?: string; previousWorkers?: AppSnapshot[]; identityBindings?: Identity[]; retirements?: Retirement[];
  phase?: string; image?: string; completedAt?: string; remoteMayStillRun?: boolean; errorType?: string;
}

// The state one deployment run carries between phases; provenance.json is a snapshot of `provenance`.
export interface DeploymentRun {
  prepared: PreparedDeployment;
  configFile: string;
  configText: string;
  bindingsText: string;
  sourceHash: string;
  certificates: Record<string, Record<string, string>>;
  runId: string;
  directory: string;
  subscription: string[];
  provenance: Provenance;
  phase: string; // last phase started; reported when a non-command error ends the run
  mutated: boolean; // true once Azure may have changed
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  runner: DeploymentCommandRunner;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  emit: (event: Record<string, unknown>) => void;
}

export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function runtimeConfiguration(run: DeploymentRun) {
  const text = `${JSON.stringify(run.prepared.document, null, 2)}\n`;
  const sha256 = hash(text);
  return {
    text, sha256,
    url: `https://${run.prepared.settings.configurationStorageAccount}.blob.core.windows.net/worker-config/${sha256}.json`,
  };
}
export const deploysWorkers = (prepared: PreparedDeployment) => prepared.settings.stage === "workers";
const equal = (left: string | undefined, right: string | undefined) => left?.toLowerCase() === right?.toLowerCase();
// Azure reports a region by display name ("Central US"); configuration uses the ARM name ("centralus").
const sameRegion = (actual: string, configured: string) =>
  actual.toLowerCase().replace(/\s+/g, "") === configured.toLowerCase().replace(/\s+/g, "");
const isMissing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const prettyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export const runFile = (run: DeploymentRun, name: string) => join(run.directory, name);

export function parseJson<T>(text: string, phase: string): T {
  try { return JSON.parse(text) as T; }
  catch { throw new ConfigurationError(`${phase} returned invalid JSON; no raw credential output was logged`); }
}

export const saveProvenance = (run: DeploymentRun) =>
  writeFile(runFile(run, "provenance.json"), prettyJson(run.provenance), { mode: 0o600 });

export const writeJson = (run: DeploymentRun, name: string, value: unknown) =>
  writeFile(runFile(run, name), prettyJson(value), { flag: "wx", mode: 0o600 });

async function execute(run: DeploymentRun, tool: DeploymentCommand["tool"], phase: string, args: string[],
  timeoutSeconds = run.prepared.settings.commandTimeoutSeconds) {
  run.signal.throwIfAborted();
  run.emit({ event: "monitoring-deployment-phase", phase });
  return run.runner({ tool, args, phase, timeoutSeconds, cwd: nodeProjectDirectory, signal: run.signal, env: { ...run.env, TMPDIR: run.directory } });
}

const git = (run: DeploymentRun, phase: string, args: string[]) => execute(run, "git", phase, args);

export const az = (run: DeploymentRun, phase: string, args: string[], timeoutSeconds?: number) =>
  execute(run, "az", phase, [...args, "--only-show-errors"], timeoutSeconds);

export async function azJson<T>(run: DeploymentRun, phase: string, args: string[], timeoutSeconds?: number): Promise<T> {
  return parseJson<T>(await az(run, phase, [...args, "--output", "json"], timeoutSeconds), phase);
}

export async function createStateDirectory(stateDirectory: string, runId: string): Promise<string> {
  const root = join(repositoryDirectory, stateDirectory);
  const existing = await lstat(root).catch(error => { if (isMissing(error)) return undefined; throw error; });
  if (existing?.isSymbolicLink()) throw new ConfigurationError("Deployment state directory must not be a symbolic link");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const directory = join(root, runId);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

export async function removeSecureParameters(run: DeploymentRun) {
  try { await unlink(runFile(run, secureParameters)); }
  catch (error) { if (!isMissing(error)) throw error; }
}

const isCertificateBundle = (pem: string | undefined): pem is string =>
  typeof pem === "string" && pem.includes("-----BEGIN CERTIFICATE-----") && /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(pem);

export function nativeCertificates(prepared: PreparedDeployment, env: NodeJS.ProcessEnv) {
  const certificates: Record<string, Record<string, string>> = {};
  if (!deploysWorkers(prepared)) return certificates;
  for (const worker of prepared.workers) {
    const access = worker.project.services[worker.type].access;
    if (worker.service.mode !== "live" || access.m365CertificateSource !== "container-app") continue;
    const pem = env[access.m365CertificateEnvironmentVariable!];
    if (!isCertificateBundle(pem) || !equal(hash(pem), access.m365CertificateRevision)) {
      throw new ConfigurationError("Native certificate environment reference is absent, invalid or does not match m365CertificateRevision");
    }
    (certificates[worker.tenant] ??= {})[worker.type] = pem;
  }
  return certificates;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(join(repositoryDirectory, directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new ConfigurationError("Deployment source must not contain symbolic links");
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== "tests") files.push(...await sourceFiles(path));
    else if (/\.(ts|json|bicep|kql)$/.test(path)) files.push(path);
  }
  return files;
}

export async function sourceFingerprint(): Promise<string> {
  const files: string[] = [];
  for (const directory of ["health-model/infra", "health-model/queries", "synthetic-tests/infra", "synthetic-tests/utils/src",
    "synthetic-tests/exchange/src", "synthetic-tests/teams/src", "synthetic-tests/onedrive/src", "synthetic-tests/ingestion"]) {
    files.push(...await sourceFiles(directory));
  }
  files.push(...["package.json", "package-lock.json", "Dockerfile", ".dockerignore", "tsconfig.json", "tsconfig.build.json"]
    .map(file => `synthetic-tests/${file}`));
  const digest = createHash("sha256");
  for (const file of files.sort()) digest.update(file).update(await readFile(join(repositoryDirectory, file)));
  return digest.digest("hex");
}

export async function preflight(run: DeploymentRun) {
  run.provenance.sourceRevision = (await git(run, "source-revision", ["rev-parse", "HEAD"])).trim();
  const tenantId = await verifyAzureAccount(run);
  const foundation = await bindFoundation(run);
  const apps = await snapshotWorkerApps(run);
  run.provenance.previousWorkers = apps;
  const hosting: Hosting = { ...foundation, tenantId, apps, identities: new Map() };
  for (const worker of run.prepared.workers) await verifyWorker(run, hosting, worker);
  run.provenance.identityBindings = [...hosting.identities.values()];
  const retirements = await planRetirements(run);
  run.provenance.retirements = retirements;
  return { registry: foundation.registry, retirements };
}

async function verifyAzureAccount(run: DeploymentRun): Promise<string> {
  const account = await azJson<{ id: string; tenantId: string }>(run, "azure-account", [
    "account", "show", ...run.subscription, "--query", "{id:id,tenantId:tenantId}",
  ]);
  if (!equal(account.id, run.prepared.document.healthModel.subscriptionId) || !equal(account.tenantId, run.prepared.settings.azureTenantId)) {
    throw new ConfigurationError("Azure account subscription/actual tenant does not match the deployment configuration");
  }
  return account.tenantId;
}

async function bindFoundation(run: DeploymentRun): Promise<Foundation> {
  const { foundation, location } = run.prepared.settings;
  if (foundation.mode === "create") {
    const { subscriptionId, resourceGroup } = run.prepared.document.healthModel;
    const providers = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers`;
    return {
      registry: { name: foundation.registryName, server: `${foundation.registryName}.azurecr.io` },
      environmentId: `${providers}/Microsoft.App/managedEnvironments/${foundation.environmentName}`, environmentDomain: undefined,
    };
  }
  const { registryResourceId, environmentResourceId } = foundation;
  // `az acr` has no --ids argument, so address the registry by name and resource group.
  const registryName = registryResourceId.split("/").at(-1)!;
  const registry = await azJson<{ id: string; loginServer: string }>(run, "registry-binding", [
    "acr", "show", "--name", registryName, "--resource-group", registryResourceId.split("/")[4]!, ...run.subscription,
    "--query", "{id:id,loginServer:loginServer}",
  ]);
  if (!equal(registry.id, registryResourceId) || !registry.loginServer) throw new ConfigurationError("Configured existing registry did not resolve");
  const environment = await azJson<{ id: string; defaultDomain: string; location: string }>(run, "environment-binding", [
    "resource", "show", "--ids", environmentResourceId, "--api-version", "2026-07-01", ...run.subscription,
    "--query", "{id:id,defaultDomain:properties.defaultDomain,location:location}",
  ]);
  if (!equal(environment.id, environmentResourceId)) throw new ConfigurationError("Configured existing Container Apps environment did not resolve");
  if (!sameRegion(environment.location, location)) throw new ConfigurationError("deployment.location must match the existing worker environment's actual region");
  return {
    registry: { name: registryName, server: registry.loginServer },
    environmentId: environmentResourceId, environmentDomain: environment.defaultDomain,
  };
}

async function snapshotWorkerApps(run: DeploymentRun): Promise<AppSnapshot[]> {
  const apps = await azJson<AppSnapshot[]>(run, "previous-worker-revisions", [
    "containerapp", "list", "--resource-group", run.prepared.document.healthModel.resourceGroup, ...run.subscription, "--query", appListQuery,
  ]);
  return apps.filter(app => run.prepared.workers.some(worker => worker.appName === app.name));
}

async function verifyWorker(run: DeploymentRun, hosting: Hosting, worker: Worker) {
  await bindIdentities(run, hosting, worker);
  const app = hosting.apps.find(app => app.name === worker.appName);
  if (app && (!equal(app.environmentId, hosting.environmentId) ||
      !Object.keys(app.identities ?? {}).some(id => equal(id, worker.identityResourceId)))) {
    throw new ConfigurationError("Existing worker environment/primary identity differs; review the explicit binding rather than replacing it silently");
  }
  if (app?.customDomains?.length) {
    throw new ConfigurationError("Existing custom ingress domains require explicit migration; this template must not remove them implicitly");
  }
  if (worker.type === "teams" && worker.service.mode === "live" && deploysWorkers(run.prepared)) {
    await verifyTeamsBindings(run, hosting, worker, app);
  }
}

async function bindIdentities(run: DeploymentRun, hosting: Hosting, worker: Worker) {
  const selected = worker.project.services[worker.type];
  const callsPeer = worker.service.mode === "live" && worker.type === "teams" && worker.project.services.teams.scenarios["scheduled-meeting"];
  const ids = [
    ...(selected.worker?.identityResourceId ? [selected.worker.identityResourceId] : []),
    ...(callsPeer ? [selected.access.botPeerManagedIdentityResourceId!] : []),
  ];
  for (const id of ids) {
    if (hosting.identities.has(id.toLowerCase())) continue;
    const identity = await azJson<Identity>(run, "identity-binding", [
      "identity", "show", "--ids", id, ...run.subscription, "--query", "{id:id,clientId:clientId,principalId:principalId,tenantId:tenantId}",
    ]);
    if (!equal(identity.id, id) || !equal(identity.tenantId, hosting.tenantId) || !identity.clientId || !identity.principalId) {
      throw new ConfigurationError("An existing managed identity does not match its resource ID and actual Azure hosting tenant");
    }
    hosting.identities.set(id.toLowerCase(), identity);
  }
  const bound = hosting.identities.get(worker.identityResourceId.toLowerCase());
  if (selected.worker?.identityClientId && !equal(selected.worker.identityClientId, bound?.clientId)) {
    throw new ConfigurationError("worker.identityClientId does not match its existing identityResourceId");
  }
}

async function verifyTeamsBindings(run: DeploymentRun, hosting: Hosting, worker: Worker, app: AppSnapshot | undefined) {
  const teams = worker.project.services.teams;
  const { access } = teams;
  const bound = hosting.identities.get(worker.identityResourceId.toLowerCase());
  const peer = access.botPeerManagedIdentityResourceId ? hosting.identities.get(access.botPeerManagedIdentityResourceId.toLowerCase()) : undefined;
  if (!bound || (access.botPeerClientId && !equal(peer?.clientId, access.botPeerClientId))) {
    throw new ConfigurationError("Actual Teams primary/peer identities do not match the approved client bindings");
  }
  const calling = teams.scenarios["scheduled-meeting"];
  const ingress = app?.fqdn ?? (hosting.environmentDomain ? `${worker.appName}.${hosting.environmentDomain}` : undefined);
  if (calling && (!ingress || new URL(worker.service.teamsCallingCallbackUrl!).hostname.toLowerCase() !== ingress.toLowerCase())) {
    throw new ConfigurationError("Teams callback must use the existing execution owner's ingress hostname");
  }
  const callbackHost = calling ? ingress?.toLowerCase() : undefined;
  await verifyBot(run, access.botResourceId, bound, hosting.tenantId, callbackHost);
  if (calling) await verifyBot(run, access.botPeerResourceId, peer, hosting.tenantId, callbackHost);
}

async function verifyBot(run: DeploymentRun, botId: string | undefined, identity: Identity | undefined, tenantId: string,
  callbackHost: string | undefined) {
  const bot = await azJson<{
    properties: { msaAppId: string; msaAppTenantId: string; msaAppMSIResourceId: string; msaAppType: string; endpoint: string };
  }>(run, "bot-binding", ["rest", "--method", "get", "--url", `${management}${botId}?api-version=2022-09-15`, ...run.subscription]);
  if (!identity || !equal(bot.properties.msaAppId, identity.clientId) || !equal(bot.properties.msaAppTenantId, tenantId) ||
      !equal(bot.properties.msaAppMSIResourceId, identity.id) || bot.properties.msaAppType !== "UserAssignedMSI") {
    throw new ConfigurationError("Existing bot registration does not match the approved tenant/UAMI binding");
  }
  if (callbackHost && bot.properties.endpoint && new URL(bot.properties.endpoint).hostname.toLowerCase() !== callbackHost) {
    throw new ConfigurationError("A configured bot endpoint must retain this one execution owner's existing ingress; empty messaging endpoints are preserved and Graph callbacks use the explicit execution setting");
  }
}

async function planRetirements(run: DeploymentRun): Promise<Retirement[]> {
  const { subscriptionId, resourceGroup, name } = run.prepared.document.healthModel;
  const retirements: Retirement[] = [];
  for (const service of ["exchange", "teams", "onedrive"] as const) {
    const names = run.prepared.settings.retireEntities.filter(entry => entry.service === service).map(entry => entry.entityName);
    if (!names.length) continue;
    const modelPath = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.CloudHealth/healthmodels/${name}-${service}`;
    const relationshipsUrl = `${management}${modelPath}/relationships?api-version=${relationshipVersion}`;
    const entitiesUrl = `${management}${modelPath}/entities?api-version=${entityVersion}`;
    const relationships: Relationship[] = [];
    for await (const response of pages<Relationship>(run, "retirement-preflight", "relationship", relationshipsUrl, [])) {
      relationships.push(...response.value.filter(item =>
        names.includes(item.properties.parentEntityName) || names.includes(item.properties.childEntityName)));
    }
    const existing = new Set<string>();
    const entityQuery = ["--query", "{value:value[].{name:name},nextLink:nextLink}"];
    for await (const response of pages<{ name: string }>(run, "retirement-preflight-entities", "entity", entitiesUrl, entityQuery)) {
      for (const entity of response.value) existing.add(entity.name.split("/").at(-1)!);
    }
    retirements.push({ modelPath, entities: [...new Set(names)].filter(entity => existing.has(entity)), relationships });
  }
  return retirements;
}

// Yields each page of a collection; follows nextLink for at most 20 requests and never leaves the first page's collection URL.
async function* pages<T>(run: DeploymentRun, phase: string, kind: string, firstUrl: string, query: string[]) {
  const collection = firstUrl.slice(0, firstUrl.indexOf("?") + 1);
  let next: string | undefined = firstUrl;
  for (let page = 0; next && page < 20; page++) {
    if (!next.startsWith(collection)) throw new ConfigurationError(`Unexpected ${kind} pagination URL`);
    const response: { value: T[]; nextLink?: string } = await azJson(run, phase, [
      "rest", "--method", "get", "--url", next, ...run.subscription, ...query,
    ]);
    yield response;
    next = response.nextLink;
  }
  if (next) throw new ConfigurationError("Retirement preflight exceeded its pagination bound");
}

export async function buildBicep(run: DeploymentRun) {
  const builds = [
    ["build-model-bicep", join(repositoryDirectory, "health-model/infra/main.bicep"), healthTemplate],
    ["build-worker-bicep", join(nodeProjectDirectory, "infra/main.bicep"), workerTemplate],
    ["build-reporting-bicep", join(nodeProjectDirectory, "infra/configuration.bicep"), "reporting-template.json"],
  ] as const;
  for (const [phase, source, template] of builds) {
    const text = await az(run, phase, ["bicep", "build", "--file", source, "--stdout"]);
    await writeFile(runFile(run, template), text, { flag: "wx", mode: 0o600 });
  }
}

function workerParameters(run: DeploymentRun, overrides: Record<string, { value: unknown }>) {
  const { workerParameters } = run.prepared;
  const snapshot = runtimeConfiguration(run);
  return { ...workerParameters, parameters: {
    ...workerParameters.parameters,
    workerConfigBlobUrl: { value: snapshot.url }, workerConfigSha256: { value: snapshot.sha256 },
    ...overrides,
  } };
}

export async function writeParameterFiles(run: DeploymentRun, registry: Registry) {
  const { healthParameters, settings } = run.prepared;
  const previewImage = settings.image.mode === "existing" ? settings.image.reference
    : `${registry.server}/${settings.image.repository}@sha256:${"0".repeat(64)}`;
  await writeJson(run, stacks.models.parameters, healthParameters);
  await writeJson(run, stacks.foundation.parameters, workerParameters(run, { deployWorkers: { value: false }, workerImage: { value: "" } }));
  await writeJson(run, stacks.preview.parameters, workerParameters(run, { workerImage: { value: previewImage } }));
  await writeJson(run, secureParameters, { parameters: { serviceCertificates: { value: run.certificates } } });
}

export async function previewChanges(run: DeploymentRun, registry: Registry) {
  await deployStack(run, "what-if", stacks.models);
  await deployStack(run, "what-if", stacks.foundation);
  if (!deploysWorkers(run.prepared)) return;
  await deployStack(run, "what-if", stacks.preview);
  const { image } = run.prepared.settings;
  if (image.mode === "existing") await verifyExistingImage(run, registry, image.reference);
}

export async function beginMutations(run: DeploymentRun) {
  if (await readFile(run.configFile, "utf8") !== run.configText || await readBindingsText(run.configFile) !== run.bindingsText ||
      await sourceFingerprint() !== run.sourceHash) {
    throw new ConfigurationError("Monitoring config/bindings/source changed during preflight; no Azure changes were made");
  }
  run.provenance.status = "deploying";
  run.mutated = true;
  await saveProvenance(run);
}

export const deployModels = (run: DeploymentRun) => deployStack(run, "create", stacks.models);

export const deployFoundation = (run: DeploymentRun) => deployStack(run, "create", stacks.foundation);

export async function deployWorkers(run: DeploymentRun, image: string, services?: string[]) {
  const stack = services ? {
    ...stacks.workers, name: `workers-${services.join("-")}`, parameters: `workers-${services.join("-")}.parameters.json`,
  } : stacks.workers;
  await writeJson(run, stack.parameters, workerParameters(run, {
    workerImage: { value: image }, ...(services ? { workerServices: { value: services } } : {}),
  }));
  await deployStack(run, "what-if", stack);
  await deployStack(run, "create", stack);
}

async function deployStack(run: DeploymentRun, operation: "what-if" | "create", stack: Stack) {
  const phase = `${stack.name}-${operation}`;
  run.phase = phase;
  run.provenance.phase = phase;
  await saveProvenance(run);
  const result = await az(run, phase, [
    "deployment", "group", operation, "--resource-group", run.prepared.document.healthModel.resourceGroup, ...run.subscription,
    "--name", `${stack.name}-${run.runId}`, "--template-file", runFile(run, stack.template),
    "--parameters", `@${runFile(run, stack.parameters)}`, ...(stack.secure ? [`@${runFile(run, secureParameters)}`] : []),
    ...(operation === "what-if" ? ["--no-pretty-print"] : []), "--output", "json",
  ]);
  await writeFile(runFile(run, `${phase}.json`), result, { flag: "wx", mode: 0o600 });
  const outcome = parseJson<{ status?: string; error?: unknown; properties?: { provisioningState?: string } }>(result, phase);
  if (outcome.error || outcome.status === "Failed") throw new ConfigurationError(`${phase} failed; inspect the protected deployment result`);
  if (operation === "create" && outcome.properties?.provisioningState !== "Succeeded") {
    throw new ConfigurationError(`${phase} did not finish in Succeeded state`);
  }
}

export async function pinImage(run: DeploymentRun, registry: Registry): Promise<string> {
  const { image } = run.prepared.settings;
  const pinned = image.mode === "existing" ? image.reference : await buildImage(run, registry, image);
  run.provenance.image = pinned;
  return pinned;
}

async function verifyExistingImage(run: DeploymentRun, registry: Registry, reference: string) {
  if (!reference.startsWith(`${registry.server}/`)) throw new ConfigurationError("Existing worker image must belong to the configured registry");
  const digest = await azJson<string>(run, "existing-image", [
    "acr", "repository", "show", "--name", registry.name, "--image", reference.slice(registry.server.length + 1),
    ...run.subscription, "--query", "digest",
  ]);
  if (digest !== reference.split("@")[1]) throw new ConfigurationError("Existing immutable image digest did not resolve");
}

async function buildImage(run: DeploymentRun, registry: Registry, image: BuildImage): Promise<string> {
  run.phase = "build-image";
  const tagged = `${image.repository}:${image.tag}-${run.runId}`;
  await az(run, "build-image", [
    "acr", "build", "--registry", registry.name, ...run.subscription,
    "--image", tagged, "--platform", image.platform, "--file", "Dockerfile",
    "--build-arg", `SOURCE_FINGERPRINT=${run.sourceHash}`, "--no-logs", "--output", "json", ".",
  ]);
  const digest = await azJson<string>(run, "resolve-image-digest", [
    "acr", "repository", "show", "--name", registry.name, "--image", tagged, ...run.subscription, "--query", "digest",
  ]);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new ConfigurationError("ACR did not return an immutable image digest");
  if (await sourceFingerprint() !== run.sourceHash) throw new ConfigurationError("Source changed during the image build; no workers were updated");
  return `${registry.server}/${image.repository}@${digest}`;
}

const rolloutDeadlineExceeded = () =>
  new ConfigurationError("Container Apps rollout deadline exceeded; inspect protected provenance and Azure revision status");

export async function verifyRollout(run: DeploymentRun, image: string, services?: string[]) {
  run.phase = "verify-rollout";
  const deadline = run.now() + run.prepared.settings.rolloutTimeoutSeconds * 1000;
  const pending = new Set(run.prepared.workers.filter(worker => !services || services.includes(worker.type)).map(worker => worker.appName));
  while (pending.size) {
    run.signal.throwIfAborted();
    for (const appName of [...pending]) {
      if (await isRolledOut(run, appName, image, deadline)) pending.delete(appName);
    }
    if (pending.size) {
      if (run.now() >= deadline) throw rolloutDeadlineExceeded();
      await run.sleep(Math.min(5000, deadline - run.now()));
    }
  }
}

async function isRolledOut(run: DeploymentRun, appName: string, image: string, deadline: number): Promise<boolean> {
  if (run.now() >= deadline) throw rolloutDeadlineExceeded();
  const app = await azJson<AppSnapshot>(run, "verify-rollout", [
    "containerapp", "show", "--name", appName, "--resource-group", run.prepared.document.healthModel.resourceGroup,
    ...run.subscription, "--query", appStatusQuery,
  ], Math.min(run.prepared.settings.commandTimeoutSeconds, (deadline - run.now()) / 1000));
  if (run.now() > deadline) throw rolloutDeadlineExceeded();
  if (app.provisioningState === "Failed") throw new ConfigurationError("A Container App rollout failed");
  return Boolean(app.latestRevisionName && app.latestRevisionName === app.latestReadyRevisionName &&
    app.images?.length && app.images.every(value => value === image));
}

export async function retireObsoleteEntities(run: DeploymentRun, retirements: Retirement[]) {
  for (const { modelPath, relationships, entities } of retirements) {
    for (const relationship of relationships) {
      const name = encodeURIComponent(relationship.name.split("/").at(-1)!);
      await deleteModelItem(run, "retire-obsolete-relationship", `${modelPath}/relationships/${name}?api-version=${relationshipVersion}`);
    }
    for (const entity of entities) {
      await deleteModelItem(run, "retire-obsolete-entity", `${modelPath}/entities/${encodeURIComponent(entity)}?api-version=${entityVersion}`);
    }
  }
}

const deleteModelItem = (run: DeploymentRun, phase: string, path: string) =>
  az(run, phase, ["rest", "--method", "delete", "--url", `${management}${path}`, ...run.subscription]);
