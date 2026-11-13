import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { AzureCliCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { z } from "zod";
import { ConfigurationError } from "../configuration/config.js";
import { groupSignalName, tenantSignalName } from "../configuration/groups.js";
import { prepareProjectDeployment } from "./prepare-deployment.js";
import { probeServices } from "../contracts.js";
import { serviceProbes } from "../configuration/service-config.js";
import { nodeProjectDirectory } from "../paths.js";
import { az, azJson, execute, runFile, runtimeConfiguration, type DeploymentRun } from "./deploy-phases.js";
import { makePackageReadable, prepareFunctionPackage } from "./function-package.js";
import { laneInstanceId } from "../../../functions/src/dispatch.js";
import { readLaneJournal } from "../../../functions/src/lane-ownership.js";

const serviceOrder = ["exchange", "teams", "onedrive", "sharepoint"] as const;
const serviceSuffix = { exchange: "ex", teams: "tm", onedrive: "od", sharepoint: "sp" } as const;

function executionServiceAppNames(run: DeploymentRun): Record<string, string> {
  const base = run.prepared.settings.functions.appName.slice(0, 57);
  return Object.fromEntries(
    [...new Set(run.prepared.owners.map(owner => owner.type))]
      .map(service => [service, `${base}-${serviceSuffix[service]}`]),
  );
}

function primaryService(run: DeploymentRun): (typeof serviceOrder)[number] {
  const appNames = executionServiceAppNames(run);
  const primary = serviceOrder.find(service => appNames[service] !== undefined);
  if (!primary) throw new ConfigurationError("Deployment requires at least one selected execution service");
  return primary;
}

/** Binds generated callback URLs to the actual Flex hostname rather than an obsolete Container App ingress. */
export async function resolveFunctionEndpoint(run: DeploymentRun): Promise<string> {
  const appNames = executionServiceAppNames(run);
  const hostnames = new Map<string, string>();
  for (const [service, appName] of Object.entries(appNames)) {
    const hostname = z.string().regex(/^[a-zA-Z0-9.-]+\.azurewebsites\.net$/).parse(await azJson<unknown>(run, "execution-function-hostname", [
      "functionapp", "show", "--resource-group", run.prepared.document.healthModel.resourceGroup,
      "--name", appName, ...run.subscription, "--query", "properties.defaultHostName",
    ]));
    hostnames.set(service, hostname);
  }
  const teamsHostname = hostnames.get("teams");
  const document = structuredClone(run.prepared.document);
  let rebound = 0;
  for (const tenant of document.tenants) {
    if (tenant.services.teams.enabled && tenant.services.teams.scenarios["scheduled-meeting"]) {
      if (!teamsHostname) throw new ConfigurationError("Teams scheduled-meeting requires a deployed Teams execution Function app");
      const callback = `https://${teamsHostname}/api/calls`;
      if (tenant.services.teams.execution.teamsCallingCallbackUrl !== callback) rebound++;
      tenant.services.teams.execution.teamsCallingCallbackUrl = callback;
    }
  }
  run.prepared = prepareProjectDeployment(document);
  run.emit({ event: "function-callback-bindings-resolved", changedGeneratedBindings: rebound, source: "actual-function-hostname" });
  const primaryHostname = hostnames.get(primaryService(run));
  if (!primaryHostname) throw new ConfigurationError("Primary execution Function hostname is unavailable");
  return `https://${primaryHostname}`;
}

/** Uploads the complete immutable root snapshot with Entra data-plane authentication, without target truncation. */
export async function uploadConfiguration(run: DeploymentRun): Promise<void> {
  const snapshot = runtimeConfiguration(run);
  const credential = new AzureCliCredential({ subscription: run.prepared.document.healthModel.subscriptionId });
  const blob = new BlobServiceClient(
    `https://${run.prepared.settings.configurationStorageAccount}.blob.core.windows.net`, credential,
  ).getContainerClient("configuration").getBlockBlobClient(`${snapshot.sha256}.json`);
  const deadline = run.now() + run.prepared.settings.rolloutTimeoutSeconds * 1000;
  for (;;) {
    try {
      await blob.uploadData(Buffer.from(snapshot.text), {
        blobHTTPHeaders: { blobContentType: "application/json" },
        abortSignal: AbortSignal.any([run.signal, AbortSignal.timeout(Math.max(1, deadline - run.now()))]),
      });
      return;
    } catch (error) {
      const forbidden = typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 403;
      if (!forbidden || run.now() >= deadline) throw error;
      run.emit({ event: "configuration-upload-waiting-for-rbac" });
      await run.sleep(Math.min(5000, deadline - run.now()));
    }
  }
}

/** Uses the configured operator account for Flex publishing; the CLI SCM helper uses its global default account. */
async function publishFunctionZip(run: DeploymentRun, appName: string, archive: string): Promise<void> {
  const hostnames = z.array(z.string()).parse(await azJson<unknown>(run, "execution-publishing-host", [
    "functionapp", "show", "--resource-group", run.prepared.document.healthModel.resourceGroup,
    "--name", appName, ...run.subscription, "--query", "properties.enabledHostNames",
  ]));
  const hosts = hostnames.filter(host => /^[a-zA-Z0-9.-]+\.azurewebsites\.net$/.test(host) && host.includes(".scm."));
  if (hosts.length !== 1) throw new ConfigurationError("Function app must expose exactly one trusted publishing hostname");
  const base = `https://${hosts[0]}`;
  const token = await new AzureCliCredential({ subscription: run.prepared.document.healthModel.subscriptionId })
    .getToken("https://management.azure.com/.default", { abortSignal: run.signal });
  if (!token) throw new ConfigurationError("The configured operator could not obtain a Function publishing token");
  const signal = AbortSignal.any([run.signal, AbortSignal.timeout(run.prepared.settings.commandTimeoutSeconds * 1000)]);
  const headers = { Authorization: `Bearer ${token.token}` };
  const statusSchema = z.object({ id: z.string().min(1), status: z.number().int() });
  const readStatus = async () => {
    const response = await fetch(`${base}/api/deployments/latest`, { headers, signal, redirect: "error" });
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if ([429, 502, 503, 504].includes(response.status)) {
      await response.body?.cancel();
      run.emit({ event: "function-publishing-status-unavailable", appName, httpStatus: response.status });
      return undefined;
    }
    if (!response.ok) throw new ConfigurationError(`Function publishing status failed with HTTP ${response.status}`);
    return statusSchema.parse(await response.json());
  };
  run.phase = "deploy-execution-functions";
  run.emit({ event: "monitoring-deployment-phase", phase: run.phase, appName });
  const previous = await readStatus();
  const response = await fetch(`${base}/api/publish?RemoteBuild=false&Deployer=monitoring`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/zip", "Cache-Control": "no-cache" },
    body: new Uint8Array(await readFile(archive)), signal, redirect: "error",
  });
  await response.body?.cancel();
  if (response.status !== 202) throw new ConfigurationError(`Function package publication failed with HTTP ${response.status}`);
  const deadline = run.now() + run.prepared.settings.rolloutTimeoutSeconds * 1000;
  while (run.now() < deadline) {
    const deployment = await readStatus();
    if (deployment && deployment.id !== previous?.id) {
      if (deployment.status === 3) throw new ConfigurationError("Function package publication reached Failed status");
      if (deployment.status === 4) {
        run.emit({ event: "function-package-published", appName, deploymentId: deployment.id });
        return;
      }
    }
    await run.sleep(Math.min(5000, deadline - run.now()));
  }
  throw new ConfigurationError("Function package publication did not complete within the configured rollout budget");
}

