"""Contract tests for the health-model Bicep templates.

* Deployment parameters come from the real TypeScript (`prepareProjectDeployment`, as `npm run deploy` builds them).
* Templates are evaluated offline with `az bicep snapshot`, so entities, signal groups and outputs are checked as deployed.
* The signal names a worker publishes are captured from the real health reporter and compared with what the model
  declares, so the TypeScript -> Bicep contract is checked end to end.
"""
import copy
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TYPESCRIPT = ROOT / "synthetic-tests"
INFRA = ROOT / "health-model/infra"
SUBSCRIPTION = "00000000-0000-0000-0000-000000000000"
SERVICES = ("exchange", "teams", "onedrive")
SYNTHETIC_SIGNALS = ["synthetic-success-percentage", "synthetic-mean-duration"]
OTEL_SIGNALS = ["otel-success-percentage", "otel-mean-duration"]
FABRIKAM = "22222222-2222-4222-8222-222222222222"
SNAPSHOT_PREFIX = "model-snapshot-"

# A terminated run unwinds like an interrupted one, so it still removes the snapshot folder it is using.
signal.signal(signal.SIGTERM, signal.default_int_handler)

# Shared by the TypeScript scripts below: the JSON a script receives on stdin, read asynchronously because a
# synchronous read of a pipe fails with EAGAIN when the payload is still being written.
STDIN = """
async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
"""

# Shared by the scripts below: simulated healthy probe cycles and provider (Service Health) cycles.
SIMULATION = """
import { resultSchema } from './utils/src/contracts.ts';
import { simulate } from './utils/src/probes.ts';
import { activityFunctions, isPercentageActivity } from './utils/src/provider-catalog.ts';
import { serviceProbes } from './utils/src/service-config.ts';
import { serviceHealthNames } from './utils/src/service-health.ts';

const healthy = {
  config: { SYNTHETIC_SCENARIO: 'healthy', PROBE_TIMEOUT_MS: 120000, POLL_INTERVAL_MS: 2000 },
  telemetry: { emit() {} }, signal: new AbortController().signal,
};
const simulateAll = (service, scenarios) => Promise.all(serviceProbes(service, scenarios)
  .map(async probe => resultSchema.parse(await simulate(probe, healthy))));
function providerCycle(type) {
  const now = Date.now();
  const collectedAt = new Date(now).toISOString();
  return { cycleId: 'provider-contract', providerDiagnostics: [
    { kind: 'overview', service: type, collectedAt, serviceId: type === 'onedrive' ? 'OneDriveForBusiness' : type,
      serviceName: serviceHealthNames[type], status: 'serviceOperational' },
    { kind: 'issue-summary', service: type, collectedAt, count: 0 },
    ...activityFunctions[type].map(name => ({
      kind: 'activity', service: type, function: name, collectedAt,
      intervalStart: new Date(now - 15 * 60000).toISOString(), intervalEnd: collectedAt,
      aggregationIntervalMinutes: 15, ...(isPercentageActivity(name) ? { percentage: 0 } : { value: 0 }),
    })),
  ] };
}
"""

# Static facts about the TypeScript runtime: catalogue, test types and the reports a healthy cycle produces.
RUNTIME = SIMULATION + """
import { probeServices, journeyStepEntities, testTypes } from './utils/src/contracts.ts';
import { modelCatalog } from './utils/src/catalog.ts';
import { readProjectService } from './utils/src/project-config.ts';
import {
  aggregateHealthReports, serviceActivityReports, serviceHealthReport, serviceHealthIssuesReport, teamsCallSignals,
} from './utils/src/health-reports.ts';

const reports = {};
const providerReports = {};
const selected = {};
for (const type of ['exchange', 'teams', 'onedrive']) {
  const { project, service } = await readProjectService(type, '../monitoring.config.json');
  const scenarios = project.services[type].scenarios;
  const ttl = project.healthModel.reportTtlMinutes;
  selected[type] = [...new Set(serviceProbes(service, scenarios).map(probe => probe.type))];
  reports[type] = aggregateHealthReports(
    type, { cycleId: 'contract', results: await simulateAll(service, scenarios) }, project.healthModel);
  const cycle = providerCycle(type);
  providerReports[type] = [
    serviceHealthReport(type, cycle, ttl),
    serviceHealthIssuesReport(type, cycle, ttl),
    ...serviceActivityReports({
      ...service, serviceActivity: { ...service.serviceActivity, enabled: type !== 'onedrive', functions: undefined },
    }, cycle, ttl),
  ];
}
console.log(JSON.stringify({
  catalog: modelCatalog, definitions: probeServices, stepEntities: journeyStepEntities, testTypes, reports, selected,
  providerReports, activityFunctions, serviceHealthNames, teamsCallSignals,
}));
"""

# Deployment parameters exactly as `npm run deploy` builds them from each raw root configuration.
PREPARE = STDIN + """
import { prepareProjectDeployment } from './utils/src/prepare-deployment.ts';

const prepared = {};
for (const [name, raw] of Object.entries(await readInput())) {
  try {
    prepared[name] = { healthParameters: prepareProjectDeployment(raw).healthParameters };
  } catch (error) {
    prepared[name] = { error: error instanceof Error ? error.message : String(error) };
  }
}
console.log(JSON.stringify(prepared));
"""

# Every health report each tenant worker posts for a healthy cycle, captured from the real reporter in live mode.
PUBLISHED = STDIN + SIMULATION + r"""
import { createHealthReporter } from './utils/src/health-reports.ts';
import { parseProjectDocument, selectTenant, serviceExecution, serviceTypes } from './utils/src/project-config.ts';

const credential = { getToken: async () => ({ token: 'contract', expiresOnTimestamp: Date.now() + 3600000 }) };

async function published(raw) {
  const document = parseProjectDocument(raw);
  const requests = [];
  let tenant;
  const fetch = async (url, init) => {
    const [, model, entity] = new URL(String(url)).pathname
      .match(/healthmodels\/([^/]+)\/entities\/([^/]+)\/ingestHealthReport/);
    requests.push({ tenant, model, entity, signal: JSON.parse(init.body).signalName });
    return new Response(null, { status: 204 });
  };
  for (const { id } of document.tenants) {
    tenant = id;
    const project = selectTenant(document, id);
    for (const type of serviceTypes) {
      const selected = project.services[type];
      if (!selected.enabled || !Object.values(selected.scenarios).some(Boolean)) continue;
      const service = serviceExecution(project, type);
      const reporter = createHealthReporter(project, {
        ...service, mode: 'live', serviceHealth: true,
        serviceActivity: { ...service.serviceActivity, enabled: type !== 'onedrive' },
      }, { emit() {} }, {}, { credential, fetch });
      await reporter({ cycleId: 'contract', results: await simulateAll(service, selected.scenarios) });
      await reporter(providerCycle(type));
    }
  }
  return requests;
}

const output = {};
for (const [name, raw] of Object.entries(await readInput())) output[name] = await published(raw);
console.log(JSON.stringify(output));
"""


def run(command, **options):
    done = subprocess.run(command, capture_output=True, text=True, **options)
    if done.returncode:
        raise AssertionError(f"{' '.join(command[:4])} failed:\n{done.stderr or done.stdout}")
    return done.stdout


def typescript(script, payload=None):
    """Runs a module script against the real TypeScript sources and returns its JSON output."""
    return json.loads(run(["node", "--import", "tsx", "--input-type=module", "-e", script],
                          cwd=TYPESCRIPT, input=json.dumps(payload)))


def deployed_resources(template):
    resources = template["resources"]
    declarations = resources.values() if isinstance(resources, dict) else resources
    return [resource for resource in declarations if not resource.get("existing", False)]


def resolve_literals(value, template):
    if isinstance(value, str):
        reference = re.fullmatch(r"\[variables\('([^']+)'\)\]", value)
        if reference:
            return resolve_literals(template["variables"][reference.group(1)], template)
    if isinstance(value, list):
        return [resolve_literals(item, template) for item in value]
    if isinstance(value, dict):
        return {key: resolve_literals(item, template) for key, item in value.items()}
    return value


