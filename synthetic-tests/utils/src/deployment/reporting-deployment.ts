import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AzureCliCredential } from "@azure/identity";
import { BlockBlobClient } from "@azure/storage-blob";
import { z } from "zod";
import { ConfigurationError } from "../configuration/config.js";
import { probeServices } from "../contracts.js";
import { groupSignalName, tenantSignalName } from "../configuration/groups.js";
import { az, azJson, hash, runFile, runtimeConfiguration, writeJson, type DeploymentRun } from "./deploy-phases.js";
import { nodeProjectDirectory } from "../paths.js";
import { serviceProbes } from "../configuration/service-config.js";

const template = "reporting-template.json";
const parameters = "reporting.parameters.json";

export async function writeReportingParameters(run: DeploymentRun): Promise<void> {
  const token = await azJson<{ accessToken: string }>(run, "deployment-identity", [
    "account", "get-access-token", "--resource", "https://management.azure.com/",
    "--tenant", run.prepared.settings.azureTenantId,
  ]);
  const claims = z.object({
    oid: z.string().uuid(), tid: z.string().uuid(), idtyp: z.string().optional(),
  }).parse(JSON.parse(Buffer.from(token.accessToken.split(".")[1]!, "base64url").toString("utf8")));
  if (claims.tid.toLowerCase() !== run.prepared.settings.azureTenantId.toLowerCase()) {
    throw new ConfigurationError("Deployment token belongs to a different tenant");
  }
  await writeJson(run, parameters, {
    parameters: {
      projectConfig: { value: run.prepared.document },
      location: { value: run.prepared.settings.location },
      workspaceName: { value: run.prepared.settings.workspaceName ?? `law-${run.prepared.document.healthModel.name}` },
      applicationInsightsName: { value: run.prepared.settings.applicationInsightsName ?? `appi-${run.prepared.document.healthModel.name}` },
      deploymentPrincipalId: { value: claims.oid },
      deploymentPrincipalType: { value: claims.idtyp === "app" ? "ServicePrincipal" : "User" },
    },
  });
}

export async function deployReportingFoundation(run: DeploymentRun, operation: "what-if" | "create"): Promise<void> {
  const phase = `reporting-foundation-${operation}`;
  run.phase = phase;
  await az(run, phase, [
    "deployment", "group", operation, "--resource-group", run.prepared.document.healthModel.resourceGroup,
    ...run.subscription, "--name", `reporting-foundation-${run.runId}`,
    "--template-file", runFile(run, template), "--parameters", `@${runFile(run, parameters)}`,
    ...(operation === "what-if" ? ["--no-pretty-print"] : []), "--output", "none",
  ]);
}

async function local(
  run: DeploymentRun, tool: "npm" | "zip", phase: string, args: string[], cwd = nodeProjectDirectory,
): Promise<void> {
  run.phase = phase;
  run.emit({ event: "monitoring-deployment-phase", phase });
  await run.runner({
    tool, args, phase, cwd, signal: run.signal, env: run.env,
    timeoutSeconds: run.prepared.settings.commandTimeoutSeconds,
  });
}

