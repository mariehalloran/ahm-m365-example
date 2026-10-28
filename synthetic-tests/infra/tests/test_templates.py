"""Contract tests for the worker (Azure Container Apps) Bicep.

* Deployment parameters come from the real TypeScript (`prepareProjectDeployment`, as `npm run deploy` builds them).
* The template is evaluated offline with `az bicep snapshot`, so Container Apps, identities and role assignments are
  checked as they would be deployed.
* Each container's arguments and mounted secret are round-tripped through the real worker start-up code.
"""
import copy
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from collections import Counter, namedtuple
from pathlib import Path

HERE = Path(__file__).resolve().parent
INFRA = HERE.parent
TYPESCRIPT = HERE.parents[1]
ROOT = HERE.parents[2]
ALIAS = json.loads((ROOT / "monitoring.config.json").read_text())["tenants"][0]["id"]
SERVICES = ("exchange", "teams", "onedrive")
SNAPSHOT_PREFIX = "worker-snapshot-"
SUBSCRIPTION = "11111111-1111-4111-8111-111111111111"
FABRIKAM = "22222222-2222-4222-8222-222222222222"
CLIENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
KEY_VAULT = "https://kv-example.vault.azure.net/secrets/graph-certificate"
CERTIFICATE = "-----BEGIN CERTIFICATE-----\nunit-test-only\n-----END CERTIFICATE-----"
ACR_PULL = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
IDENTITIES = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-m365-demo/providers/Microsoft.ManagedIdentity/userAssignedIdentities"
BOTS = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-m365-demo/providers/Microsoft.BotService/botServices"

# A terminated run unwinds like an interrupted one, so it still removes the snapshot folder it is using.
signal.signal(signal.SIGTERM, signal.default_int_handler)

Worker = namedtuple("Worker", "tenant service app identity created")

# The JSON a script receives on stdin, read asynchronously because a synchronous read of a pipe fails with EAGAIN
# when the payload is still being written.
STDIN = """
async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
"""

# Deployment parameters exactly as `npm run deploy` builds them from each raw root configuration.
PREPARE = STDIN + """
import { prepareProjectDeployment } from './utils/src/prepare-deployment.ts';

const image = `registry.example.invalid/workers@sha256:${'a'.repeat(64)}`;
const prepared = {};
for (const [name, raw] of Object.entries(await readInput())) {
  try {
    prepared[name] = { workerParameters: prepareProjectDeployment(raw, image).workerParameters };
  } catch (error) {
    prepared[name] = { error: error instanceof Error ? error.message : String(error) };
  }
}
console.log(JSON.stringify(prepared));
"""

