import copy
import json
from pathlib import Path
import re
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]


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


class ModelTemplateContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        build = subprocess.run(
            ["az", "bicep", "build", "--file", str(ROOT / "health-model/infra/main.bicep"), "--stdout"],
            check=True, capture_output=True, text=True,
        )
        cls.template = json.loads(build.stdout)
        cls.project = json.loads((ROOT / "monitoring.config.json").read_text())
        cls.catalog = resolve_literals(cls.template["variables"]["serviceDefinitions"], cls.template)
        cls.resources = deployed_resources(cls.template)
        cls.module = next(item for item in cls.resources if item["type"] == "Microsoft.Resources/deployments")
        cls.service_template = cls.module["properties"]["template"]
        cls.service_resources = deployed_resources(cls.service_template)
        cls.functions = next(item for item in cls.service_template["functions"] if item["namespace"] == "__bicep")["members"]

    def selected(self, project, catalog=None):
        selected = []
        for definition in self.catalog if catalog is None else catalog:
            service = copy.deepcopy(definition)
            config = project["services"][service["service"]]
            service["journeys"] = [
                journey for journey in service["journeys"] if config["scenarios"].get(journey["name"], False)
            ]
            if config["enabled"] and service["journeys"]:
                selected.append(service)
        return selected

    def test_shared_project_defaults_and_catalog(self):
        default = resolve_literals(self.template["parameters"]["projectConfig"]["defaultValue"], self.template)
        self.assertEqual(default, self.project)
        self.assertEqual({service["service"] for service in self.catalog}, set(self.project["services"]))
        selected = self.selected(self.project)
        journeys = [journey for service in selected for journey in service["journeys"]]
        steps = sum(len(journey["steps"]) for journey in journeys)
        self.assertEqual((len(selected) + 1, 1 + len(selected) * 3 + len(journeys) + steps, len(selected) * 2 + len(journeys) + steps), (4, 34, 30))
        self.assertEqual(steps, 18)
        for service in self.catalog:
            for journey in service["journeys"]:
                self.assertIn(journey["name"], self.project["services"][service["service"]]["scenarios"])
                self.assertFalse({"authenticate", "cleanup"} & {step["name"] for step in journey["steps"]})

    def test_service_and_scenario_selection_contract(self):
        self.assertIn("variables('selectedServices')", self.template["variables"]["enabledServices"])
        self.assertIn("scenarios", self.template["variables"]["selectedServices"])
        self.assertIn("lambdaVariables('journey').name", self.template["variables"]["selectedServices"])
        for service in self.catalog:
            for gate in ("service", "scenario"):
                with self.subTest(service=service["service"], gate=gate):
                    project = copy.deepcopy(self.project)
                    config = project["services"][service["service"]]
                    if gate == "service":
                        config["enabled"] = False
                    else:
                        for journey in service["journeys"]:
                            config["scenarios"][journey["name"]] = False
                    self.assertNotIn(service["service"], [item["service"] for item in self.selected(project)])
                    self.assertEqual(len(self.selected(project)), 2)
        for resource in self.resources:
            if "copy" in resource:
                self.assertEqual(resource["copy"]["count"], "[length(variables('enabledServices'))]")

    def test_multiple_journeys_are_selected_independently_in_one_service(self):
        catalog = copy.deepcopy(self.catalog)
        additional = copy.deepcopy(catalog[0]["journeys"][0])
        additional.update(name="future-journey", entityName="exchange-future")
        catalog[0]["journeys"].append(additional)
        project = copy.deepcopy(self.project)
        project["services"]["exchange"]["scenarios"]["future-journey"] = True
        self.assertEqual(len(self.selected(project, catalog)[0]["journeys"]), 3)
        project["services"]["exchange"]["scenarios"]["send-receive-mail"] = False
        self.assertEqual([journey["entityName"] for journey in self.selected(project, catalog)[0]["journeys"]], ["exchange-draft", "exchange-future"])

    def test_all_services_disabled_keeps_evidence_free_root(self):
        project = copy.deepcopy(self.project)
        for service in project["services"].values():
            service["enabled"] = False
        self.assertEqual(self.selected(project), [])
        roots = [item for item in self.resources if item["type"] == "Microsoft.CloudHealth/healthmodels"]
        self.assertEqual(len(roots), 1)
        self.assertNotIn("condition", roots[0])
        root = next(item for item in self.resources if item["type"].endswith("/entities") and "copy" not in item)
        self.assertEqual(root["properties"]["signalGroups"]["dependencies"], {
            "aggregationType": "WorstOf", "ignoreUnknown": False,
        })

    def test_workspace_dependencies_are_optional_and_only_for_azure_export(self):
        self.assertEqual(set(self.service_template["parameters"]), {
            "modelName", "location", "service", "policy", "enableOtel", "workspaceName", "applicationInsightsResourceId",
        })
        self.assertEqual({resource["type"] for resource in self.service_resources}, {
            "Microsoft.CloudHealth/healthmodels",
            "Microsoft.CloudHealth/healthmodels/entities",
            "Microsoft.CloudHealth/healthmodels/relationships",
            "Microsoft.CloudHealth/healthmodels/authenticationsettings",
            "Microsoft.Authorization/roleAssignments",
        })
        self.assertEqual(self.project["otel"], {"enabled": False, "destination": "console"})
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

    def test_native_references_and_scoped_reader(self):
        reference = next(item for item in self.resources if item.get("copy", {}).get("name") == "serviceReferences")
        source = reference["properties"]["signalGroups"]["azureResource"]
        self.assertIn("Microsoft.CloudHealth/healthmodels", source["azureResourceId"])
        self.assertEqual(source["signals"], [])
        self.assertIn("nested-models", source["authenticationSetting"])
        reader = next(item for item in self.resources if item["type"] == "Microsoft.Authorization/roleAssignments")
        self.assertIn("Microsoft.CloudHealth/healthmodels", reader["scope"])
        self.assertNotIn("condition", reader)

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

    def test_external_source_group_preserves_rollup_policy(self):
        self.assertEqual(self.functions["sourceGroup"]["output"]["value"], {
            "name": "[parameters('name')]",
            "displayName": "[parameters('displayName')]",
            "aggregationType": "WorstOf",
            "ignoreUnknown": False,
            "members": "[parameters('members')]",
        })

    def test_catalog_contains_only_journey_and_business_step_metadata(self):
        for service in self.catalog:
            self.assertEqual(set(service), {"service", "displayName", "journeys"})
            for journey in service["journeys"]:
                self.assertEqual(set(journey), {"name", "entityName", "displayName", "steps"})
                self.assertTrue(all(set(step) == {"name", "displayName"} for step in journey["steps"]))

    def test_external_reports_remain_with_optional_journey_and_step_otel(self):
        entity = next(item for item in self.service_resources if item["type"].endswith("/entities"))
        self.assertEqual(entity["apiVersion"], "2026-10-01-preview")
        groups = entity["properties"]
        self.assertIn("External Reports", groups)
        self.assertIn("OpenTelemetry", groups)
        self.assertIn("azureLogAnalytics", groups)
        self.assertIn("parameters('enableOtel')", groups)
        self.assertIn("synthetic-success-percentage", groups)
        self.assertIn("synthetic-mean-duration", groups)
        self.assertIn("microsoft-reported-service-status", groups)
        self.assertIn("equals(variables('nodes')[copyIndex()].kind, 'root')", groups)
        self.assertIn("equals(variables('nodes')[copyIndex()].kind, 'context')", groups)

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


if __name__ == "__main__":
    unittest.main()
