import json
from pathlib import Path
import subprocess
import unittest


PROJECT = Path(__file__).resolve().parents[2]


def deployed_resources(template):
    resources = template["resources"]
    declarations = resources.values() if isinstance(resources, dict) else resources
    return [resource for resource in declarations if not resource.get("existing", False)]


class WorkerTemplateContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        build = subprocess.run(
            ["az", "bicep", "build", "--file", str(PROJECT / "infra/main.bicep"), "--stdout"],
            check=True, capture_output=True, text=True,
        )
        cls.template = json.loads(build.stdout)
        cls.resources = deployed_resources(cls.template)
        cls.module = next(item for item in cls.resources if item["type"] == "Microsoft.Resources/deployments")
        cls.worker = cls.module["properties"]["template"]
        cls.app = next(item for item in deployed_resources(cls.worker) if item["type"] == "Microsoft.App/containerApps")

    def test_live_gate_uses_exact_lowercase_values(self):
        environment = self.app["properties"]["template"]["containers"][0]["env"]
        self.assertIn("'ENABLE_LIVE_M365', 'value', if(parameters('enableLiveProbes'), 'true', 'false')", environment)
        self.assertFalse(self.template["parameters"]["enableLiveProbes"]["defaultValue"])
        self.assertFalse(self.template["parameters"]["deployWorkers"]["defaultValue"])
        self.assertEqual(self.module["condition"], "[parameters('deployWorkers')]")

    def test_real_worker_image_and_private_identity_pull_without_web_ingress(self):
        properties = self.app["properties"]
        self.assertNotIn("ingress", properties["configuration"])
        self.assertEqual(self.app["identity"]["type"], "UserAssigned")
        self.assertEqual(properties["configuration"]["registries"][0]["identity"], "[parameters('identityResourceId')]")
        self.assertEqual(properties["template"]["containers"][0]["image"], "[parameters('workerImage')]")
        self.assertEqual(properties["template"]["scale"], {"minReplicas": 1, "maxReplicas": 1})

    def test_minimal_report_permission_without_log_forwarding(self):
        role = next(item for item in self.resources if item["type"] == "Microsoft.Authorization/roleDefinitions")
        self.assertEqual(role["properties"]["permissions"][0]["actions"], [
            "Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action",
        ])
        self.assertFalse(any(item["type"].startswith("Microsoft.OperationalInsights/") for item in self.resources))
        environment = next(item for item in self.resources if item["type"] == "Microsoft.App/managedEnvironments")
        self.assertNotIn("appLogsConfiguration", environment["properties"])
        registry = next(item for item in self.resources if item["type"] == "Microsoft.ContainerRegistry/registries")
        self.assertFalse(registry["properties"]["adminUserEnabled"])
        self.assertFalse(registry["properties"]["anonymousPullEnabled"])

    def test_worker_adds_telemetry_secret_and_environment_only_for_azure_export(self):
        secrets = self.app["properties"]["configuration"]["secrets"]
        self.assertIn("monitoring-config", secrets)
        self.assertIn("service-config", secrets)
        self.assertIn("if(variables('useAzureMonitor')", secrets)
        self.assertIn("applicationinsights-connection-string", secrets)
        environment = self.app["properties"]["template"]["containers"][0]["env"]
        for name in ("SYNTHETIC_CONFIG_REVISION", "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "ENABLE_LIVE_M365"):
            self.assertIn(name, environment)
        self.assertIn("if(variables('useAzureMonitor')", environment)
        self.assertIn("'APPLICATIONINSIGHTS_CONNECTION_STRING', 'secretRef', 'applicationinsights-connection-string'", environment)
        self.assertEqual(self.worker["parameters"]["applicationInsightsConnectionString"]["type"].lower(), "securestring")
        self.assertIn("azure-monitor", self.worker["variables"]["useAzureMonitor"])
        self.assertIn("otel", self.worker["variables"]["useAzureMonitor"])

    def test_mounted_configuration_changes_roll_the_worker_revision(self):
        environment = self.app["properties"]["template"]["containers"][0]["env"]
        self.assertIn("uniqueString(string(parameters('projectConfig')), string(parameters('serviceConfig')))", environment)
        self.assertEqual(self.app["properties"]["template"]["terminationGracePeriodSeconds"], 60)

    def test_worker_selection_checks_every_configured_journey(self):
        services = self.template["variables"]["services"]
        self.assertIn(".enabled", services)
        self.assertIn(".scenarios", services)
        self.assertIn("items(", services)
        self.assertNotIn("serviceJourneys", self.template["variables"])


if __name__ == "__main__":
    unittest.main()
