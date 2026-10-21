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

    def selected(self, project):
        return [
            service for service in self.catalog
            if project["services"][service["service"]]["enabled"]
            and project["services"][service["service"]]["scenarios"][service["journey"]]
        ]

    def test_shared_project_defaults_and_catalog(self):
        default = resolve_literals(self.template["parameters"]["projectConfig"]["defaultValue"], self.template)
        self.assertEqual(default, self.project)
        self.assertEqual({service["service"] for service in self.catalog}, set(self.project["services"]))
        for service in self.catalog:
            self.assertIn(service["journey"], self.project["services"][service["service"]]["scenarios"])
        selected = self.selected(self.project)
        steps = sum(len(service["steps"]) for service in selected)
        self.assertEqual((len(selected) + 1, 1 + len(selected) * 4 + steps, len(selected) * 3 + steps), (4, 27, 23))
        self.assertEqual(len(selected) * 3 + steps * 2, 37)

    def test_service_and_scenario_selection_contract(self):
        self.assertEqual(
            self.template["variables"]["enabledServices"],
            "[filter(variables('serviceDefinitions'), lambda('service', and(parameters('projectConfig').services[lambdaVariables('service').service].enabled, parameters('projectConfig').services[lambdaVariables('service').service].scenarios[lambdaVariables('service').journey])))]",
        )
        for service in self.catalog:
            for gate in ("service", "scenario"):
                with self.subTest(service=service["service"], gate=gate):
                    project = copy.deepcopy(self.project)
                    selected = project["services"][service["service"]]
                    if gate == "service":
                        selected["enabled"] = False
                    else:
                        selected["scenarios"][service["journey"]] = False
                    self.assertNotIn(service["service"], [item["service"] for item in self.selected(project)])
                    self.assertEqual(len(self.selected(project)), 2)
        for resource in self.resources:
            if "copy" in resource:
                self.assertEqual(resource["copy"]["count"], "[length(variables('enabledServices'))]")

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

    def test_otel_conditions_exclude_every_query_dependency(self):
        self.assertEqual(self.template["variables"]["useOtel"],
                         "[and(parameters('projectConfig').otel.enabled, not(empty(variables('enabledServices'))))]")
        for resource in self.resources:
            if resource["type"] in ("Microsoft.OperationalInsights/workspaces", "Microsoft.Insights/components"):
                self.assertEqual(resource["condition"], "[variables('useOtel')]")
        self.assertEqual(self.module["properties"]["parameters"]["enableOtel"]["value"], "[variables('useOtel')]")
        for resource in self.service_resources:
            if resource["type"] in ("Microsoft.Authorization/roleAssignments", "Microsoft.CloudHealth/healthmodels/authenticationsettings"):
                self.assertEqual(resource["condition"], "[parameters('enableOtel')]")
        entities = next(item for item in self.service_resources if item["type"].endswith("/entities"))
        self.assertIn("if(parameters('enableOtel')", entities["properties"]["signalGroups"])

    def test_native_references_and_scoped_reader(self):
        reference = next(item for item in self.resources if item.get("copy", {}).get("name") == "serviceReferences")
        source = reference["properties"]["signalGroups"]["azureResource"]
        self.assertIn("Microsoft.CloudHealth/healthmodels", source["azureResourceId"])
        self.assertEqual(source["signals"], [])
        self.assertIn("nested-models", source["authenticationSetting"])
        reader = next(item for item in self.resources if item["type"] == "Microsoft.Authorization/roleAssignments")
        self.assertIn("Microsoft.CloudHealth/healthmodels", reader["scope"])
        self.assertIn("acdd72a7-3385-48ef-bd42-f606fba81ae7", reader["properties"]["roleDefinitionId"])
        self.assertNotIn("condition", reader)

    def test_report_entities_and_suppressed_provider_context(self):
        variables = self.service_template["variables"]
        self.assertIn("'{0}-global'", variables["journeyName"])
        self.assertIn("'{0}-service-health'", variables["contextName"])
        nodes = variables["nodes"]
        self.assertIn("'kind', 'action'", nodes)
        self.assertIn("format('{0}-{1}', parameters('service').service, lambdaVariables('step').name)", nodes)
        self.assertIn("'kind', 'context', 'step', '', 'rollup', false(), 'impact', 'Suppressed'", nodes)
        self.assertIn("parameters('service').steps", variables["relationships"])

    def test_query_signal_factory_preserves_common_fields(self):
        functions = next(item for item in self.service_template["functions"] if item["namespace"] == "__bicep")
        signal = functions["members"]["createQuerySignal"]["output"]["value"]
        self.assertEqual(signal, {
            "name": "[parameters('name')]",
            "displayName": "[parameters('displayName')]",
            "signalKind": "LogAnalyticsQuery",
            "queryText": "[parameters('queryText')]",
            "valueColumnName": "Value",
            "refreshInterval": "PT1M",
            "timeGrain": "[parameters('timeGrain')]",
            "evaluationRules": "[parameters('evaluationRules')]",
        })
        query_groups = self.service_template["variables"]["queryGroups"]
        self.assertIn("__bicep.createQuerySignal(", query_groups)
        self.assertIn("'refreshInterval', 'PT5M'", query_groups)
        self.assertIn("'dataUnit', 'Provider status score'", query_groups)

    def test_query_binding_preserves_step_and_resource_scoping(self):
        functions = next(item for item in self.service_template["functions"] if item["namespace"] == "__bicep")
        binding = functions["members"]["bindQuery"]["output"]["value"]
        self.assertEqual(binding,
                         "[replace(replace(parameters('queryText'), '__STEP__', parameters('stepName')), '__APPLICATION_INSIGHTS_RESOURCE_ID__', parameters('applicationInsightsId'))]")
        for service in self.catalog:
            for name in ("successQuery", "latencyQuery", "stepSuccessQuery", "stepDurationQuery", "serviceHealthQuery"):
                query = service[name]
                self.assertIn("__APPLICATION_INSIGHTS_RESOURCE_ID__", query)
                if name.startswith("step"):
                    self.assertIn("__STEP__", query)


if __name__ == "__main__":
    unittest.main()