# What each container's command line and mounted secret mean to the real worker start-up code.
STARTUP = STDIN + """
import { parseWorkerArguments } from './utils/src/worker.ts';
import { parseProjectDocument, selectTenant, serviceExecution } from './utils/src/project-config.ts';

const started = [];
for (const { args, mounted, service } of await readInput()) {
  const { config, once, tenant } = parseWorkerArguments(args);
  const document = parseProjectDocument(mounted);
  const project = selectTenant(document, tenant);
  started.push({
    config, once, document, tenant: project.tenant.id, multiTenant: project.multiTenant,
    runs: serviceExecution(project, service).enabled,
  });
}
console.log(JSON.stringify(started));
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
    health = parameters["parameters"]["projectConfig"]["value"]["healthModel"]
    with tempfile.TemporaryDirectory(prefix=SNAPSHOT_PREFIX, dir=HERE) as directory:
        directory = Path(directory)
        (directory / "parameters.json").write_text(json.dumps(parameters))
        file = directory / "deployment.bicepparam"
        file.write_text("\n".join([
            f"using '{os.path.relpath(template, directory)}'",
            "var values = loadJsonContent('./parameters.json').parameters",
            *(f"param {name} = values.{name}.value" for name in parameters["parameters"]),
        ]))
        run(["az", "bicep", "snapshot", "--file", str(file), "--subscription-id", health["subscriptionId"],
             "--resource-group", health["resourceGroup"], "--location", "eastus2", "--only-show-errors"])
        return json.loads(file.with_suffix(".snapshot.json").read_text())


class Deployment:
    """What the worker template predicts for one set of deployment parameters, indexed for the assertions."""

    def __init__(self, result):
        self.outputs = result["outputs"]
        self.resources = result["predictedResources"]
        self.types = Counter(item["type"] for item in self.resources)
        self.apps = {item["name"]: item for item in self.of_type("Microsoft.App/containerApps")}
        self.identities = {item["name"] for item in self.of_type("Microsoft.ManagedIdentity/userAssignedIdentities")}
        self.role = next(iter(self.of_type("Microsoft.Authorization/roleDefinitions")))
        self.grants = set()
        for item in self.of_type("Microsoft.Authorization/roleAssignments"):
            role = item["properties"]["roleDefinitionId"]
            kind = "report-writer" if role.endswith(self.role["name"]) else "acr-pull" if role.endswith(ACR_PULL) else role
            scope = item["id"].split("/providers/Microsoft.Authorization/")[0].rsplit("/", 1)[-1]
            identity = re.search(r"userAssignedIdentities/([^',]+)", item["properties"]["principalId"]).group(1)
            self.grants.add((kind, scope, identity))

    def of_type(self, kind):
        return [item for item in self.resources if item["type"] == kind]

    def container(self, app):
        return self.apps[app]["properties"]["template"]["containers"][0]

    def env(self, app):
        return {entry["name"]: entry.get("value", entry.get("secretRef")) for entry in self.container(app)["env"]}

    def secrets(self, app):
        return {secret["name"]: secret for secret in self.apps[app]["properties"]["configuration"]["secrets"]}


def workers(document):
    """The tenant services that get a Container App: enabled with at least one scenario, in configuration order."""
    found = []
    for tenant in document["tenants"]:
        for service in SERVICES:
            selected = tenant["services"][service]
            if selected["enabled"] and any(selected["scenarios"].values()):
                settings = selected["worker"]
                identity = settings.get("identityName") or settings["identityResourceId"].rsplit("/", 1)[-1]
                found.append(Worker(tenant["id"], service, settings["appName"], identity, "identityName" in settings))
    return found


# Raw root-configuration variants; each is a deep copy of the checked-in file, hosted as a simulation example, with a
# few edits.
def fixture_ids(config):
    """The IDs the checked-in file leaves to `.env` (OneDrive users, the meeting organizer and the peer bot)."""
    for index, target in enumerate(config["tenants"][0]["services"]["onedrive"]["targets"]):
        target.setdefault("userId", f"77777777-7777-4777-8777-00000000000{index}")
    for call in config["tenants"][0]["services"]["teams"]["callTargets"]:
        call.setdefault("organizerUserId", "44444444-4444-4444-8444-444444444444")
        call.setdefault("peerBotClientId", "55555555-5555-4555-8555-555555555555")


def baseline(config):
    """The checked-in tenants and targets hosted as a simulation example that creates its own foundation and identities.

    The file itself targets a real environment: live execution with provider lanes and bot bindings, an existing
    foundation and identities, Service Health and Azure Monitor OTEL. The tests assert on the hosting, so it is pinned
    here whatever the file deploys to; cadences and lanes still come from the file.
    """
    fixture_ids(config)
    health = config["healthModel"]
    health.update(subscriptionId=SUBSCRIPTION, resourceGroup="rg-m365-demo")
    config["serviceHealth"] = {"enabled": False}
    config["otel"] = {"enabled": False}
    config["deployment"].update(enableLiveProbes=False, enableBetaServiceActivity=False, foundation={
        "mode": "create", "environmentName": f"cae-{health['name']}", "registryName": "crm365example"})
    for service, selected in config["tenants"][0]["services"].items():
        execution = selected["execution"]
        selected["execution"] = {"mode": "simulation", **{
            key: execution[key] for key in ("intervalSeconds", "timeoutSeconds", "cohort", "executionLanes") if key in execution}}
        selected["worker"] = {"appName": f"m365-example-{service}", "identityName": f"uami-{health['name']}-{service}"}
        selected.pop("access", None)


def run_only(config, **journeys):
    """Turns on exactly the named scenarios of the given services (first tenant) and off the rest."""
    for service, names in journeys.items():
        scenarios = config["tenants"][0]["services"][service]["scenarios"]
        for journey in scenarios:
            scenarios[journey] = journey in names


def live(config):
    """Live Exchange with a Key Vault certificate; live Teams with a bot, a peer bot and the public callback."""
    config["deployment"].update(enableLiveProbes=True, enableBetaServiceActivity=True)
    tenant = config["tenants"][0]
    exchange, teams = tenant["services"]["exchange"], tenant["services"]["teams"]
    exchange["execution"].update(mode="live", graphAuthentication="certificate")
    exchange["access"] = {"m365TenantId": tenant["tenantId"], "m365ClientId": CLIENT,
                          "m365CertificateSource": "key-vault", "m365CertificateSecretUri": KEY_VAULT}
    exchange["worker"] = {"appName": exchange["worker"]["appName"], "identityResourceId": f"{IDENTITIES}/uami-exchange"}
    for target in exchange["targets"]:
        target["replySeed"] = {"messageId": f'received-{target["id"]}', "correlationId": "33333333-3333-4333-8333-333333333333"}
    for target in teams["targets"]:
        target["channelId"] = f'19:{target["id"]}@thread.tacv2'
    teams["execution"].update(mode="live", teamsCallingCallbackUrl="https://m365-example-teams.approved.invalid/api/calls")
    teams["worker"] = {"appName": teams["worker"]["appName"], "identityResourceId": f"{IDENTITIES}/uami-teams"}
    teams["access"] = {
        "botResourceId": f"{BOTS}/primary-bot", "botPeerResourceId": f"{BOTS}/peer-bot",
        "botPeerClientId": teams["callTargets"][0]["peerBotClientId"],
        "botPeerManagedIdentityResourceId": f"{IDENTITIES}/uami-peer",
    }


def native(config):
    """Live Exchange whose certificate the deploy command hands to Container Apps as a secret."""
    live(config)
    exchange = config["tenants"][0]["services"]["exchange"]
    exchange["access"] = {
        "m365TenantId": exchange["access"]["m365TenantId"], "m365ClientId": CLIENT,
        "m365CertificateSource": "container-app", "m365CertificateEnvironmentVariable": "APPROVED_PEM",
        "m365CertificateRevision": hashlib.sha256(CERTIFICATE.encode()).hexdigest(),
    }


def channel_only(config):
    """Live Teams that only converses in a channel: no meeting, no peer bot, no public callback."""
    live(config)
    teams = config["tenants"][0]["services"]["teams"]
    teams["scenarios"]["scheduled-meeting"] = False
    teams["access"] = {"botResourceId": teams["access"]["botResourceId"]}


def existing_foundation(config):
    shared = "/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/rg-shared/providers"
    config["deployment"]["foundation"] = {
        "mode": "existing",
        "environmentResourceId": f"{shared}/Microsoft.App/managedEnvironments/cae-shared",
        "registryResourceId": f"{shared}/Microsoft.ContainerRegistry/registries/crshared01",
    }


def second_tenant(config):
    """Adds Fabrikam with its own targets and workers.

    Fabrikam has two Exchange pairs, one Teams channel and meeting and two OneDrive drives. Its Exchange worker shares
    the first tenant's Exchange identity and its OneDrive is off; the first tenant's Teams is enabled but has no
    scenario, so neither gets a Container App.
    """
    first = config["tenants"][0]
    config["deployment"]["azureTenantId"] = first["tenantId"]  # required once the config has several tenants
    fabrikam = copy.deepcopy(first)
    fabrikam.update(id="fabrikam", displayName="Fabrikam", tenantId=FABRIKAM)
    exchange, teams, onedrive = (fabrikam["services"][service] for service in SERVICES)
    accounts = ["test-user-3@fabrikam.example.invalid", "test-user-4@fabrikam.example.invalid"]
    exchange["targets"] = exchange["targets"][:2]
    for index, target in enumerate(exchange["targets"]):
        target.update(id=f"fabrikam-pair-{index + 1}", mailbox=accounts[index], recipientMailbox=accounts[1 - index])
        target["distributionList"] = {"address": "list@fabrikam.example.invalid", "expectedRecipients": accounts}
    teams["targets"] = teams["targets"][:1]
    teams["targets"][0].update(id="fabrikam-channel", tenantId=FABRIKAM)
    teams["callTargets"][0].update(id="fabrikam-meeting", tenantId=FABRIKAM)
    onedrive["targets"] = onedrive["targets"][:2]
    for index, target in enumerate(onedrive["targets"]):
        target.update(id=f"fabrikam-drive-{index + 1}", userPrincipalName=accounts[index],
                      userId=f"77777777-7777-4777-8777-00000000000{index}")
    for service, selected in fabrikam["services"].items():
        selected["worker"] = {"appName": f"fabrikam-{service}", "identityName": f"uami-fabrikam-{service}",
                              "cpu": 0.25, "memory": "0.5Gi"}
    exchange["worker"]["identityName"] = first["services"]["exchange"]["worker"]["identityName"]
    onedrive["enabled"] = False
    config["tenants"].append(fabrikam)
    run_only(config, teams=[])


def make_variants(root):
    changes = {
        "root": lambda config: None,
        "live": live,
        "native": native,
        "channel-only": channel_only,
        "two": second_tenant,
        "monitor": lambda config: config.update(otel={"enabled": True, "destination": "azure-monitor"}),
        "edited": lambda config: config["healthModel"].update(reportTtlMinutes=20),
        "existing": existing_foundation,
        "foundation": lambda config: config["deployment"].update(stage="foundation"),
    }
    variants = {}
    for name, change in changes.items():
        variants[name] = copy.deepcopy(root)
        baseline(variants[name])
        change(variants[name])
    return variants


# Secure inputs the deploy command supplies separately, by variant: {tenant alias: {service: certificate}}.
SECURE = {"native": {ALIAS: {"exchange": CERTIFICATE}}}


class WorkerTemplateContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        remove_stale_snapshots()
        cls.template = json.loads(run(["az", "bicep", "build", "--file", str(INFRA / "main.bicep"), "--stdout"]))
        cls.resources = deployed_resources(cls.template)
        cls.module = next(item for item in cls.resources if item.get("copy", {}).get("name") == "workerApps")
        cls.worker = cls.module["properties"]["template"]
        cls.project = json.loads((ROOT / "monitoring.config.json").read_text())
        cls.name = cls.project["healthModel"]["name"]
        cls.prepared = typescript(PREPARE, make_variants(cls.project))
        cls.deployments = {}

    def parameters(self, name):
        prepared = self.prepared[name]
        self.assertNotIn("error", prepared, f"{name}: {prepared.get('error')}")
        return prepared["workerParameters"]["parameters"]

    def document(self, name):
        return self.parameters(name)["projectConfig"]["value"]

    def deployment(self, name):
        if name not in self.deployments:
            parameters = {**self.prepared[name]["workerParameters"], "parameters": {
                **self.parameters(name), **({"serviceCertificates": {"value": SECURE[name]}} if name in SECURE else {}),
            }}
            self.deployments[name] = Deployment(snapshot(INFRA / "main.bicep", parameters))
        return self.deployments[name]

    # ---- parameters, gates and image ---------------------------------------------------------------------------

    def test_deploy_parameters_are_template_parameters_and_certificates_are_supplied_separately(self):
        supplied = set(self.parameters("root"))
        self.assertEqual(supplied, {"projectConfig", "location", "deployWorkers", "workerImage"})
        parameters = self.template["parameters"]
        self.assertLessEqual(supplied, set(parameters))
        self.assertEqual(set(parameters) - supplied, {"serviceCertificates", "applicationInsightsName"})
        self.assertEqual(parameters["serviceCertificates"]["type"].lower(), "secureobject")
        self.assertEqual(parameters["serviceCertificates"]["defaultValue"], {})
        self.assertNotIn("serviceCertificates", self.template["outputs"])
        self.assertFalse(parameters["deployWorkers"]["defaultValue"])
        self.assertEqual(self.module["condition"], "[parameters('deployWorkers')]")
        self.assertEqual(resolve_literals(parameters["projectConfig"]["defaultValue"], self.template), self.project)
        self.assertEqual((self.parameters("root")["deployWorkers"]["value"], self.parameters("foundation")["deployWorkers"]["value"]),
                         (True, False))

    def test_live_gates_use_exact_lowercase_values(self):
        for variant, gates in (("root", ("false", "false")), ("live", ("true", "true"))):
            deployment = self.deployment(variant)
            for app in deployment.apps:
                env = deployment.env(app)
                self.assertEqual((env["ENABLE_LIVE_M365"], env["ENABLE_BETA_SERVICE_ACTIVITY"]), gates, (variant, app))

    def test_real_worker_image_and_private_identity_pull_without_web_ingress(self):
        deployment = self.deployment("root")
        image = self.parameters("root")["workerImage"]["value"]
        for name, app in deployment.apps.items():
            configuration = app["properties"]["configuration"]
            self.assertEqual(app["identity"]["type"], "UserAssigned")
            self.assertIn(configuration["registries"][0]["identity"], app["identity"]["userAssignedIdentities"])
            self.assertIn("loginServer", configuration["registries"][0]["server"])
            self.assertEqual(deployment.container(name)["image"], image)
            self.assertEqual(app["properties"]["template"]["scale"], {"minReplicas": 1, "maxReplicas": 1})
            self.assertEqual(app["properties"]["template"]["terminationGracePeriodSeconds"], 60)
            self.assertEqual(configuration["activeRevisionsMode"], "Single")
            self.assertIsNone(configuration.get("ingress"), name)
            self.assertEqual(deployment.container(name)["resources"], {"cpu": 0.25, "memory": "0.5Gi"})

    def test_public_callback_is_only_for_selected_live_scheduled_meetings(self):
        calling = self.deployment("live")
        teams = "m365-example-teams"
        self.assertEqual(calling.apps[teams]["properties"]["configuration"]["ingress"],
                         {"external": True, "targetPort": 8080, "transport": "http", "allowInsecure": False})
        self.assertEqual([(probe["type"], probe["httpGet"]) for probe in calling.container(teams)["probes"]], [
            ("Readiness", {"path": "/healthz", "port": 8080}), ("Liveness", {"path": "/healthz", "port": 8080}),
        ])
        for variant, app in (("live", "m365-example-exchange"), ("live", "m365-example-onedrive"),
                             ("channel-only", teams), ("root", teams)):
            with self.subTest(variant=variant, app=app):
                deployment = self.deployment(variant)
                self.assertIsNone(deployment.apps[app]["properties"]["configuration"].get("ingress"))
                self.assertEqual(deployment.container(app)["probes"], [])
        needs_peer = self.worker["variables"]["needsTeamsPeer"]
        for required in ("'teams'", "'live'", "scheduled-meeting"):
            self.assertIn(required, needs_peer)
        self.assertNotIn("join-leave-call", needs_peer)

    def test_minimal_report_permission_without_log_forwarding(self):
        deployment = self.deployment("root")
        self.assertEqual(deployment.role["properties"]["permissions"], [{
            "actions": ["Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action"],
            "notActions": [], "dataActions": [], "notDataActions": [],
        }])
        self.assertFalse([kind for kind in deployment.types if kind.startswith("Microsoft.OperationalInsights/")])
        environment = deployment.of_type("Microsoft.App/managedEnvironments")[0]
        self.assertNotIn("appLogsConfiguration", environment["properties"])
        registry = deployment.of_type("Microsoft.ContainerRegistry/registries")[0]
        self.assertFalse(registry["properties"]["adminUserEnabled"])
        self.assertFalse(registry["properties"]["anonymousPullEnabled"])

    def test_worker_adds_telemetry_secret_and_environment_only_for_azure_export(self):
        plain, exporting = self.deployment("root"), self.deployment("monitor")
        for app in plain.apps:
            self.assertEqual(set(plain.secrets(app)), {"monitoring-config"})
            self.assertNotIn("APPLICATIONINSIGHTS_CONNECTION_STRING", plain.env(app))
        for app in exporting.apps:
            self.assertEqual(set(exporting.secrets(app)), {"monitoring-config", "applicationinsights-connection-string"})
            self.assertIn("ConnectionString", exporting.secrets(app)["applicationinsights-connection-string"]["value"])
            self.assertEqual(exporting.env(app)["APPLICATIONINSIGHTS_CONNECTION_STRING"], "applicationinsights-connection-string")
        self.assertEqual(self.worker["parameters"]["applicationInsightsConnectionString"]["type"].lower(), "securestring")
        self.assertIn("azure-monitor", self.worker["variables"]["useAzureMonitor"])
        self.assertIn("otel", self.worker["variables"]["useAzureMonitor"])

    def test_mounted_configuration_changes_roll_the_worker_revision(self):
        revisions = {variant: {self.deployment(variant).env(app)["SYNTHETIC_CONFIG_REVISION"]
                               for app in self.deployment(variant).apps} for variant in ("root", "edited")}
        self.assertEqual([len(values) for values in revisions.values()], [1, 1], "one revision per mounted configuration")
        self.assertNotEqual(revisions["root"], revisions["edited"])

    # ---- credentials and bots ---------------------------------------------------------------------------------

    def test_cross_tenant_certificates_are_key_vault_references_and_separate_from_azure_identity(self):
        live, exchange = self.deployment("live"), "m365-example-exchange"
        identity = next(iter(live.apps[exchange]["identity"]["userAssignedIdentities"]))
        self.assertEqual(live.secrets(exchange)["m365-certificate"],
                         {"name": "m365-certificate", "keyVaultUrl": KEY_VAULT, "identity": identity})
        env = live.env(exchange)
        self.assertEqual((env["M365_TENANT_ID"], env["M365_CLIENT_ID"], env["M365_CLIENT_CERTIFICATE_PATH"]),
                         (self.document("live")["tenants"][0]["tenantId"], CLIENT, "/etc/credentials/m365.pem"))
        self.assertIn("uami-exchange", env["AZURE_CLIENT_ID"], "the Azure identity stays the worker's managed identity")
        template = live.apps[exchange]["properties"]["template"]
        self.assertEqual(template["volumes"][1], {"name": "credentials", "storageType": "Secret",
                                                   "secrets": [{"secretRef": "m365-certificate", "path": "m365.pem"}]})
        self.assertIn({"volumeName": "credentials", "mountPath": "/etc/credentials"}, live.container(exchange)["volumeMounts"])
        for app in ("m365-example-teams", "m365-example-onedrive"):
            self.assertNotIn("m365-certificate", live.secrets(app))
            self.assertNotIn("M365_CLIENT_CERTIFICATE_PATH", live.env(app))
        self.assertNotIn("m365-certificate", self.deployment("root").secrets(exchange))

    def test_native_certificates_come_from_the_secure_parameter_by_tenant_and_service(self):
        native = self.deployment("native").secrets("m365-example-exchange")["m365-certificate"]
        self.assertEqual(set(native), {"name", "value"})
        for required in ("parameters('serviceCertificates')", f"'{ALIAS}'", "'exchange'"):
            self.assertIn(required, native["value"])
        self.assertEqual(self.worker["parameters"]["m365CertificatePem"]["type"].lower(), "securestring")
        native_parameter = self.module["properties"]["parameters"]["m365CertificatePem"]
        for required in ("parameters('serviceCertificates')", ".tenant", ".service", "container-app"):
            self.assertIn(required, native_parameter)
        secrets = self.worker["variables"]["credentialSecrets"]
        for value in ("keyVaultUrl", "identityResourceId", "m365CertificateSecretUri", "container-app"):
            self.assertIn(value, secrets)
        self.assertIn("'value', parameters('m365CertificatePem')", secrets)
        files = self.worker["variables"]["credentialFiles"]
        self.assertIn("m365.pem", files)
        self.assertNotIn("bot.pem", files)

    def test_default_bot_uses_the_attached_uami_without_user_storage_or_certificate_fallback(self):
        live, teams = self.deployment("live"), "m365-example-teams"
        env = live.env(teams)
        self.assertEqual(env["BOT_CLIENT_ID"], env["AZURE_CLIENT_ID"])
        self.assertIn("uami-teams", env["BOT_CLIENT_ID"])
        self.assertEqual(env["BOT_TENANT_ID"], env["AZURE_TENANT_ID"])
        self.assertEqual(env["TEAMS_CALLING_PEER_CLIENT_ID"], self.document("live")["tenants"][0]["services"]["teams"]["callTargets"][0]["peerBotClientId"])
        self.assertEqual([name.rsplit("/", 1)[-1] for name in live.apps[teams]["identity"]["userAssignedIdentities"]],
                         ["uami-teams", "uami-peer"])
        self.assertNotIn("m365-certificate", live.secrets(teams))
        channel = self.deployment("channel-only")
        self.assertIn("BOT_CLIENT_ID", channel.env(teams))
        self.assertNotIn("TEAMS_CALLING_PEER_CLIENT_ID", channel.env(teams))
        self.assertEqual(len(channel.apps[teams]["identity"]["userAssignedIdentities"]), 1)
        for variables in (self.worker["variables"], self.template["variables"]):
            self.assertNotIn("useBotCertificate", variables)
            self.assertNotIn("useTeamsUser", variables)
        self.assertIn("useBotIdentity", json.dumps(self.worker["variables"]))

    def test_bot_worker_has_no_user_cache_and_provider_auth_stays_separate(self):
        for variant in ("root", "live"):
            for app in self.deployment(variant).apps:
                env = self.deployment(variant).env(app)
                for name in ("TEAMS_PUBLIC_CLIENT_ID", "TEAMS_CACHE_ACCOUNT_URL", "TEAMS_CACHE_CONTAINER", "TEAMS_CACHE_BLOB"):
                    self.assertNotIn(name, env)
                self.assertFalse([name for name in env if "TOKEN" in name and name != "AZURE_TENANT_ID"])
        self.assertIn("needsApplicationGraph", self.worker["variables"]["useM365Certificate"])
        self.assertIn("useProviderContext", self.worker["variables"]["needsApplicationGraph"])
        provider_context = self.worker["variables"]["useProviderContext"]
        for required in ("and(", "or(", "parameters('projectConfig')", "variables('execution')", "serviceHealth", "serviceActivity"):
            self.assertIn(required, provider_context)

    def test_removed_sharepoint_and_delegated_storage_have_no_compiled_deployment_path(self):
        self.assertFalse(any(item["type"].startswith("Microsoft.Storage/") for item in self.resources))
        compiled = json.dumps(self.template)
        for removed in ("sharepoint", "user-delegated", "teamsCache", "teamsPublicClientId", "botCertificateSecretUri",
                        "answered-audio", "recipient-file-sharing", "adaptive-card", "two-bot-conversation"):
            self.assertNotIn(removed, compiled)
        self.assertIn("channel-conversation", self.worker["variables"]["hasTeamsMessages"])
        self.assertIn("scheduled-meeting", self.worker["variables"]["needsTeamsPeer"])

    # ---- one worker per tenant and service ---------------------------------------------------------------------

    def test_one_container_app_per_tenant_and_service_with_an_enabled_scenario(self):
        hosts = self.template["functions"][0]["members"]["hostsWorker"]["output"]["value"]
        for required in (".enabled", ".scenarios", "items(", ".value"):
            self.assertIn(required, hosts)
        for variant in ("root", "two"):
            with self.subTest(variant=variant):
                expected = workers(self.document(variant))
                deployment = self.deployment(variant)
                self.assertEqual(list(deployment.apps), [worker.app for worker in expected])
                self.assertEqual(deployment.outputs["appNames"], [worker.app for worker in expected])
                for worker in expected:
                    self.assertEqual(deployment.container(worker.app)["name"], f"{worker.service}-synthetic")
        self.assertEqual(self.document("root")["tenants"][0]["services"]["teams"]["enabled"], True)
        # The first tenant's Teams is enabled without a scenario and Fabrikam's OneDrive is disabled: neither is hosted.
        self.assertEqual(set(self.deployment("two").apps),
                         {"m365-example-exchange", "m365-example-onedrive", "fabrikam-exchange", "fabrikam-teams"})

    def test_container_args_select_the_tenant_and_mount_the_whole_config(self):
        for variant in ("root", "two"):
            with self.subTest(variant=variant):
                document, deployment, starts = self.document(variant), self.deployment(variant), []
                for worker in workers(document):
                    container = deployment.container(worker.app)
                    self.assertEqual(container["command"], ["node"])
                    self.assertEqual(container["args"], [f"dist/{worker.service}/src/worker.js", "--config",
                                                          "/etc/probe/monitoring.config.json", "--tenant", worker.tenant])
                    mounted = json.loads(deployment.secrets(worker.app)["monitoring-config"]["value"])
                    self.assertEqual(mounted, document, "every worker mounts the whole normalized configuration")
                    self.assertEqual(deployment.apps[worker.app]["properties"]["template"]["volumes"][0], {
                        "name": "probe-config", "storageType": "Secret",
                        "secrets": [{"secretRef": "monitoring-config", "path": "monitoring.config.json"}],
                    })
                    self.assertIn({"volumeName": "probe-config", "mountPath": "/etc/probe"}, container["volumeMounts"])
                    starts.append({"args": container["args"][1:], "mounted": mounted, "service": worker.service})
                for worker, started in zip(workers(document), typescript(STARTUP, starts)):
                    self.assertEqual((started["config"], started["once"], started["tenant"], started["runs"]),
                                     ("/etc/probe/monitoring.config.json", False, worker.tenant, True))
                    self.assertEqual(started["multiTenant"], len(document["tenants"]) > 1)
                    self.assertEqual(started["document"], document, "the mounted configuration is already normalized")
        forbidden = json.dumps(self.template)
        for removed in ("--group", "--all-groups", "--project-config", "workerProjectConfig", "getWorkerScopes"):
            self.assertNotIn(removed, forbidden)

    def test_report_writers_may_only_ingest_on_their_own_service_model(self):
        for variant in ("root", "two"):
            with self.subTest(variant=variant):
                document, deployment = self.document(variant), self.deployment(variant)
                registry = document["deployment"]["foundation"]["registryName"]
                self.assertEqual(deployment.grants, {
                    *(("report-writer", f"{self.name}-{worker.service}", worker.identity) for worker in workers(document)),
                    *(("acr-pull", registry, worker.identity) for worker in workers(document)),
                })
                self.assertFalse([grant for grant in deployment.grants if grant[1] == self.name], "no grants on the root model")
        self.assertEqual(self.deployment("root").types["Microsoft.Authorization/roleAssignments"], 6)
        self.assertEqual(self.deployment("two").types["Microsoft.Authorization/roleAssignments"], 6)

    def test_identities_come_from_the_worker_settings_and_shared_ones_are_created_once(self):
        for variant in ("root", "live", "two"):
            with self.subTest(variant=variant):
                expected = [worker.identity for worker in workers(self.document(variant)) if worker.created]
                self.assertEqual(self.deployment(variant).identities, set(expected))
        self.assertEqual(len([worker for worker in workers(self.document("two")) if worker.identity == f"uami-{self.name}-exchange"]), 2)
        self.assertEqual(len(self.deployment("two").outputs["identityIds"]), 3)
        self.assertEqual(self.deployment("live").identities, {f"uami-{self.name}-onedrive"})

    def test_workers_share_one_environment_and_registry_with_service_scoped_identities(self):
        deployment, foundation = self.deployment("root"), self.document("root")["deployment"]["foundation"]
        self.assertEqual((deployment.types["Microsoft.ContainerRegistry/registries"],
                          deployment.types["Microsoft.App/managedEnvironments"]), (1, 1))
        environments = {app["properties"]["environmentId"] for app in deployment.apps.values()}
        self.assertEqual(len(environments), 1)
        self.assertTrue(next(iter(environments)).endswith(f"/managedEnvironments/{foundation['environmentName']}"))
        self.assertEqual(deployment.outputs["registryName"], foundation["registryName"])
        self.assertEqual({next(iter(app["identity"]["userAssignedIdentities"])).rsplit("/", 1)[-1]
                          for app in deployment.apps.values()}, {f"uami-{self.name}-{service}" for service in SERVICES})

    def test_existing_foundation_can_be_reused_without_changing_registry_or_environment_policy(self):
        for resource in self.resources:
            if resource["type"] in {"Microsoft.ContainerRegistry/registries", "Microsoft.App/managedEnvironments"}:
                self.assertEqual(resource["condition"], "[variables('createFoundation')]")
        existing = self.deployment("existing")
        self.assertFalse({"Microsoft.ContainerRegistry/registries", "Microsoft.App/managedEnvironments"} & set(existing.types))
        foundation = self.document("existing")["deployment"]["foundation"]
        self.assertEqual({app["properties"]["environmentId"] for app in existing.apps.values()}, {foundation["environmentResourceId"]})
        self.assertEqual({scope for kind, scope, _ in existing.grants if kind == "acr-pull"}, {"crshared01"})
        self.assertEqual(existing.outputs["registryName"], "crshared01")

    def test_the_foundation_stage_creates_identities_and_grants_but_no_worker(self):
        foundation = self.deployment("foundation")
        self.assertEqual(foundation.apps, {})
        self.assertEqual(len(foundation.identities), 3)
        self.assertEqual(len(foundation.grants), 6)
        self.assertEqual(foundation.types["Microsoft.ContainerRegistry/registries"], 1)
        self.assertEqual(foundation.outputs["appNames"], [worker.app for worker in workers(self.document("foundation"))])

    def test_the_template_no_longer_depends_on_group_scoping(self):
        self.assertFalse((ROOT / "health-model/infra/project-groups.bicep").exists())
        compiled = json.dumps(self.template)
        for removed in ("rootReportAssignments", "reportingScopes", "scopedSignalName", "__bicep.workerName"):
            self.assertNotIn(removed, compiled)


if __name__ == "__main__":
    unittest.main()