export async function deployIngestionFunction(run: DeploymentRun): Promise<void> {
  const settings = run.prepared.document.logAnalytics;
  if (!settings.enabled) throw new ConfigurationError("The ingestion Function requires logAnalytics.enabled");
  await local(run, "npm", "build-ingestion-function", ["run", "build"]);
  const directory = join(nodeProjectDirectory, ".function-package", run.runId);
  const zip = runFile(run, "ingestion-function.zip");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const manifest: unknown = JSON.parse(await readFile(join(nodeProjectDirectory, "package.json"), "utf8"));
    const parsed = z.object({ name: z.string(), version: z.string(), dependencies: z.record(z.string()) }).parse(manifest);
    const packageFile = join(directory, "package.json");
    await writeFile(packageFile, JSON.stringify({
      ...parsed, type: "module", private: true, main: "dist/ingestion/src/index.js", engines: { node: "22" },
    }), { mode: 0o644 });
    await chmod(packageFile, 0o644);
    await cp(join(nodeProjectDirectory, "package-lock.json"), join(directory, "package-lock.json"));
    await cp(join(nodeProjectDirectory, "dist"), join(directory, "dist"), { recursive: true });
    await cp(join(nodeProjectDirectory, "ingestion/host.json"), join(directory, "host.json"));
    await local(run, "npm", "package-ingestion-dependencies", ["ci", "--omit=dev", "--ignore-scripts"], directory);
    await local(run, "zip", "package-ingestion-function", ["-q", "-r", zip, "."], directory);
    await az(run, "deploy-ingestion-function", [
      "functionapp", "deployment", "source", "config-zip",
      "--resource-group", run.prepared.document.healthModel.resourceGroup,
      "--name", settings.functionAppName, ...run.subscription,
      "--src", zip, "--build-remote", "false", "--timeout", "600", "--output", "none",
    ]);
    await verifyIngestionFunction(run);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyIngestionFunction(run: DeploymentRun): Promise<void> {
  const { logAnalytics, healthModel } = run.prepared.document;
  if (!logAnalytics.enabled) throw new ConfigurationError("Function verification requires logAnalytics.enabled");
  const resource = `/subscriptions/${healthModel.subscriptionId}/resourceGroups/${healthModel.resourceGroup}/providers/Microsoft.Web/sites/${logAnalytics.functionAppName}`;
  await az(run, "sync-ingestion-trigger", [
    "rest", "--method", "post",
    "--url", `https://management.azure.com${resource}/syncfunctiontriggers?api-version=2024-04-01`,
    ...run.subscription, "--output", "none",
  ]);
  run.phase = "verify-ingestion-function";
  const consumerGroup = z.string().min(1).parse(await azJson<unknown>(run, run.phase, [
    "functionapp", "config", "appsettings", "list",
    "--resource-group", healthModel.resourceGroup, "--name", logAnalytics.functionAppName,
    ...run.subscription, "--query", "[?name=='OBSERVATION_CONSUMER_GROUP'] | [0].value",
  ]));
  const functionsSchema = z.object({ value: z.array(z.object({
    name: z.string(),
    properties: z.object({ config: z.object({ bindings: z.array(z.object({
      type: z.string(), consumerGroup: z.string().optional(), eventHubName: z.string().optional(),
      connection: z.string().optional(),
    })) }) }),
  })) });
  const deadline = run.now() + 300000;
  while (run.now() < deadline) {
    const functions = functionsSchema.parse(await azJson<unknown>(run, run.phase, [
      "rest", "--method", "get",
      "--url", `https://management.azure.com${resource}/functions?api-version=2024-04-01`, ...run.subscription,
    ])).value;
    if (functions.some(entry => entry.name.endsWith("/ingestObservations") && entry.properties.config.bindings.some(binding =>
      binding.type === "eventHubTrigger" && binding.consumerGroup === consumerGroup &&
      binding.eventHubName === logAnalytics.eventHubName && binding.connection === "ObservationEvents"))) {
      run.emit({ event: "observation-function-indexed", functionApp: logAnalytics.functionAppName, consumerGroup });
      return;
    }
    await run.sleep(5000);
  }
  throw new ConfigurationError("The ingestion package was uploaded, but ingestObservations was not indexed with the expected consumer group; inspect the Function deployment and host diagnostics");
}

export async function uploadWorkerConfiguration(run: DeploymentRun): Promise<void> {
  const snapshot = runtimeConfiguration(run);
  const credential = new AzureCliCredential({ tenantId: run.prepared.settings.azureTenantId });
  const blob = new BlockBlobClient(snapshot.url, credential);
  run.phase = "upload-worker-configuration";
  run.emit({ event: "monitoring-deployment-phase", phase: run.phase });
  for (let attempt = 0; attempt < 60; attempt++) {
    run.signal.throwIfAborted();
    try {
      await blob.uploadData(Buffer.from(snapshot.text), {
        conditions: { ifNoneMatch: "*" }, abortSignal: run.signal,
        blobHTTPHeaders: { blobContentType: "application/json" },
      });
      return;
    } catch (error) {
      const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
      if (status === 409 || status === 412) {
        const existing = await blob.downloadToBuffer(0, undefined, { abortSignal: run.signal });
        if (hash(existing) !== snapshot.sha256) throw new ConfigurationError("An existing runtime configuration blob has different contents");
        return;
      }
      if (status !== 403 || attempt === 59) throw error;
      run.emit({ event: "worker-configuration-permission-pending", attempt: attempt + 1 });
      await run.sleep(5000);
    }
  }
}

async function observationWorkspace(run: DeploymentRun): Promise<string> {
  const workspace = z.object({ customerId: z.string().uuid() }).parse(await azJson<unknown>(run, "observation-workspace", [
    "monitor", "log-analytics", "workspace", "show",
    "--resource-group", run.prepared.document.healthModel.resourceGroup,
    "--workspace-name", run.prepared.settings.workspaceName ?? `law-${run.prepared.document.healthModel.name}`,
    ...run.subscription, "--query", "{customerId:customerId}",
  ]));
  return workspace.customerId;
}

export async function verifyObservations(run: DeploymentRun, service: string, since: string): Promise<void> {
  const workers = run.prepared.workers.filter(worker => worker.type === service && worker.service.mode === "live");
  if (!workers.length) {
    run.emit({ event: "reporting-verification-skipped", service, reason: "simulation-does-not-publish-cloud-reports" });
    return;
  }
  if (!run.prepared.document.logAnalytics.enabled) throw new ConfigurationError("Observation ingestion verification requires logAnalytics.enabled");
  const expected = new Set(workers.flatMap(worker => serviceProbes(
    worker.service, worker.project.services[worker.type].scenarios,
  ).map(probe => `${worker.project.tenant.id}/${probe.id}/${probeServices[probe.type].journey}`)));
  if (!expected.size) throw new ConfigurationError("Observation verification requires selected live journey targets");
  const workspace = await observationWorkspace(run);
  const snapshot = runtimeConfiguration(run);
  const query = `M365Synthetic_CL | where Timestamp >= datetime(${since}) and Timestamp <= now() and Category == 'M365Synthetic' and Mode == 'live' and Kind == 'journey' | where Service == '${service}' and tostring(Dimensions.configSha256) == '${snapshot.sha256}' | summarize Records=count(), Failures=countif(Value == 0) by TenantAlias,TestAccountId,Journey`;
  run.phase = "verify-observation-ingestion";
  const deadline = run.now() + 480000;
  while (run.now() < deadline) {
    const rows = z.array(z.object({
      TenantAlias: z.string(), TestAccountId: z.string(), Journey: z.string(),
      Records: z.coerce.number().int().nonnegative(), Failures: z.coerce.number().int().nonnegative(),
    })).parse(await azJson<unknown>(run, run.phase, [
      "monitor", "log-analytics", "query", "--workspace", workspace,
      "--analytics-query", query, ...run.subscription,
    ]));
    const observed = new Set(rows.map(row => `${row.TenantAlias}/${row.TestAccountId}/${row.Journey}`));
    if ([...expected].every(pair => observed.has(pair))) {
      run.emit({
        event: "observation-ingestion-verified", service, expectedPairs: expected.size, Pairs: observed.size,
        Records: rows.reduce((sum, row) => sum + row.Records, 0),
        Failures: rows.reduce((sum, row) => sum + row.Failures, 0),
      });
      return;
    }
    await run.sleep(10000);
  }
  throw new ConfigurationError(`Fresh ${service} observations did not reach Log Analytics before the ingestion deadline`);
}

export async function verifyDirectReports(run: DeploymentRun, service: string, since: string): Promise<void> {
  if (run.prepared.document.logAnalytics.enabled) throw new ConfigurationError("Direct-report verification requires Log Analytics off");
  const workers = run.prepared.workers.filter(worker => worker.type === service && worker.service.mode === "live");
  if (!workers.length) {
    run.emit({ event: "reporting-verification-skipped", service, reason: "simulation-does-not-publish-cloud-reports" });
    return;
  }
  const expected = new Map<string, { samples: number; revision: string }>();
  for (const worker of workers) {
    const revision = z.string().min(1).parse(await azJson<unknown>(run, "direct-report-worker-revision", [
      "containerapp", "show", "--resource-group", run.prepared.document.healthModel.resourceGroup,
      "--name", worker.appName, ...run.subscription, "--query", "properties.latestReadyRevisionName",
    ]));
    const probes = serviceProbes(worker.service, worker.project.services[worker.type].scenarios);
    for (const journey of new Set(probes.map(probe => probe.type))) {
      const selected = probes.filter(probe => probe.type === journey);
      const definition = probeServices[journey];
      const scopes = [
        { group: undefined, samples: selected.length },
        ...worker.project.groups.filter(group => group.service === service).map(group => ({
          group: group.id, samples: selected.filter(probe => group.targetIds.includes(probe.id)).length,
        })),
      ];
      for (const scope of scopes.filter(scope => scope.samples >= worker.project.healthModel.minimumSamples)) {
        for (const metric of ["observed-success-percentage", "observed-mean-duration"]) {
          const signal = scope.group ? groupSignalName(scope.group, worker.tenant, metric)
            : worker.project.multiTenant ? tenantSignalName(worker.tenant, metric) : metric;
          expected.set(`${definition.entityName}/${signal}`, { samples: scope.samples, revision });
        }
      }
    }
  }
  if (!expected.size) throw new ConfigurationError("Direct-report minimumSamples excludes every selected live journey scope");
  const statusSchema = z.object({
    name: z.string(),
    status: z.object({
      reportedAt: z.string().optional(), additionalContext: z.string().optional(),
      value: z.number().optional(), healthState: z.string().optional(),
    }).optional(),
  });
  const responseSchema = z.object({ value: z.array(z.object({
    name: z.string(),
    properties: z.object({ signalGroups: z.object({
      azureLogAnalytics: z.unknown().optional(),
      external: z.object({ signals: z.array(statusSchema).default([]) }).nullish(),
    }).default({}) }),
  })) });
  const snapshot = runtimeConfiguration(run);
  const { subscriptionId, resourceGroup, name } = run.prepared.document.healthModel;
  const url = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.CloudHealth/healthmodels/${name}-${service}/entities?api-version=2026-10-01-preview`;
  run.phase = "verify-direct-health-reports";
  const deadline = run.now() + 480000;
  while (run.now() < deadline) {
    const response = responseSchema.parse(await azJson<unknown>(run, run.phase, [
      "rest", "--method", "get", "--url", url, ...run.subscription,
    ]));
    const observed = new Set<string>();
    for (const entity of response.value) {
      if (entity.properties.signalGroups.azureLogAnalytics) {
        throw new ConfigurationError(`Direct reporting retains an active Log Analytics source on ${entity.name}`);
      }
      for (const signal of entity.properties.signalGroups.external?.signals ?? []) {
        const key = `${entity.name}/${signal.name}`;
        const scope = expected.get(key);
        const status = signal.status;
        if (!scope || !status?.additionalContext || !status.reportedAt || Date.parse(status.reportedAt) < Date.parse(since)) continue;
        const context = z.object({
          configSha256: z.string().optional(), containerRevision: z.string().optional(), samples: z.number().optional(),
        }).parse(JSON.parse(status.additionalContext));
        if (context.configSha256 === snapshot.sha256 && context.containerRevision === scope.revision &&
            context.samples !== undefined && context.samples >= scope.samples && status.value !== undefined) observed.add(key);
      }
    }
    if ([...expected.keys()].every(key => observed.has(key))) {
      run.emit({ event: "direct-health-reports-verified", service, expectedSignals: expected.size, observedSignals: observed.size });
      return;
    }
    await run.sleep(10000);
  }
  throw new ConfigurationError(`Fresh ${service} direct health reports did not reach the model before the verification deadline`);
}

export async function deployFreshnessAlert(run: DeploymentRun): Promise<void> {
  if (!run.prepared.document.logAnalytics.enabled) throw new ConfigurationError("Log-based freshness alerts require logAnalytics.enabled");
  const file = runFile(run, "observation-alerts-template.json");
  await writeFile(file, await az(run, "build-freshness-alert", [
    "bicep", "build", "--file", join(nodeProjectDirectory, "../health-model/infra/observation-alerts.bicep"), "--stdout",
  ]), { flag: "wx", mode: 0o600 });
  const parameterFile = "observation-alerts.parameters.json";
  await writeJson(run, parameterFile, {
    parameters: {
      projectConfig: { value: run.prepared.document },
      location: { value: run.prepared.settings.healthModelLocation ?? run.prepared.settings.location },
      workspaceName: { value: run.prepared.settings.workspaceName ?? `law-${run.prepared.document.healthModel.name}` },
    },
  });
  const args = [
    "--resource-group", run.prepared.document.healthModel.resourceGroup, ...run.subscription,
    "--name", `observation-alerts-${run.runId}`, "--template-file", file,
    "--parameters", `@${runFile(run, parameterFile)}`, "--output", "none",
  ];
  await az(run, "freshness-alert-what-if", ["deployment", "group", "what-if", ...args, "--no-pretty-print"]);
  await az(run, "freshness-alert-create", ["deployment", "group", "create", ...args]);
  if (!run.prepared.document.healthModel.alertActionGroupIds.length ||
      !run.prepared.workers.some(worker => worker.service.mode === "live" &&
        serviceProbes(worker.service, worker.project.services[worker.type].scenarios).length > 0)) return;
  run.phase = "verify-freshness-query";
  const query = z.string().min(1).parse(await azJson<unknown>(run, run.phase, [
    "resource", "show", "--resource-group", run.prepared.document.healthModel.resourceGroup,
    "--name", `${run.prepared.document.healthModel.name}-observation-freshness`,
    "--resource-type", "Microsoft.Insights/scheduledQueryRules", "--api-version", "2023-12-01",
    ...run.subscription, "--query", "properties.criteria.allOf[0].query",
  ]));
  const workspace = await observationWorkspace(run);
  await az(run, run.phase, [
    "monitor", "log-analytics", "query", "--workspace", workspace,
    "--analytics-query", query, ...run.subscription, "--output", "none",
  ]);
}