def remove_stale_snapshots(minutes=10):
    """Removes snapshot folders a killed run left behind; newer ones may belong to a run still in progress."""
    for folder in HERE.glob(f"{SNAPSHOT_PREFIX}*"):
        if time.time() - folder.stat().st_mtime > minutes * 60:
            shutil.rmtree(folder, ignore_errors=True)


def snapshot(template, parameters):
    """Evaluates a template offline for deployment parameters; returns its predicted resources and outputs."""
    with tempfile.TemporaryDirectory(prefix=SNAPSHOT_PREFIX, dir=HERE) as directory:
        directory = Path(directory)
        (directory / "parameters.json").write_text(json.dumps(parameters))
        file = directory / "deployment.bicepparam"
        file.write_text("\n".join([
            f"using '{os.path.relpath(template, directory)}'",
            "var values = loadJsonContent('./parameters.json').parameters",
            *(f"param {name} = values.{name}.value" for name in parameters["parameters"]),
        ]))
        run(["az", "bicep", "snapshot", "--file", str(file), "--subscription-id", SUBSCRIPTION,
             "--resource-group", "model-tests", "--location", "eastus2", "--only-show-errors"])
        return json.loads(file.with_suffix(".snapshot.json").read_text())


class Deployment:
    """What the model template predicts for one set of deployment parameters, indexed for the assertions."""

    def __init__(self, result):
        self.outputs = result["outputs"]
        resources = result["predictedResources"]
        of_type = lambda suffix: [item for item in resources if item["type"].endswith(suffix)]
        self.types = {item["type"] for item in resources}
        self.models = {item["name"] for item in resources if item["type"] == "Microsoft.CloudHealth/healthmodels"}
        self.entities = {tuple(item["name"].split("/")): item["properties"] for item in of_type("/entities")}
        self.relationships = {
            (item["name"].split("/")[0], item["properties"]["parentEntityName"], item["properties"]["childEntityName"])
            for item in of_type("/relationships")
        }
        self.authentications = of_type("/authenticationsettings")
        self.assignments = of_type("roleAssignments")

    def entity_names(self, model):
        return {entity for name, entity in self.entities if name == model}

    def relationship_pairs(self, model):
        return {(parent, child) for name, parent, child in self.relationships if name == model}

    def groups(self, model, entity):
        """The entity's signal aggregation groups by name, in declaration order."""
        return {group["name"]: group["members"]
                for group in self.entities[model, entity].get("signalAggregationGroups", [])}


def topology(model, service):
    """The entity names and (parent, child) relationships the catalogue defines for a service's journeys."""
    groups = {journey["group"]["entityName"] for journey in service["journeys"] if "group" in journey}
    entities = {model, *groups}
    relationships = {(model, group) for group in groups}
    for journey in service["journeys"]:
        entities.add(journey["entityName"])
        relationships.add((journey["group"]["entityName"] if "group" in journey else model, journey["entityName"]))
        for step in journey["steps"]:
            child = f'{journey["entityName"]}-{step["name"]}'
            entities.add(child)
            relationships.add((journey["entityName"], child))
    return entities, relationships


def runs(tenant, service, journey):
    selected = tenant["services"][service]
    return selected["enabled"] and selected["scenarios"][journey]


def reporting_tenants(document, service, journey=None):
    """Tenants whose workers publish to an entity: those running the journey, or all that host the service."""
    def publishes(tenant):
        selected = tenant["services"][service]
        if not selected["enabled"]:
            return False
        return selected["scenarios"][journey] if journey else any(selected["scenarios"].values())
    return [tenant["id"] for tenant in document["tenants"] if publishes(tenant)]


def external_signals(document, service, journey, signals):
    """Plain names for one tenant; with several, one `tenant-<alias>--` set per tenant that reports to the entity."""
    if len(document["tenants"]) == 1:
        return list(signals)
    return [f"tenant-{tenant}--{signal}" for tenant in reporting_tenants(document, service, journey)
            for signal in signals]


def group_signals(group, service, journey, signals):
    scopes = [scope for scope in group["scopes"] if scope["service"] == service and journey in scope["journeys"]]
    return [f'group-{group["id"]}--tenant-{scope["tenant"]}--{signal}' for scope in scopes for signal in signals]


def without_reporting_groups(properties):
    properties = copy.deepcopy(properties)
    groups = [group for group in properties.get("signalAggregationGroups", [])
              if not group["name"].startswith("reporting-")]
    properties.pop("signalAggregationGroups", None)
    return {**properties, **({"signalAggregationGroups": groups} if groups else {})}


# Raw root-configuration variants; each is a deep copy of the checked-in file with a few edits.
def tenant_services(config, index=0):
    return config["tenants"][index]["services"]


def select(service, names):
    """Turns on exactly the named scenarios of one tenant's service and off the rest."""
    for journey in service["scenarios"]:
        service["scenarios"][journey] = journey in names


def run_only(config, **journeys):
    for service, names in journeys.items():
        select(tenant_services(config)[service], names)


def disable_everything(config):
    for selected in tenant_services(config).values():
        selected["enabled"] = False


def providers(config):
    """Service Health and Azure Monitor OTEL."""
    config["serviceHealth"] = {"enabled": True}
    config["otel"] = {"enabled": True, "destination": "azure-monitor"}


def rich(config):
    """One tenant with every optional provider and a target that restores document versions."""
    providers(config)
    tenant_services(config)["onedrive"]["targets"][0]["restoreVersion"] = True


def second_tenant(config):
    """Adds Fabrikam with its own accounts, targets and workers, and a group spanning both tenants.

    The tenants run different journeys: Contoso runs everything except recurring calendar events and scheduled
    meetings; Fabrikam runs only send-receive mail, recurring calendar events and scheduled meetings, with OneDrive off.
    """
    providers(config)
    contoso = config["tenants"][0]
    fabrikam = copy.deepcopy(contoso)
    fabrikam.update(id="fabrikam", displayName="Fabrikam", tenantId=FABRIKAM)
    exchange, teams, onedrive = (fabrikam["services"][service] for service in SERVICES)
    accounts = ["test-user-3@example.invalid", "test-user-4@example.invalid"]
    for index, target in enumerate(exchange["targets"]):
        target.update(id=f"fabrikam-pair-{index + 1}", mailbox=accounts[index], recipientMailbox=accounts[1 - index])
        target["distributionList"] = {"address": "list@fabrikam.example.invalid", "expectedRecipients": accounts}
    teams["targets"][0].update(id="fabrikam-channel", tenantId=FABRIKAM)
    teams["callTargets"][0].update(id="fabrikam-meeting", tenantId=FABRIKAM)
    for index, target in enumerate(onedrive["targets"]):
        target.update(id=f"fabrikam-drive-{index + 1}", userPrincipalName=accounts[index],
                      userId=f"77777777-7777-4777-8777-00000000000{index}")
    onedrive["enabled"] = False
    for service, selected in fabrikam["services"].items():
        selected["worker"] = {"appName": f"fabrikam-{service}", "identityName": f"uami-fabrikam-{service}",
                              "cpu": 0.25, "memory": "0.5Gi"}
    select(contoso["services"]["exchange"], [name for name in exchange["scenarios"] if name != "recurring-calendar"])
    select(contoso["services"]["teams"], ["channel-conversation"])
    select(exchange, ["send-receive-mail", "recurring-calendar"])
    select(teams, ["scheduled-meeting"])
    config["tenants"].append(fabrikam)
    config["groups"].append({
        "id": "priority", "displayName": "Priority accounts",
        "accounts": ["test-user-1@example.invalid", accounts[0]], "teams": ["teams-probe-001", "fabrikam-meeting"],
    })


def restore_in_second_tenant(config):
    second_tenant(config)
    onedrive = tenant_services(config, 1)["onedrive"]
    onedrive["enabled"] = True
    onedrive["targets"][0]["restoreVersion"] = True


def make_variants(root):
    changes = {
        "root": lambda config: None,
        "nogroups": lambda config: config.update(groups=[]),
        "rich": rich,
        "two": second_tenant,
        "restore-second-tenant": restore_in_second_tenant,
        "none": disable_everything,
        "mail-only": lambda config: run_only(config, exchange=["send-receive-mail"]),
        "calendar-only": lambda config: run_only(config, exchange=["recurring-calendar", "meeting-invitation"]),
    }
    for service, selected in tenant_services(root).items():
        changes[f"off-{service}"] = lambda config, service=service: tenant_services(config)[service].update(enabled=False)
        changes[f"idle-{service}"] = lambda config, service=service: run_only(config, **{service: []})
        for journey in selected["scenarios"]:
            changes[f"without-{journey}"] = lambda config, service=service, journey=journey: (
                tenant_services(config)[service]["scenarios"].update({journey: False}))
    variants = {}
    for name, change in changes.items():
        variants[name] = copy.deepcopy(root)
        change(variants[name])
    return variants


class ModelTemplateContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        remove_stale_snapshots()
        cls.template = json.loads(run(["az", "bicep", "build", "--file", str(INFRA / "main.bicep"), "--stdout"]))
        cls.project = json.loads((ROOT / "monitoring.config.json").read_text())
        cls.tenant = cls.project["tenants"][0]
        cls.name = cls.project["healthModel"]["name"]
        cls.projection = json.loads((ROOT / "synthetic-tests/utils/src/catalog.json").read_text())
        cls.catalog = resolve_literals(cls.template["variables"]["serviceDefinitions"], cls.template)
        cls.resources = deployed_resources(cls.template)
        cls.module = next(item for item in cls.resources if item["type"] == "Microsoft.Resources/deployments")
        cls.service_template = cls.module["properties"]["template"]
        cls.service_resources = deployed_resources(cls.service_template)
        cls.functions = next(item for item in cls.service_template["functions"] if item["namespace"] == "__bicep")["members"]
        cls.runtime = typescript(RUNTIME)
        cls.prepared = typescript(PREPARE, make_variants(cls.project))
        cls.deployments = {}
        cls.published = {}

    def parameters(self, name):
        prepared = self.prepared[name]
        self.assertNotIn("error", prepared, f"{name}: {prepared.get('error')}")
        return prepared["healthParameters"]["parameters"]

    def document(self, name):
        return self.parameters(name)["projectConfig"]["value"]

    def reporting_groups(self, name):
        return self.parameters(name)["reportingGroups"]["value"]

    def deployment(self, name):
        if name not in self.deployments:
            parameters = {**self.prepared[name]["healthParameters"], "parameters": self.parameters(name)}
            self.deployments[name] = Deployment(snapshot(INFRA / "main.bicep", parameters))
        return self.deployments[name]

    def published_signals(self, name):
        """The posted signal names by (model, entity), checking that no two tenant workers post the same one."""
        if name not in self.published:
            requests = typescript(PUBLISHED, {name: self.document(name)})[name]
            owners, signals = {}, {}
            for request in requests:
                key = request["model"], request["entity"]
                owners.setdefault((*key, request["signal"]), set()).add(request["tenant"])
                signals.setdefault(key, set()).add(request["signal"])
            overwritten = {key: sorted(tenants) for key, tenants in owners.items() if len(tenants) > 1}
            self.assertEqual(overwritten, {}, f"{name}: workers of different tenants overwrite each other's signals")
            self.published[name] = signals
        return self.published[name]

    def selected_services(self, document):
        """The catalogue restricted to the journeys some tenant runs: the shape the model is expected to take."""
        selected = []
        for definition in self.catalog:
            service = copy.deepcopy(definition)
            service["journeys"] = [
                journey for journey in service["journeys"]
                if any(runs(tenant, service["service"], journey["name"]) for tenant in document["tenants"])
            ]
            if service["journeys"]:
                selected.append(service)
        return selected

    def expected_groups(self, name):
        """The aggregation groups each entity must declare, derived from the contract alone."""
        document = self.document(name)
        otel = document["otel"]["enabled"] and document["otel"]["destination"] == "azure-monitor"
        expected = {}

        def declare(model, entity, service, journey, signals, reporting=False):
            declared = {"external-reports": external_signals(document, service, journey, signals)}
            if otel and journey:
                declared["otel"] = OTEL_SIGNALS
            for group in self.reporting_groups(name) if reporting else []:
                members = group_signals(group, service, journey, signals)
                if members:
                    declared[f'reporting-{group["id"]}'] = members
            expected[model, entity] = declared

        for service in self.selected_services(document):
            kind, model = service["service"], f'{self.name}-{service["service"]}'
            for journey in service["journeys"]:
                calls = self.runtime["teamsCallSignals"] if journey["entityName"] == "teams-call" else []
                declare(model, journey["entityName"], kind, journey["name"], [*SYNTHETIC_SIGNALS, *calls], reporting=True)
                for step in journey["steps"]:
                    declare(model, f'{journey["entityName"]}-{step["name"]}', kind, journey["name"], SYNTHETIC_SIGNALS)
            if document["serviceHealth"]["enabled"]:
                provider = ["microsoft-reported-service-status", "microsoft-reported-issue-count",
                            *(f"microsoft-activity-{function}" for function in self.projection["providerActivityFunctions"][kind])]
                declare(model, f"{kind}-service-health", kind, None, provider)
        return expected

    def assert_signal_groups(self, name):
        """Every entity declares exactly the contract's groups, in order; parents and the root model declare none."""
        deployment, expected = self.deployment(name), self.expected_groups(name)
        self.assertLessEqual(set(expected), set(deployment.entities))
        for (model, entity), properties in deployment.entities.items():
            if model == self.name:
                self.assertNotIn("signalAggregationGroups", properties, entity)
            else:
                self.assertEqual(list(deployment.groups(model, entity).items()),
                                 list(expected.get((model, entity), {}).items()), (model, entity))

    # ---- deployment parameters and shared catalogue --------------------------------------------------------------

    def test_deploy_parameters_are_exactly_the_template_parameters(self):
        supplied = set(self.parameters("root"))
        self.assertEqual(supplied, {"projectConfig", "reportingGroups", "location", "workspaceName", "applicationInsightsName"})
        self.assertEqual(supplied, set(self.template["parameters"]))
        default = resolve_literals(self.template["parameters"]["projectConfig"]["defaultValue"], self.template)
        self.assertEqual(default, self.project)
        self.assertEqual(self.template["parameters"]["reportingGroups"]["defaultValue"], [])
        self.assertEqual([group["id"] for group in self.reporting_groups("root")], ["centralus", "uksouth"])
        self.assertEqual(self.reporting_groups("nogroups"), [])
        self.assertEqual(self.document("root")["tenants"][0]["id"], self.tenant["id"])
        for name in ("projectConfig", "reportingGroups"):
            self.assertIn("npm run deploy", self.template["parameters"][name]["metadata"]["description"])

    def test_shared_catalog_projection_is_fresh_and_consumed_by_bicep(self):
        self.assertEqual(self.projection, self.runtime["catalog"],
                         "Run npm run catalog:generate in synthetic-tests after editing the catalogue")
        self.assertEqual(self.catalog, self.projection["serviceDefinitions"])
        self.assertEqual(
            resolve_literals(self.service_template["variables"]["providerActivityFunctions"], self.service_template),
            self.projection["providerActivityFunctions"],
        )

    def test_the_root_config_models_every_catalog_journey_and_step(self):
        self.assertEqual({service["service"] for service in self.catalog}, set(self.tenant["services"]))
        for service in self.catalog:
            for journey in service["journeys"]:
                self.assertIn(journey["name"], self.tenant["services"][service["service"]]["scenarios"])
                self.assertFalse({"authenticate", "cleanup"} & {step["name"] for step in journey["steps"]})
        selected = self.selected_services(self.document("root"))
        journeys = [journey for service in selected for journey in service["journeys"]]
        steps = sum(len(journey["steps"]) for journey in journeys)
        groups = len({journey["group"]["entityName"] for journey in journeys if "group" in journey})
        self.assertEqual({service["service"] for service in selected}, {"exchange", "teams", "onedrive"})
        self.assertFalse(self.project["serviceHealth"]["enabled"])
        self.assertEqual((len(selected) + 1, 1 + len(selected) * 2 + groups + len(journeys) + steps,
                          len(selected) + groups + len(journeys) + steps), (4, 67, 63))
        self.assertEqual((len(journeys), steps), (12, 46))
        deployment = self.deployment("root")
        outputs = deployment.outputs
        self.assertEqual((outputs["modelCount"], outputs["entityCount"], outputs["relationshipCount"]), (4, 67, 63))
        self.assertEqual((outputs["journeyCount"], outputs["stepCount"]), (12, 46))
        self.assertEqual((len(deployment.models), len(deployment.entities), len(deployment.relationships)), (4, 67, 63))
        for output in ("entityCount", "relationshipCount"):
            self.assertIn("variables('journeyGroupCount')", self.template["outputs"][output]["value"])

    def test_service_and_scenario_selection_contract(self):
        self.assertIn("variables('selectedServices')", self.template["variables"]["enabledServices"])
        for resource in self.resources:
            if "copy" in resource:
                self.assertEqual(resource["copy"]["count"], "[length(variables('enabledServices'))]")
        root = self.deployment("root")
        for service in SERVICES:
            for gate in ("off", "idle"):
                with self.subTest(service=service, gate=gate):
                    deployment = self.deployment(f"{gate}-{service}")
                    others = [name for name in SERVICES if name != service]
                    self.assertEqual(deployment.models, {self.name, *(f"{self.name}-{name}" for name in others)})
                    self.assertEqual(deployment.outputs["serviceNames"], others)
                    for name in others:
                        model = f"{self.name}-{name}"
                        self.assertEqual(deployment.entity_names(model), root.entity_names(model))

    def test_every_retained_journey_is_selected_independently(self):
        root = self.deployment("root")
        for service in self.catalog:
            model = f'{self.name}-{service["service"]}'
            for journey in service["journeys"]:
                with self.subTest(journey=journey["name"]):
                    deployment = self.deployment(f'without-{journey["name"]}')
                    remaining = {**service, "journeys": [item for item in service["journeys"] if item != journey]}
                    entities, relationships = topology(model, remaining)
                    self.assertEqual(deployment.entity_names(model), entities)
                    self.assertEqual(deployment.relationship_pairs(model), relationships)
                    for other in SERVICES:
                        if other != service["service"]:
                            other_model = f"{self.name}-{other}"
                            self.assertEqual(deployment.entity_names(other_model), root.entity_names(other_model))

    def test_a_journey_is_modeled_when_any_tenant_runs_it(self):
        document, deployment = self.document("two"), self.deployment("two")
        contoso, fabrikam = document["tenants"]
        self.assertFalse(runs(contoso, "exchange", "recurring-calendar"))
        self.assertFalse(runs(fabrikam, "exchange", "edit-reopen-draft"))
        self.assertFalse(runs(contoso, "teams", "scheduled-meeting"))
        self.assertFalse(runs(fabrikam, "onedrive", "user-drive-roundtrip"))
        selected = {service["service"]: service for service in self.selected_services(document)}
        for service in self.catalog:
            self.assertEqual([journey["name"] for journey in selected[service["service"]]["journeys"]],
                             [journey["name"] for journey in service["journeys"]], "every journey is run by some tenant")
        for kind, service in selected.items():
            model, context = f"{self.name}-{kind}", f"{kind}-service-health"
            entities, relationships = topology(model, service)
            self.assertEqual(deployment.entity_names(model), entities | {context})
            self.assertEqual(deployment.relationship_pairs(model), relationships | {(model, context)})
        self.assertEqual(deployment.outputs["serviceNames"], list(SERVICES))

    # ---- catalogue facts kept from the single-tenant suite -----------------------------------------------------

    def test_call_connectivity_preserves_journey_place_end_ids_without_audio_testing(self):
        teams = next(service for service in self.catalog if service["service"] == "teams")
        self.assertEqual([journey["entityName"] for journey in teams["journeys"]],
                         ["teams-global", "teams-call"])
        channel = next(journey for journey in teams["journeys"] if journey["name"] == "channel-conversation")
        self.assertEqual([step["name"] for step in channel["steps"]],
                         ["post-message", "confirm-publication", "post-reply", "confirm-reply"])
        call = next(journey for journey in teams["journeys"] if journey["name"] == "scheduled-meeting")
        self.assertEqual([step["name"] for step in call["steps"]],
                         ["place-call", "wait-for-answer", "verify-meeting-metadata", "verify-participants",
                          "end-call"])
        self.assertEqual(len(self.tenant["services"]["teams"]["callTargets"]), 1)
        self.assertEqual(len(self.tenant["services"]["teams"]["targets"]), 1)
        self.assertEqual((1 + len(call["steps"])) * 2, 12)

    def test_exchange_seven_journeys_and_all_business_steps(self):
        exchange = next(service for service in self.catalog if service["service"] == "exchange")
        self.assertEqual([journey["name"] for journey in exchange["journeys"]], [
            "send-receive-mail", "edit-reopen-draft", "attachment-mail", "reply-mail",
            "distribution-list-mail", "recurring-calendar", "meeting-invitation",
        ])
        self.assertTrue(all(self.tenant["services"]["exchange"]["scenarios"].values()))
        by_name = {journey["name"]: journey for journey in exchange["journeys"]}
        self.assertEqual([step["name"] for step in by_name["attachment-mail"]["steps"]],
                         ["send-attachment", "verify-attachment"])
        self.assertEqual([step["name"] for step in by_name["reply-mail"]["steps"]],
                         ["reply-mail", "confirm-reply-mail"])
        self.assertEqual([step["name"] for step in by_name["edit-reopen-draft"]["steps"]],
                         ["create-draft", "read-initial-draft", "update-draft", "read-draft", "delete-draft"])
        self.assertEqual(by_name["recurring-calendar"]["steps"][-1]["name"], "delete-event")
        self.assertEqual(by_name["meeting-invitation"]["steps"][-1]["name"], "cancel-meeting")

    def test_catalog_contains_only_journey_and_business_step_metadata(self):
        for service in self.catalog:
            self.assertEqual(set(service), {"service", "displayName", "journeys"})
            for journey in service["journeys"]:
                expected = {"name", "entityName", "displayName", "steps"}
                self.assertEqual(set(journey), expected | {"group"} if service["service"] == "exchange" else expected)
                if "group" in journey:
                    self.assertEqual(set(journey["group"]), {"entityName", "displayName"})
                self.assertTrue(all(
                    set(step) in ({"name", "displayName"}, {"name", "displayName", "telemetryName"})
                    for step in journey["steps"]
                ))

    def test_no_removed_service_or_planned_branch_can_reappear_from_the_template(self):
        compiled = json.dumps(self.template)
        for removed in (
            "sharepoint", "includePlannedJourneys", "plannedServiceDefinitions", "plannedJourneyCount",
            "[Planned / unimplemented]", "answered-audio", "recipient-file-sharing", "adaptive-card",
            "recipient-sharing", "search-retrieve", "two-bot-conversation", "browser-upload",
            "external-inbound", "external-outbound", "search-organize-mail", "outlook-web",
        ):
            self.assertNotIn(removed, compiled)
        self.assertNotIn("quality", compiled.lower(), "the model has no call-quality signals or thresholds")
        self.assertFalse((INFRA / "planned-catalog.bicep").exists())
        self.assertFalse((INFRA / "project-groups.bicep").exists())
        self.assertEqual([service["service"] for service in self.catalog], ["exchange", "teams", "onedrive"])
        self.assertNotIn("'planned'", self.service_template["variables"]["nodes"])

    def test_runtime_scenarios_test_types_steps_and_report_entities_match_the_final_catalog_exactly(self):
        expected_types = {
            "exchange": [
                "exchange-mail-flow", "exchange-draft", "exchange-attachment", "exchange-reply",
                "exchange-distribution-list", "exchange-recurring-calendar", "exchange-meeting",
            ],
            "teams": ["teams-channel-message", "teams-call"],
            "onedrive": ["onedrive-roundtrip", "onedrive-appfolder", "onedrive-versions"],
        }
        self.assertEqual(self.runtime["selected"], expected_types)
        self.assertEqual(set(self.runtime["testTypes"]), set(self.runtime["definitions"]))
        self.assertEqual(set(self.runtime["testTypes"]), {name for names in expected_types.values() for name in names})
        for service in self.catalog:
            name = service["service"]
            self.assertEqual(set(self.tenant["services"][name]["scenarios"]),
                             {journey["name"] for journey in service["journeys"]})
            expected_entities = set()
            for journey in service["journeys"]:
                definition = next(item for item in self.runtime["definitions"].values()
                                  if item["service"] == name and item["journey"] == journey["name"])
                self.assertEqual(definition["entityName"], journey["entityName"])
                self.assertEqual([step for step in definition["steps"] if step not in ("authenticate", "cleanup")],
                                 [step.get("telemetryName", step["name"]) for step in journey["steps"]])
                test_type = next(key for key, value in self.runtime["definitions"].items() if value == definition)
                aliases = self.runtime["stepEntities"].get(test_type, {})
                self.assertEqual([aliases.get(step.get("telemetryName", step["name"]), step.get("telemetryName", step["name"]))
                                  for step in journey["steps"]], [step["name"] for step in journey["steps"]])
                expected_entities.add(journey["entityName"])
                expected_entities.update(f'{journey["entityName"]}-{step["name"]}' for step in journey["steps"])
            reports = self.runtime["reports"][name]
            self.assertEqual({report["entityName"] for report in reports}, expected_entities)
            for entity in expected_entities:
                signals = {report["body"]["signalName"] for report in reports if report["entityName"] == entity}
                self.assertTrue({"synthetic-success-percentage", "synthetic-mean-duration"}.issubset(signals))
                self.assertEqual(len(signals), 6 if entity == "teams-call" else 2)

    # ---- topology -----------------------------------------------------------------------------------------------

    def test_exchange_mail_and_calendar_parents_roll_up_without_placeholder_reports(self):
        exchange = next(service for service in self.catalog if service["service"] == "exchange")
        expected = {
            "exchange-mail": {"exchange-global", "exchange-draft", "exchange-attachment", "exchange-reply", "exchange-distribution"},
            "exchange-calendar": {"exchange-recurring", "exchange-meeting"},
        }
        deployment = self.deployment("rich")
        model = f"{self.name}-exchange"
        entities = {name: deployment.entities[model, name] for name in deployment.entity_names(model)}
        relationships = deployment.relationship_pairs(model)
        self.assertEqual({child for parent, child in relationships if parent == model},
                         {*expected, "exchange-service-health"})
        for group, children in expected.items():
            with self.subTest(group=group):
                self.assertEqual({child for parent, child in relationships if parent == group}, children)
                self.assertEqual(entities[group]["displayName"], "Mail" if group == "exchange-mail" else "Calendar")
                self.assertEqual(entities[group]["impact"], "Standard")
                self.assertEqual(entities[group]["signalGroups"], {
                    "dependencies": {"aggregationType": "WorstOf", "ignoreUnknown": False},
                })
                self.assertNotIn("signalAggregationGroups", entities[group])
                for child in children:
                    self.assertLess(entities[group]["canvasPosition"]["y"], entities[child]["canvasPosition"]["y"])
        icon_entities = {name for name, properties in entities.items() if "icon" in properties}
        self.assertEqual(icon_entities, {*expected, *(child for children in expected.values() for child in children)})
        self.assertTrue(all(entities[name]["icon"] == {"iconName": "UserFlow"} for name in icon_entities))
        self.assertEqual(entities["exchange-service-health"]["impact"], "Suppressed")
        for journey in exchange["journeys"]:
            names = list(deployment.groups(model, journey["entityName"]))
            self.assertEqual([name for name in names if not name.startswith("reporting-")], ["external-reports", "otel"])
        published = {entity for _, entity in self.published_signals("rich")}
        self.assertFalse(set(expected) & published, "group parents never receive placeholder reports")
        self.assertFalse({"exchange-mail", "exchange-calendar"} &
                         {report["entityName"] for report in self.runtime["reports"]["exchange"]})

    def test_selected_parents_and_ungrouped_services_have_exact_topology(self):
        cases = [
            ("mail-only", "exchange", {"exchange-mail"}),
            ("calendar-only", "exchange", {"exchange-calendar"}),
            ("root", "teams", set()),
            ("root", "onedrive", set()),
        ]
        for variant, name, groups in cases:
            with self.subTest(variant=variant, service=name):
                deployment = self.deployment(variant)
                service = next(item for item in self.selected_services(self.document(variant)) if item["service"] == name)
                model = f"{self.name}-{name}"
                entities, relationships = topology(model, service)
                self.assertEqual(entities & {"exchange-mail", "exchange-calendar"}, groups)
                self.assertEqual(deployment.entity_names(model), entities)
                self.assertEqual(deployment.relationship_pairs(model), relationships)
                for journey in service["journeys"]:
                    y = deployment.entities[model, journey["entityName"]]["canvasPosition"]["y"]
                    self.assertEqual(y, 440 if groups else 240)

    def test_exact_selected_inventory_excludes_all_retired_provider_children(self):
        totals = {"exchange": (35, 34), "teams": (12, 11), "onedrive": (16, 15)}
        plain = {item["service"]: item for item in self.deployment("root").outputs["serviceModelInventories"]}
        supported = {item["service"]: item for item in self.deployment("rich").outputs["serviceModelInventories"]}
        for service in self.selected_services(self.document("root")):
            name = service["service"]
            model = f"{self.name}-{name}"
            context = f"{name}-service-health"
            entities, relationships = topology(model, service)
            links = {f"{parent}-to-{child}" for parent, child in relationships}
            self.assertEqual((len(entities), len(relationships)), totals[name])
            self.assertEqual(set(plain[name]["entityNames"]), entities)
            self.assertEqual(set(plain[name]["relationshipNames"]), links)
            self.assertEqual(set(supported[name]["entityNames"]), entities | {context})
            self.assertEqual(set(supported[name]["relationshipNames"]), links | {f"{model}-to-{context}"})
            self.assertEqual((len(supported[name]["entityNames"]), len(supported[name]["relationshipNames"])),
                             (totals[name][0] + 1, totals[name][1] + 1))
            self.assertFalse(any(entity.startswith(f"{context}-") for entity in supported[name]["entityNames"]))
            self.assertFalse(any(link.startswith(f"{context}-to-") for link in supported[name]["relationshipNames"]))
        outputs = self.service_template["outputs"]
        self.assertEqual(outputs["entityNames"]["copy"]["count"], "[length(variables('nodes'))]")
        self.assertEqual(outputs["relationshipNames"]["copy"]["count"], "[length(variables('relationships'))]")
        self.assertIn("serviceModelInventories", self.template["outputs"])
        self.assertIn("rootEntityNames", self.template["outputs"])
        self.assertIn("rootRelationshipNames", self.template["outputs"])

    def test_root_model_references_each_service_model_without_signal_groups(self):
        reference = next(item for item in self.resources if item.get("copy", {}).get("name") == "serviceReferences")
        source = reference["properties"]["signalGroups"]["azureResource"]
        self.assertIn("Microsoft.CloudHealth/healthmodels", source["azureResourceId"])
        self.assertEqual(source["signals"], [])
        self.assertIn("nested-models", source["authenticationSetting"])
        reader = next(item for item in self.resources if item["type"] == "Microsoft.Authorization/roleAssignments")
        self.assertIn("Microsoft.CloudHealth/healthmodels", reader["scope"])
        self.assertNotIn("condition", reader)
        deployment = self.deployment("root")
        references = [f"{service}-experience" for service in SERVICES]
        self.assertEqual(deployment.entity_names(self.name), {self.name, *references})
        self.assertEqual(deployment.relationship_pairs(self.name), {(self.name, name) for name in references})
        self.assertEqual(deployment.outputs["rootEntityNames"], [self.name, *references])
        for name in (self.name, *references):
            self.assertEqual(set(deployment.entities[self.name, name]),
                             {"displayName", "impact", "canvasPosition", "signalGroups"}, name)
        self.assertEqual(len(deployment.authentications), 1)
        self.assertEqual(len(deployment.assignments), len(SERVICES))
        for name in SERVICES:
            self.assertEqual(deployment.entities[self.name, f"{name}-experience"]["signalGroups"]["azureResource"]["signals"], [])

    def test_all_services_disabled_keeps_evidence_free_root(self):
        self.assertEqual(self.selected_services(self.document("none")), [])
        deployment = self.deployment("none")
        self.assertEqual(deployment.models, {self.name})
        self.assertEqual(set(deployment.entities), {(self.name, self.name)})
        self.assertEqual(deployment.entities[self.name, self.name]["signalGroups"]["dependencies"], {
            "aggregationType": "WorstOf", "ignoreUnknown": False,
        })
        self.assertEqual(deployment.relationships, set())
        self.assertEqual(self.reporting_groups("none"), [])
        self.assertEqual((deployment.outputs["modelCount"], deployment.outputs["entityCount"]), (1, 1))
        roots = [item for item in self.resources if item["type"] == "Microsoft.CloudHealth/healthmodels"]
        self.assertEqual(len(roots), 1)
        self.assertNotIn("condition", roots[0])

    def test_only_journeys_and_parent_journeys_have_user_flow_icon(self):
        entity = next(item for item in self.service_resources if item["type"].endswith("/entities"))
        properties = entity["properties"]
        self.assertIn("if(or(equals(variables('nodes')[copyIndex()].kind, 'journey'), "
                      "equals(variables('nodes')[copyIndex()].kind, 'journey-group')), createObject('icon'", properties)
        self.assertIn("'iconName', 'UserFlow'", properties)
        self.assertNotIn("'customData'", properties)
        deployment = self.deployment("root")
        for service in self.selected_services(self.document("root")):
            model = f'{self.name}-{service["service"]}'
            expected = {journey["entityName"] for journey in service["journeys"]} | {
                journey["group"]["entityName"] for journey in service["journeys"] if "group" in journey}
            icons = {name for name in deployment.entity_names(model) if "icon" in deployment.entities[model, name]}
            self.assertEqual(icons, expected)
            self.assertTrue(all(deployment.entities[model, name]["icon"] == {"iconName": "UserFlow"} for name in icons))

    def test_journeys_have_distinct_business_step_entities_and_suppressed_context(self):
        variables = self.service_template["variables"]
        nodes = variables["nodes"]
        self.assertIn("parameters('service').journeys", nodes)
        self.assertIn("lambdaVariables('journey').entityName", nodes)
        self.assertIn("lambdaVariables('journey').steps", nodes)
        self.assertIn("lambdaVariables('step').name", nodes)
        self.assertIn("'kind', 'step'", nodes)
        self.assertIn("'impact', 'Suppressed'", nodes)
        self.assertIn("parameters('service').journeys", variables["relationships"])

    # ---- Service Health, OTEL and queries ----------------------------------------------------------------------

    def test_stable_and_beta_reports_share_one_suppressed_context_entity_per_product(self):
        compiled = json.dumps(self.service_template)
        for function in [
            "getConnectivityMetricsForExchange", "getMessageVolumeMetricsForEmailDelivery",
            "getActiveUserMetricsForOutlookWebByReadEmail", "getActiveUserMetricsForOutlookWebByAppOpening",
            "getActiveUserMetricsForEmailByModernAuthentication", "getUsageMetricsForTeamsByMeetingsJoined",
            "getUsageMetricsForTeamsByLaunch", "getMessageVolumeMetricsForTeamsChat",
            "getAudioStreamQoEMetricsForTeams", "getAudioStreamsOverUdpMetricsForTeams",
        ]:
            self.assertIn(function, compiled)
        self.assertIn("microsoft-activity-", compiled)
        self.assertIn("microsoft-reported-service-status", compiled)
        self.assertNotIn("serviceActivity", self.service_template["parameters"])
        self.assertIn("microsoft-reported-issue-count", compiled)
        provider_signals = self.service_template["variables"]["providerSignalNames"]
        self.assertIn("microsoft-reported-service-status", provider_signals)
        self.assertIn("microsoft-reported-issue-count", provider_signals)
        self.assertIn("variables('providerActivityFunctions')[parameters('service').service]", provider_signals)
        self.assertIn("variables('contextName')", self.service_template["variables"]["relationships"])
        self.assertNotIn("providerCalls", compiled)
        self.assertNotIn("provider-call", compiled)
        self.assertNotIn("providerCallCount", self.template["outputs"]["entityCount"]["value"])
        self.assertNotIn("providerCallCount", self.template["outputs"]["relationshipCount"]["value"])
        functions = resolve_literals(self.service_template["variables"]["providerActivityFunctions"], self.service_template)
        self.assertEqual(functions, self.runtime["activityFunctions"])
        self.assertEqual({service: len(names) for service, names in functions.items()},
                         {"exchange": 5, "teams": 5, "onedrive": 0})
        deployment = self.deployment("rich")
        for service, names in functions.items():
            reports = self.runtime["providerReports"][service]
            self.assertEqual({report["entityName"] for report in reports}, {f"{service}-service-health"})
            self.assertEqual({report["body"]["signalName"] for report in reports}, {
                "microsoft-reported-service-status", "microsoft-reported-issue-count",
                *(f"microsoft-activity-{name}" for name in names),
            })
            self.assertEqual(len(reports), 2 + len(names))
            self.assertEqual(reports[0]["body"]["healthState"], "Healthy")
            self.assertEqual(reports[0]["body"]["value"], 100)
            self.assertTrue(all(report["body"]["healthState"] == "Unknown" and report["body"]["value"] == 0
                                for report in reports[1:]))
            for report in reports[2:]:
                context = json.loads(report["body"]["additionalContext"])
                self.assertEqual(context["unit"], "Percent" if context["source"] in (
                    "getConnectivityMetricsForExchange", "getAudioStreamQoEMetricsForTeams",
                    "getAudioStreamsOverUdpMetricsForTeams",
                ) else "Count")
            model, context = f"{self.name}-{service}", f"{service}-service-health"
            entity = deployment.entities[model, context]
            self.assertEqual((entity["impact"], entity["signalGroups"]), ("Suppressed", {}))
            self.assertEqual(list(deployment.groups(model, context)), ["external-reports"])
            self.assertEqual(set(deployment.groups(model, context)["external-reports"]),
                             {report["body"]["signalName"] for report in reports})

    def test_service_health_entity_and_relationship_require_explicit_root_opt_in(self):
        self.assertFalse(self.service_template["parameters"]["enableServiceHealth"]["defaultValue"])
        gate = self.template["variables"]["enableServiceHealth"]
        self.assertIn("serviceHealth", gate)
        self.assertIn("enabled", gate)
        self.assertIn("false", gate)
        self.assertEqual(self.module["properties"]["parameters"]["enableServiceHealth"]["value"],
                         "[variables('enableServiceHealth')]")
        for variable in ("nodes", "relationships"):
            self.assertIn("parameters('enableServiceHealth')", self.service_template["variables"][variable])
        for output in ("entityCount", "relationshipCount"):
            self.assertIn("variables('serviceHealthCount')", self.template["outputs"][output]["value"])
        plain, supported = self.deployment("root"), self.deployment("rich")
        for service in SERVICES:
            model, context = f"{self.name}-{service}", f"{service}-service-health"
            self.assertNotIn((model, context), plain.entities)
            self.assertIn((model, context), supported.entities)
            self.assertIn((model, model, context), supported.relationships)
        self.assertEqual(supported.outputs["entityCount"] - plain.outputs["entityCount"], len(SERVICES))
        self.assertEqual(supported.outputs["relationshipCount"] - plain.outputs["relationshipCount"], len(SERVICES))

    def test_workspace_dependencies_are_optional_and_only_for_azure_export(self):
        self.assertEqual(set(self.service_template["parameters"]), {
            "modelName", "location", "service", "policy", "enableOtel", "workspaceName", "applicationInsightsResourceId",
            "suppressOneDriveRestore", "enableServiceHealth", "externalReportTenants", "reportingGroups",
        })
        self.assertEqual({resource["type"] for resource in self.service_resources}, {
            "Microsoft.CloudHealth/healthmodels",
            "Microsoft.CloudHealth/healthmodels/entities",
            "Microsoft.CloudHealth/healthmodels/relationships",
            "Microsoft.CloudHealth/healthmodels/authenticationsettings",
            "Microsoft.Authorization/roleAssignments",
        })
        self.assertEqual(self.document("root")["otel"], {"enabled": False, "destination": "console"})
        enabled = self.template["variables"]["useOtel"]
        self.assertIn("azure-monitor", enabled)
        self.assertIn("enabledServices", enabled)
        self.assertIn("otel", enabled)
        for resource in self.resources:
            if resource["type"] in {"Microsoft.OperationalInsights/workspaces", "Microsoft.Insights/components"}:
                self.assertEqual(resource["condition"], "[variables('useOtel')]")
        for resource in self.service_resources:
            if resource["type"] in {"Microsoft.CloudHealth/healthmodels/authenticationsettings", "Microsoft.Authorization/roleAssignments"}:
                self.assertEqual(resource["condition"], "[parameters('enableOtel')]")
        self.assertFalse(self.service_template["parameters"]["enableOtel"]["defaultValue"])
        self.assertEqual(self.module["properties"]["parameters"]["enableOtel"]["value"], "[variables('useOtel')]")
        plain, exporting = self.deployment("root"), self.deployment("rich")
        workspace = {"Microsoft.OperationalInsights/workspaces", "Microsoft.Insights/components"}
        self.assertFalse(workspace & plain.types)
        self.assertLessEqual(workspace, exporting.types)
        self.assertEqual((len(plain.authentications), len(plain.assignments)), (1, 3))
        self.assertEqual((len(exporting.authentications), len(exporting.assignments)), (1 + 3, 3 + 3))

    def test_external_source_group_preserves_rollup_policy(self):
        self.assertEqual(self.functions["sourceGroup"]["output"]["value"], {
            "name": "[parameters('name')]",
            "displayName": "[parameters('displayName')]",
            "aggregationType": "WorstOf",
            "ignoreUnknown": False,
            "members": "[parameters('members')]",
        })
        for groups in self.deployment("two").entities.values():
            for group in groups.get("signalAggregationGroups", []):
                self.assertEqual((group["aggregationType"], group["ignoreUnknown"]), ("WorstOf", False), group["name"])

    def test_call_measurements_share_the_existing_journey_external_reports(self):
        signals = self.service_template["variables"]["teamsCallSignals"]
        reported_signals = {
            report["body"]["signalName"] for report in self.runtime["reports"]["teams"]
            if report["entityName"] == "teams-call" and not report["body"]["signalName"].startswith("synthetic-")
        }
        self.assertEqual(set(signals), reported_signals)
        self.assertEqual(signals, self.runtime["teamsCallSignals"])
        self.assertEqual(len(signals), 4)
        self.assertFalse(any("playback" in signal for signal in signals))
        model = f"{self.name}-teams"
        for variant in ("root", "rich"):
            self.assertEqual(self.deployment(variant).groups(model, "teams-call")["external-reports"],
                             [*SYNTHETIC_SIGNALS, *signals])
        self.assertEqual(self.deployment("root").groups(model, "teams-global")["external-reports"], SYNTHETIC_SIGNALS)
        self.assertEqual(self.deployment("root").groups(model, "teams-call-end-call")["external-reports"], SYNTHETIC_SIGNALS)

    def test_onedrive_preserves_root_and_step_ids_with_stable_only_provider_mapping(self):
        service = next(service for service in self.catalog if service["service"] == "onedrive")
        self.assertEqual({journey["entityName"] for journey in service["journeys"]}, {
            "onedrive-planned-user-drive-roundtrip", "onedrive-planned-app-folder-lifecycle",
            "onedrive-planned-document-versions",
        })
        for journey in service["journeys"]:
            self.assertEqual([step["name"] for step in journey["steps"]], ["step-1", "step-2", "step-3", "step-4"])
        self.assertIn("telemetryName", self.service_template["variables"]["nodes"])
        functions = resolve_literals(self.service_template["variables"]["providerActivityFunctions"], self.service_template)
        self.assertEqual(functions["onedrive"], [])
        self.assertEqual(self.runtime["serviceHealthNames"]["onedrive"], "Microsoft OneDrive")
        self.assertEqual(len(self.runtime["providerReports"]["onedrive"]), 2)
        self.assertIn("restoreVersion", self.module["properties"]["parameters"]["suppressOneDriveRestore"]["value"])
        self.assertIn("suppressOneDriveRestore", self.service_template["variables"]["nodes"])
        self.assertIn("'document-versions'", self.service_template["variables"]["nodes"])

    def test_the_restore_step_is_suppressed_unless_some_tenant_restores_versions(self):
        restore = f"{self.name}-onedrive", "onedrive-planned-document-versions-step-4"
        cases = {"root": "Suppressed", "rich": "Standard", "restore-second-tenant": "Standard"}
        for variant, impact in cases.items():
            with self.subTest(variant=variant):
                self.assertEqual(self.deployment(variant).entities[restore]["impact"], impact)
        deployment = self.deployment("root")
        others = [name for (model, name), properties in deployment.entities.items()
                  if model == restore[0] and name != restore[1] and properties["impact"] == "Suppressed"]
        self.assertEqual(others, [], "only the restore step is ever suppressed")

    def test_external_reports_remain_with_optional_journey_and_step_otel(self):
        entity = next(item for item in self.service_resources if item["type"].endswith("/entities"))
        self.assertEqual(entity["apiVersion"], "2026-10-01-preview")
        groups = entity["properties"]
        self.assertIn("External Reports", groups)
        self.assertIn("OpenTelemetry", groups)
        self.assertIn("azureLogAnalytics", groups)
        self.assertIn("parameters('enableOtel')", groups)
        self.assertIn("__bicep.journeySignals", groups)
        journey_signals = self.functions["journeySignals"]["output"]["value"]
        for signal in SYNTHETIC_SIGNALS:
            self.assertIn(signal, journey_signals)
        self.assertIn("variables('providerSignalNames')", groups)
        self.assertIn("equals(variables('nodes')[copyIndex()].kind, 'root')", groups)
        self.assertIn("equals(variables('nodes')[copyIndex()].kind, 'context')", groups)
        exporting = self.deployment("rich")
        for service in self.selected_services(self.document("rich")):
            model = f'{self.name}-{service["service"]}'
            journeys = {journey["entityName"] for journey in service["journeys"]}
            steps = {f'{journey["entityName"]}-{step["name"]}' for journey in service["journeys"] for step in journey["steps"]}
            for name in exporting.entity_names(model):
                monitored = name in journeys | steps
                properties = exporting.entities[model, name]
                self.assertEqual("azureLogAnalytics" in properties["signalGroups"], monitored, name)
                self.assertEqual("otel" in exporting.groups(model, name), monitored, name)
                if monitored:
                    signals = properties["signalGroups"]["azureLogAnalytics"]["signals"]
                    self.assertEqual([signal["name"] for signal in signals], OTEL_SIGNALS)
                    self.assertEqual(exporting.groups(model, name)["otel"], OTEL_SIGNALS)
        for (model, name), properties in self.deployment("root").entities.items():
            self.assertNotIn("azureLogAnalytics", properties.get("signalGroups", {}), name)
            self.assertNotIn("otel", self.deployment("root").groups(model, name), name)

    def test_queries_bind_service_journey_and_step_without_provider_or_simulated_evidence(self):
        query = self.service_template["variables"]["telemetryQuery"]
        for field in ("probe.schema_version", "probe.mode", "probe.service", "probe.journey", "probe.step", "probe.observed_at"):
            self.assertIn(field, query)
        for required in ("'live'", "'synthetic-step'", "'succeeded', 'failed'", "isnotnull(Value)", "_ResourceId =~"):
            self.assertIn(required, query)
        self.assertNotIn("m365-service-health", query)
        self.assertNotIn("serviceActivity", query)
        self.assertNotIn("probe.id", query)
        metrics = self.service_template["variables"]["telemetryMetrics"]
        self.assertEqual([metric["aggregation"] for metric in metrics], ["avg(100.0 * Success)", "avg(Duration)"])
        self.assertEqual([metric["name"] for metric in metrics], ["otel-success-percentage", "otel-mean-duration"])
        deployment = self.deployment("rich")
        model = f"{self.name}-exchange"
        bound = {
            "exchange-global": ("send-receive-mail", "", "synthetic-result"),
            "exchange-global-send": ("send-receive-mail", "send", "synthetic-step"),
        }
        for entity, (journey, step, message) in bound.items():
            text = deployment.entities[model, entity]["signalGroups"]["azureLogAnalytics"]["signals"][0]["queryText"]
            self.assertIn(f"== '{message}'", text)
            self.assertIn("== 'exchange'", text)
            self.assertIn(f"== '{journey}'", text)
            self.assertIn(f"'{step}' == ''", text)
            self.assertNotRegex(text, r"__[A-Z_]+__")

    # ---- reporting groups and tenants (the new behaviour) -------------------------------------------------------

    def test_reporting_groups_exist_only_on_journey_entities_with_exactly_the_contract_members(self):
        deployment = self.deployment("root")
        model = f"{self.name}-exchange"
        centralus = "group-centralus--tenant-contoso--"
        uksouth = "group-uksouth--tenant-contoso--"
        self.assertEqual(deployment.groups(model, "exchange-global"), {
            "external-reports": SYNTHETIC_SIGNALS,
            "reporting-centralus": [centralus + signal for signal in SYNTHETIC_SIGNALS],
            "reporting-uksouth": [uksouth + signal for signal in SYNTHETIC_SIGNALS],
        })
        calls = self.runtime["teamsCallSignals"]
        self.assertEqual(deployment.groups(f"{self.name}-teams", "teams-call"), {
            "external-reports": [*SYNTHETIC_SIGNALS, *calls],
            "reporting-centralus": [centralus + signal for signal in [*SYNTHETIC_SIGNALS, *calls]],
        })
        self.assertEqual(set(deployment.groups(f"{self.name}-onedrive", "onedrive-planned-user-drive-roundtrip")),
                         {"external-reports", "reporting-centralus", "reporting-uksouth"})
        journeys = {journey["entityName"] for service in self.catalog for journey in service["journeys"]}
        carriers = {entity for (model, entity), properties in deployment.entities.items()
                    if any(group["name"].startswith("reporting-") for group in properties.get("signalAggregationGroups", []))}
        self.assertEqual(carriers, journeys)
        for (model, entity), properties in deployment.entities.items():
            if entity not in journeys:
                self.assertFalse([group for group in properties.get("signalAggregationGroups", [])
                                  if group["name"].startswith("reporting-")], (model, entity))
        for name in ("root", "rich"):
            with self.subTest(variant=name):
                self.assert_signal_groups(name)

    def test_without_groups_the_model_has_no_reporting_groups_and_is_otherwise_identical(self):
        plain, grouped = self.deployment("nogroups"), self.deployment("root")
        self.assertEqual(self.reporting_groups("nogroups"), [])
        for key, properties in plain.entities.items():
            self.assertFalse([group for group in properties.get("signalAggregationGroups", [])
                              if group["name"].startswith("reporting-")], key)
        self.assertEqual(plain.entities, {key: without_reporting_groups(properties)
                                          for key, properties in grouped.entities.items()})
        self.assertEqual(plain.relationships, grouped.relationships)
        self.assertEqual(plain.outputs, grouped.outputs)
        self.assertEqual(plain.types, grouped.types)
        self.assertEqual(plain.groups(f"{self.name}-exchange", "exchange-global"), {"external-reports": SYNTHETIC_SIGNALS})
        self.assert_signal_groups("nogroups")

    def test_one_tenant_keeps_plain_signal_names_and_two_tenants_qualify_them(self):
        self.assertEqual(len(self.document("root")["tenants"]), 1)
        for (model, entity), properties in self.deployment("root").entities.items():
            for group in properties.get("signalAggregationGroups", []):
                if group["name"] == "external-reports":
                    self.assertFalse([member for member in group["members"] if member.startswith("tenant-")], entity)
        deployment = self.deployment("two")
        model = f"{self.name}-exchange"
        both = [f"tenant-{tenant}--{signal}" for tenant in ("contoso", "fabrikam") for signal in SYNTHETIC_SIGNALS]
        contoso = [f"tenant-contoso--{signal}" for signal in SYNTHETIC_SIGNALS]
        fabrikam = [f"tenant-fabrikam--{signal}" for signal in SYNTHETIC_SIGNALS]
        # Only tenants that run a journey publish to it, so only they are declared (no member would stay Unknown).
        self.assertEqual(deployment.groups(model, "exchange-global")["external-reports"], both)
        self.assertEqual(deployment.groups(model, "exchange-global-send")["external-reports"], both)
        self.assertEqual(deployment.groups(model, "exchange-draft")["external-reports"], contoso)
        self.assertEqual(deployment.groups(model, "exchange-recurring")["external-reports"], fabrikam)
        self.assertEqual(deployment.groups(model, "exchange-recurring-create-event")["external-reports"], fabrikam)
        teams = f"{self.name}-teams"
        self.assertEqual(deployment.groups(teams, "teams-global")["external-reports"], contoso)
        calls = [f"tenant-fabrikam--{signal}" for signal in [*SYNTHETIC_SIGNALS, *self.runtime["teamsCallSignals"]]]
        self.assertEqual(deployment.groups(teams, "teams-call")["external-reports"], calls)
        # Service Health context entities list every tenant that hosts the service.
        provider = ["microsoft-reported-service-status", "microsoft-reported-issue-count"]
        functions = self.projection["providerActivityFunctions"]
        for service, tenants in (("exchange", ("contoso", "fabrikam")), ("teams", ("contoso", "fabrikam")), ("onedrive", ("contoso",))):
            names = [*provider, *(f"microsoft-activity-{function}" for function in functions[service])]
            expected = [f"tenant-{tenant}--{name}" for tenant in tenants for name in names]
            self.assertEqual(deployment.groups(f"{self.name}-{service}", f"{service}-service-health")["external-reports"], expected)
        self.assert_signal_groups("two")

    def test_a_group_spanning_two_tenants_lists_both_tenants_signals(self):
        self.assertEqual([group["id"] for group in self.reporting_groups("two")], ["centralus", "uksouth", "priority"])
        deployment = self.deployment("two")
        model = f"{self.name}-exchange"
        both = [f"group-priority--tenant-{tenant}--{signal}" for tenant in ("contoso", "fabrikam") for signal in SYNTHETIC_SIGNALS]
        contoso = [f"group-priority--tenant-contoso--{signal}" for signal in SYNTHETIC_SIGNALS]
        fabrikam = [f"group-priority--tenant-fabrikam--{signal}" for signal in SYNTHETIC_SIGNALS]
        self.assertEqual(deployment.groups(model, "exchange-global")["reporting-priority"], both)
        self.assertEqual(deployment.groups(model, "exchange-draft")["reporting-priority"], contoso)
        self.assertEqual(deployment.groups(model, "exchange-recurring")["reporting-priority"], fabrikam)
        calls = [f"group-priority--tenant-fabrikam--{signal}" for signal in [*SYNTHETIC_SIGNALS, *self.runtime["teamsCallSignals"]]]
        self.assertEqual(deployment.groups(f"{self.name}-teams", "teams-call")["reporting-priority"], calls)
        self.assertEqual(deployment.groups(f"{self.name}-teams", "teams-global")["reporting-priority"],
                         [f"group-priority--tenant-contoso--{signal}" for signal in SYNTHETIC_SIGNALS])
        # Groups confined to one tenant keep the same names, and never double-qualify the overall signals.
        self.assertEqual(deployment.groups(model, "exchange-global")["reporting-centralus"],
                         [f"group-centralus--tenant-contoso--{signal}" for signal in SYNTHETIC_SIGNALS])
        for properties in deployment.entities.values():
            for group in properties.get("signalAggregationGroups", []):
                if group["name"].startswith("reporting-"):
                    self.assertEqual({member.count("--tenant-") for member in group["members"]}, {1}, group["name"])

    def test_every_published_signal_is_declared_and_every_declared_signal_is_published(self):
        """The TypeScript reporter and the model agree on every overall and group signal name.

        Only the `otel` group is outside the comparison: those are the model's own log queries, not reports. Service
        Health reports are included by forcing provider collection on every worker.
        """
        for name in ("root", "rich", "two"):
            with self.subTest(variant=name):
                deployment, published = self.deployment(name), self.published_signals(name)
                declared = {}
                for (model, entity) in deployment.entities:
                    if model != self.name:
                        groups = deployment.groups(model, entity)
                        declared[model, entity] = {member for group, members in groups.items()
                                                   if group == "external-reports" or group.startswith("reporting-")
                                                   for member in members}
                self.assertLessEqual(set(published), set(declared), "reports sent to an entity the model does not have")
                for key in sorted(declared):
                    self.assertEqual(published.get(key, set()), declared[key], key)
                self.assertTrue(any(signal.startswith("group-") for signals in published.values() for signal in signals))


if __name__ == "__main__":
    unittest.main()