/** Packages and deploys execution Functions through the Entra-authenticated Flex API, with basic publishing disabled. */
export async function deployExecutionFunctions(run: DeploymentRun): Promise<void> {
  await execute(run, "npm", "build-execution-functions", ["run", "build"]);
  const directory = join(nodeProjectDirectory, ".function-package", run.runId);
  const archive = runFile(run, "execution-functions.zip");
  try {
    await prepareFunctionPackage(run.prepared.document, directory);
    await execute(run, "npm", "restore-function-package", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], directory);
    await makePackageReadable(directory);
    await execute(run, "zip", "archive-execution-functions", ["-q", "-r", archive, "."], directory);
    const appNames = [...Object.values(executionServiceAppNames(run)), `${run.prepared.settings.functions.appName.slice(0, 54)}-watch`];
    for (const appName of appNames) await publishFunctionZip(run, appName, archive);
    await verifyExecutionFunctions(run, archive);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Verifies actual indexed handlers and the deployed Entra-only starter authorization policy. */
async function verifyExecutionFunctions(run: DeploymentRun, archive: string): Promise<void> {
  const { healthModel, deployment } = run.prepared.document;
  const required = new Set(["startLane", "laneOrchestrator", "runLane", "teamsCallingCallback", "about"]);
  const appNames = executionServiceAppNames(run);
  const indexedFunctions = async (phase: string, appName: string) => new Set((await azJson<{ name: string }[]>(run, phase, [
    "functionapp", "function", "list", "--resource-group", healthModel.resourceGroup,
    "--name", appName, ...run.subscription, "--query", "[].{name:name}",
  ])).map(value => value.name.split("/").at(-1)));
  const waitForIndexedFunctions = async (phase: string, appName: string, deadline: number): Promise<boolean> => {
    while (run.now() < deadline) {
      const indexed = await indexedFunctions(phase, appName);
      if ([...required].every(name => indexed.has(name))) return true;
      const remaining = deadline - run.now();
      if (remaining <= 0) break;
      await run.sleep(Math.max(1, Math.min(5000, remaining)));
    }
    return false;
  };
  for (const [service, appName] of Object.entries(appNames)) {
    let indexed = await waitForIndexedFunctions("verify-indexed-execution-functions", appName,
      run.now() + run.prepared.settings.rolloutTimeoutSeconds * 1000);
    if (!indexed) {
      await publishFunctionZip(run, appName, archive);
      indexed = await waitForIndexedFunctions("verify-indexed-execution-functions-retry", appName,
        run.now() + run.prepared.settings.rolloutTimeoutSeconds * 1000);
    }
    if (!indexed) throw new ConfigurationError("The durable lane, activity and callback Functions were not indexed before the rollout deadline");
    const resource = `/subscriptions/${healthModel.subscriptionId}/resourceGroups/${healthModel.resourceGroup}/providers/Microsoft.Web/sites/${appName}`;
    const auth = await azJson<{
      properties: {
        platform: { enabled: boolean }; globalValidation: { requireAuthentication: boolean; excludedPaths: string[] };
        identityProviders: { azureActiveDirectory: {
          registration: { clientId: string };
          validation: { defaultAuthorizationPolicy: { allowedApplications: string[] } };
        } };
      };
    }>(run, "verify-function-entra-policy", [
      "rest", "--method", "get", "--url", `https://management.azure.com${resource}/config/authsettingsV2?api-version=2024-04-01`, ...run.subscription,
    ]);
    const policy = auth.properties;
    const provider = policy.identityProviders.azureActiveDirectory;
    const hasTeamsCallbackBypass = policy.globalValidation.excludedPaths.includes("/api/calls/*");
    if (!policy.platform.enabled || !policy.globalValidation.requireAuthentication ||
        policy.globalValidation.excludedPaths.some(path => path.includes("lanes") || path === "/*") ||
        hasTeamsCallbackBypass !== (service === "teams") ||
        provider.registration.clientId !== deployment!.functions.apiClientId ||
        provider.validation.defaultAuthorizationPolicy.allowedApplications.length !== 1 ||
        provider.validation.defaultAuthorizationPolicy.allowedApplications[0] !== deployment!.coordinator.identityClientId) {
      throw new ConfigurationError("The deployed Function starter is not restricted to the configured managed-identity dispatcher");
    }
  }
  const watchdogName = `${deployment!.functions.appName.slice(0, 54)}-watch`;
  const watchdog = await azJson<{ identities: Record<string, unknown> }>(run, "verify-watchdog-isolation", [
    "functionapp", "show", "--resource-group", healthModel.resourceGroup,
    "--name", watchdogName, ...run.subscription, "--query", "{identities:identity.userAssignedIdentities}",
  ]);
  if (Object.keys(watchdog.identities).length !== 1) throw new ConfigurationError("The independent watchdog must have only its non-Graph managed identity");
  const indexedWatchdog = await azJson<{ name: string }[]>(run, "verify-watchdog-indexing", [
    "functionapp", "function", "list", "--resource-group", healthModel.resourceGroup,
    "--name", watchdogName, ...run.subscription, "--query", "[].{name:name}",
  ]);
  if (!indexedWatchdog.some(item => item.name.endsWith("/monitoringWatchdog"))) throw new ConfigurationError("The separate monitoring watchdog Function was not indexed");
}

/** Reads the independently persisted execution journal using the operator's data-plane role. */
function executionContainer(run: DeploymentRun) {
  return new BlobServiceClient(`https://${run.prepared.settings.functions.storageAccount}.blob.core.windows.net`,
    new AzureCliCredential({ subscription: run.prepared.document.healthModel.subscriptionId })).getContainerClient("execution-state");
}

/** Fences unclaimed starts after pausing dispatch, then waits for executing mutations to settle. */
export async function pauseAndDrainCoordinator(run: DeploymentRun): Promise<void> {
  if (!run.previousCoordinator) return;
  await az(run, "pause-coordinator-for-upgrade", [
    "resource", "invoke-action", "--action", "stop",
    "--resource-type", "Microsoft.App/containerApps", "--name", run.prepared.settings.coordinator.appName,
    "--resource-group", run.prepared.document.healthModel.resourceGroup, ...run.subscription, "--output", "none",
  ]);
  const deadline = run.now() + Math.max(...run.prepared.lanes.map(lane => lane.intervalSeconds)) * 1000
    + run.prepared.settings.rolloutTimeoutSeconds * 1000;
  const container = executionContainer(run);
  const signal = AbortSignal.any([run.signal, AbortSignal.timeout(Math.max(1, deadline - run.now()))]);
  while (run.now() < deadline) {
    let active = 0;
    /** Conditional writes cannot retire an attempt that an activity has already claimed. */
    async function settleLane(name: string): Promise<void> {
      try {
        const blob = container.getBlockBlobClient(name);
        const current = await readLaneJournal(blob, signal);
        if (!current?.record) return;
        const record = current.record;
        if (record.phase === "ambiguous") throw new ConfigurationError("An ambiguous lane must be reconciled before upgrading execution");
        if (record.phase === "running") { active++; return; }
        if (!["starting", "accepted"].includes(record.phase)) return;
        const text = JSON.stringify({ ...record, phase: "failed", updatedAt: new Date(run.now()).toISOString() });
        await blob.upload(text, Buffer.byteLength(text), {
          conditions: { ifMatch: current.etag }, abortSignal: signal,
        });
        run.emit({
          event: "lane-unclaimed-start-retired", service: record.dispatch.service, lane: record.dispatch.lane,
          runId: record.runId, slot: record.dispatch.slot, previousPhase: record.phase,
        });
      } catch (error) {
        const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
        if (status !== 403 && status !== 412) throw error;
        active++;
        run.emit({ event: status === 403 ? "waiting-for-execution-state-rbac" : "waiting-for-lane-ownership-change", lane: name });
      }
    }
    for await (const page of container.listBlobsFlat({ prefix: "lanes/", abortSignal: signal }).byPage({ maxPageSize: 100 })) {
      for (let offset = 0; offset < page.segment.blobItems.length; offset += 8) {
        await Promise.all(page.segment.blobItems.slice(offset, offset + 8).map(item => settleLane(item.name)));
      }
    }
    if (!active) return;
    run.emit({ event: "waiting-for-active-lanes", activeLanes: active });
    await run.sleep(Math.min(5000, deadline - run.now()));
  }
  throw new ConfigurationError("Active durable lanes did not settle; the coordinator remains stopped for safe operator reconciliation");
}

/** Waits from the actual configured cadence, cycle and rollout budgets instead of a fixed five-minute assumption. */
export function reportingVerificationTimeout(run: DeploymentRun): number {
  return Math.max(...run.prepared.lanes.map(lane => {
    const owner = run.prepared.owners.find(owner => owner.tenant === lane.tenant && owner.type === lane.service)!;
    return lane.intervalSeconds + (lane.lane === "provider-context" ? lane.intervalSeconds :
      owner.service.cycleTimeoutSeconds + owner.service.cleanupGraceSeconds + owner.service.publicationTimeoutSeconds);
  })) * 1000 + run.prepared.settings.rolloutTimeoutSeconds * 1000;
}

/** Verifies every live lane actually executed and drained publication, not merely that the starter returned HTTP 202. */
export async function verifyLaneExecution(run: DeploymentRun, since: number): Promise<void> {
  const expected = run.prepared.lanes.filter(lane => run.prepared.owners.some(owner =>
    owner.tenant === lane.tenant && owner.type === lane.service && owner.service.mode === "live"));
  if (!expected.length) return;
  const snapshot = runtimeConfiguration(run);
  const container = executionContainer(run);
  const deadline = run.now() + reportingVerificationTimeout(run);
  while (run.now() < deadline) {
    let completed = 0;
    for (const lane of expected) {
      const blob = container.getBlockBlobClient(`lanes/${laneInstanceId({ tenant: lane.tenant, service: lane.service, lane: lane.lane })}.json`);
      const current = await readLaneJournal(blob, run.signal);
      if (!current?.record) continue;
      const record = current.record;
      if (record.dispatch.configSha256 !== snapshot.sha256 || Date.parse(record.updatedAt) < since) continue;
      if (record.phase === "failed" || record.phase === "ambiguous") throw new ConfigurationError("A Function lane failed execution/publication; inspect its persistent run correlation and Function console diagnostics");
      if (record.phase === "completed") completed++;
    }
    if (completed === expected.length) {
      run.emit({ event: "function-lane-execution-verified", laneCount: completed });
      return;
    }
    await run.sleep(Math.min(5000, deadline - run.now()));
  }
  throw new ConfigurationError("Not every selected Function lane completed execution and publication within the configured verification window");
}

/** Verifies target-level raw observations, including explicit Unknown, reached the actual Log Analytics table. */
export async function verifyObservations(run: DeploymentRun, since: number): Promise<void> {
  const expected = new Set(run.prepared.owners.filter(owner => owner.service.mode === "live").flatMap(owner =>
    serviceProbes(owner.service, owner.project.services[owner.type].scenarios)
      .map(probe => `${owner.tenant}/${owner.type}/${probe.id}/${probeServices[probe.type].journey}`)));
  if (!expected.size) return;
  const workspace = z.string().uuid().parse(await azJson<unknown>(run, "observation-workspace", [
    "monitor", "log-analytics", "workspace", "show", "--resource-group", run.prepared.document.healthModel.resourceGroup,
    "--workspace-name", run.prepared.settings.workspaceName ?? `law-${run.prepared.document.healthModel.name}`,
    ...run.subscription, "--query", "customerId",
  ]));
  const query = `M365Synthetic_CL | where Timestamp between (datetime(${new Date(since).toISOString()}) .. now()) and Category == 'M365Synthetic' and Mode == 'live' and Kind == 'journey' | where tostring(Dimensions.configSha256) == '${runtimeConfiguration(run).sha256}' | summarize Records=count(), Unknown=countif(isnull(Value)), Failures=countif(Value == 0) by TenantAlias,Service,TestAccountId,Journey`;
  const deadline = run.now() + reportingVerificationTimeout(run);
  while (run.now() < deadline) {
    const rows = z.array(z.object({
      TenantAlias: z.string(), Service: z.string(), TestAccountId: z.string(), Journey: z.string(),
      Unknown: z.coerce.number(), Failures: z.coerce.number(),
    })).parse(await azJson<unknown>(run, "verify-observation-ingestion", [
      "monitor", "log-analytics", "query", "--workspace", workspace, "--analytics-query", query, ...run.subscription,
    ]));
    const observed = new Set(rows.map(row => `${row.TenantAlias}/${row.Service}/${row.TestAccountId}/${row.Journey}`));
    if ([...expected].every(key => observed.has(key))) {
      run.emit({ event: "observation-ingestion-verified", expectedTargetsAndJourneys: expected.size,
        unknownObservations: rows.reduce((sum, row) => sum + row.Unknown, 0), observedFailures: rows.reduce((sum, row) => sum + row.Failures, 0) });
      return;
    }
    await run.sleep(Math.min(10000, deadline - run.now()));
  }
  throw new ConfigurationError("Every expected target/journey must reach M365Synthetic_CL; starter acceptance and partial ingestion are insufficient");
}

/** Follows only the exact ARM entity collection, rejecting pagination outside the selected model. */
async function modelEntities(run: DeploymentRun, service: string) {
  const { healthModel } = run.prepared.document;
  const collection = `https://management.azure.com/subscriptions/${healthModel.subscriptionId}/resourceGroups/${healthModel.resourceGroup}/providers/Microsoft.CloudHealth/healthmodels/${healthModel.name}-${service}/entities?`;
  let next: string | undefined = `${collection}api-version=2026-10-01-preview`;
  const entities: { name: string; properties: { signalGroups?: {
    azureLogAnalytics?: unknown; external?: { signals?: { name: string; status?: { reportedAt?: string; additionalContext?: string } }[] };
  } } }[] = [];
  for (let page = 0; next && page < 100; page++) {
    if (!next.startsWith(collection)) throw new ConfigurationError("Unexpected health entity pagination URL");
    const response: { value: typeof entities; nextLink?: string } = await azJson(run, "direct-model-entities", [
      "rest", "--method", "get", "--url", next, ...run.subscription,
    ]);
    entities.push(...response.value);
    next = response.nextLink;
  }
  if (next) throw new ConfigurationError("Health entity pagination exceeded its bound; no results were silently truncated");
  return entities;
}

/** Verifies complete target/group aggregate reports with the current snapshot, not per-target overwrites. */
export async function verifyDirectReports(run: DeploymentRun, since: number): Promise<void> {
  const expected = new Map<string, number>();
  for (const owner of run.prepared.owners.filter(owner => owner.service.mode === "live")) {
    const probes = serviceProbes(owner.service, owner.project.services[owner.type].scenarios);
    for (const type of new Set(probes.map(probe => probe.type))) {
      const selected = probes.filter(probe => probe.type === type);
      for (const scope of [
        { group: undefined, attempts: selected.length },
        ...owner.project.groups.filter(group => group.service === owner.type).map(group => ({
          group: group.id, attempts: selected.filter(probe => group.targetIds.includes(probe.id)).length,
        })),
      ].filter(scope => scope.attempts > 0)) {
        for (const metric of ["observed-success-percentage", "observed-mean-duration", "observed-graph-server-error-count"]) {
          const signal = scope.group ? groupSignalName(scope.group, owner.tenant, metric)
            : owner.project.multiTenant ? tenantSignalName(owner.tenant, metric) : metric;
          expected.set(`${owner.type}/${probeServices[type].entityName}/${signal}`, scope.attempts);
        }
      }
    }
  }
  if (!expected.size) return;
  const deadline = run.now() + reportingVerificationTimeout(run);
  while (run.now() < deadline) {
    const observed = new Set<string>();
    for (const service of new Set(run.prepared.owners.map(owner => owner.type))) {
      for (const entity of await modelEntities(run, service)) {
        if (entity.properties.signalGroups?.azureLogAnalytics) throw new ConfigurationError("Direct mode retains an active Log Analytics source");
        for (const signal of entity.properties.signalGroups?.external?.signals ?? []) {
          const key = `${service}/${entity.name.split("/").at(-1)}/${signal.name}`;
          if (!expected.has(key) || !signal.status?.reportedAt || !signal.status.additionalContext ||
              Date.parse(signal.status.reportedAt) < since) continue;
          const context = z.object({ configSha256: z.string(), attempts: z.number().int() })
            .parse(JSON.parse(signal.status.additionalContext));
          if (context.configSha256 === runtimeConfiguration(run).sha256 && context.attempts === expected.get(key)) observed.add(key);
        }
      }
    }
    if ([...expected.keys()].every(key => observed.has(key))) {
      run.emit({ event: "direct-health-ingestion-verified", aggregateSignalCount: expected.size });
      return;
    }
    await run.sleep(Math.min(10000, deadline - run.now()));
  }
  throw new ConfigurationError("Complete current-snapshot journey/group reports did not reach Azure Monitor Health Models");
}
