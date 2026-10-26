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
        runtime = subprocess.run(
            ["node", "--import", "tsx", "--input-type=module", "-e", """
import { probeServices, journeyStepEntities, resultSchema, testTypes } from './utils/src/contracts.ts';
import { readProjectService } from './utils/src/project-config.ts';
import { serviceProbes } from './utils/src/service-config.ts';
import { aggregateHealthReports, serviceActivityReports, serviceHealthReport, serviceHealthIssuesReport } from './utils/src/health-reports.ts';
import { activityFunctions } from './utils/src/provider-catalog.ts';
import { serviceHealthNames } from './utils/src/service-health.ts';
import { simulate } from './utils/src/probes.ts';
const reports = {};
const providerReports = {};
const selected = {};
for (const type of ['exchange', 'teams', 'onedrive']) {
  const {project, service} = await readProjectService(type, '../monitoring.config.json');
  const probes = serviceProbes(service, project.services[type].scenarios);
  selected[type] = [...new Set(probes.map(probe => probe.type))];
  const results = await Promise.all(probes.map(async probe => resultSchema.parse(await simulate(probe, {
    config: { SYNTHETIC_SCENARIO: 'healthy', PROBE_TIMEOUT_MS: 120000, POLL_INTERVAL_MS: 2000 },
    telemetry: { emit() {} }, signal: new AbortController().signal,
  }))));
  reports[type] = aggregateHealthReports(type, {cycleId: 'contract', results}, project.healthModel);
  const providerCycle = {cycleId: 'provider-contract', providerDiagnostics: []};
  providerReports[type] = [
    serviceHealthReport(type, providerCycle, project.healthModel.reportTtlMinutes),
    serviceHealthIssuesReport(type, providerCycle, project.healthModel.reportTtlMinutes),
    ...serviceActivityReports({
      ...service, serviceActivity: {...service.serviceActivity, enabled: type !== 'onedrive', functions: undefined},
    }, providerCycle, project.healthModel.reportTtlMinutes),
  ];
}
console.log(JSON.stringify({
  definitions: probeServices, stepEntities: journeyStepEntities, testTypes, reports, selected,
  providerReports, activityFunctions, serviceHealthNames,
}));
"""],
            cwd=ROOT / "synthetic-tests", check=True, capture_output=True, text=True,
        )
        cls.runtime = json.loads(runtime.stdout)

    def selected(self, project, catalog=None):
        selected = []
        for definition in self.catalog if catalog is None else catalog:
            service = copy.deepcopy(definition)
            config = project["services"].get(service["service"], {"enabled": False, "scenarios": {}})
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
        self.assertEqual({service["service"] for service in selected}, {"exchange", "teams", "onedrive"})
        self.assertEqual((len(selected) + 1, 1 + len(selected) * 3 + len(journeys) + steps,
                          len(selected) * 2 + len(journeys) + steps), (4, 68, 64))
        self.assertEqual((len(journeys), steps), (11, 47))
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
                    expected = {item["service"] for item in self.selected(self.project)} - {service["service"]}
                    self.assertEqual({item["service"] for item in self.selected(project)}, expected)
        for resource in self.resources:
            if "copy" in resource:
                self.assertEqual(resource["copy"]["count"], "[length(variables('enabledServices'))]")

    def test_individual_call_playback_replaces_wait_and_preserves_journey_place_end_ids(self):
        teams = next(service for service in self.catalog if service["service"] == "teams")
        self.assertEqual([journey["entityName"] for journey in teams["journeys"]],
                         ["teams-global", "teams-call"])
        channel = next(journey for journey in teams["journeys"] if journey["name"] == "channel-conversation")
        self.assertEqual([step["name"] for step in channel["steps"]],
                         ["post-message", "confirm-publication", "post-reply", "confirm-reply"])
        call = next(journey for journey in teams["journeys"] if journey["name"] == "scheduled-meeting")
        self.assertEqual([step["name"] for step in call["steps"]],
                         ["place-call", "wait-for-answer", "verify-meeting-metadata", "verify-participants",
                          "play-audio", "end-call"])
        self.assertEqual(len(self.project["services"]["teams"]["callTargets"]), 1)
        self.assertEqual(len(self.project["services"]["teams"]["targets"]), 1)
        self.assertEqual((1 + len(call["steps"])) * 2, 14)

    def test_every_retained_journey_is_selected_independently(self):
        for service in self.catalog:
            for journey in service["journeys"]:
                project = copy.deepcopy(self.project)
                project["services"][service["service"]]["scenarios"][journey["name"]] = False
                selected = next(item for item in self.selected(project) if item["service"] == service["service"])
                self.assertEqual([item["entityName"] for item in selected["journeys"]],
                                 [item["entityName"] for item in service["journeys"] if item != journey])

    def test_exchange_six_journeys_and_all_business_steps(self):
        exchange = next(service for service in self.catalog if service["service"] == "exchange")
        self.assertEqual([journey["name"] for journey in exchange["journeys"]], [
            "send-receive-mail", "edit-reopen-draft", "attachment-reply-mail",
            "distribution-list-mail", "recurring-calendar", "meeting-invitation",
        ])
        self.assertTrue(all(self.project["services"]["exchange"]["scenarios"].values()))
        by_name = {journey["name"]: journey for journey in exchange["journeys"]}
        self.assertEqual([step["name"] for step in by_name["edit-reopen-draft"]["steps"]],
                         ["create-draft", "read-initial-draft", "update-draft", "read-draft", "delete-draft"])
        self.assertEqual(by_name["recurring-calendar"]["steps"][-1]["name"], "delete-event")
        self.assertEqual(by_name["meeting-invitation"]["steps"][-1]["name"], "cancel-meeting")

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
        relationships = self.service_template["variables"]["relationships"]
        self.assertIn("variables('contextName')", relationships)
        self.assertNotIn("providerCalls", compiled)
        self.assertNotIn("provider-call", compiled)
        entity = next(item for item in self.service_resources if item["type"].endswith("/entities"))
        properties = entity["properties"]
        self.assertIn("if(equals(variables('nodes')[copyIndex()].kind, 'context'), variables('providerSignalNames')", properties)
        self.assertNotIn("providerCallCount", self.template["outputs"]["entityCount"]["value"])
        self.assertNotIn("providerCallCount", self.template["outputs"]["relationshipCount"]["value"])
        functions = resolve_literals(self.service_template["variables"]["providerActivityFunctions"], self.service_template)
        self.assertEqual(functions, self.runtime["activityFunctions"])
        self.assertEqual({service: len(names) for service, names in functions.items()},
                         {"exchange": 5, "teams": 5, "onedrive": 0})
        for service, names in functions.items():
            reports = self.runtime["providerReports"][service]
            self.assertEqual({report["entityName"] for report in reports}, {f"{service}-service-health"})
            self.assertEqual({report["body"]["signalName"] for report in reports}, {
                "microsoft-reported-service-status", "microsoft-reported-issue-count",
                *(f"microsoft-activity-{name}" for name in names),
            })
            self.assertEqual(len(reports), 2 + len(names))
            self.assertTrue(all(report["body"]["healthState"] == "Unknown" and "value" not in report["body"]
                                for report in reports))
            self.assertTrue(all(json.loads(report["body"]["additionalContext"])["diagnosticCategories"]
                                for report in reports))

    def test_exact_selected_inventory_excludes_all_retired_provider_children(self):
        totals = {"exchange": (33, 32), "teams": (14, 13), "onedrive": (17, 16)}
        for service in self.selected(self.project):
            name = service["service"]
            root = f'{self.project["healthModel"]["name"]}-{name}'
            context = f"{name}-service-health"
            entities = {root, context}
            relationships = {f"{root}-to-{context}"}
            for journey in service["journeys"]:
                entities.add(journey["entityName"])
                relationships.add(f'{root}-to-{journey["entityName"]}')
                for step in journey["steps"]:
                    child = f'{journey["entityName"]}-{step["name"]}'
                    entities.add(child)
                    relationships.add(f'{journey["entityName"]}-to-{child}')
            self.assertEqual((len(entities), len(relationships)), totals[name])
            self.assertFalse(any(entity.startswith(f"{context}-") for entity in entities))
            self.assertFalse(any(relationship.startswith(f"{context}-to-") for relationship in relationships))
        outputs = self.service_template["outputs"]
        self.assertEqual(outputs["entityNames"]["copy"]["count"], "[length(variables('nodes'))]")
        self.assertEqual(outputs["relationshipNames"]["copy"]["count"], "[length(variables('relationships'))]")
        self.assertIn("serviceModelInventories", self.template["outputs"])
        self.assertIn("rootEntityNames", self.template["outputs"])
        self.assertIn("rootRelationshipNames", self.template["outputs"])

    def test_only_journey_roots_have_user_flow_icon(self):
        entity = next(item for item in self.service_resources if item["type"].endswith("/entities"))
        properties = entity["properties"]
        self.assertIn("if(equals(variables('nodes')[copyIndex()].kind, 'journey'), createObject('icon'", properties)
        self.assertIn("'iconName', 'UserFlow'", properties)
        self.assertNotIn("'customData'", properties)

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

    def test_no_removed_service_or_planned_branch_can_reappear_from_the_template(self):
        compiled = json.dumps(self.template)
        for removed in (
            "sharepoint", "includePlannedJourneys", "plannedServiceDefinitions", "plannedJourneyCount",
            "[Planned / unimplemented]", "answered-audio", "recipient-file-sharing", "adaptive-card",
            "recipient-sharing", "search-retrieve", "two-bot-conversation", "browser-upload",
            "external-inbound", "external-outbound", "search-organize-mail", "outlook-web",
        ):
            self.assertNotIn(removed, compiled)
        self.assertFalse((ROOT / "health-model/infra/planned-catalog.bicep").exists())
        self.assertEqual([service["service"] for service in self.catalog], ["exchange", "teams", "onedrive"])
        self.assertNotIn("'planned'", self.service_template["variables"]["nodes"])

    def test_runtime_scenarios_test_types_steps_and_report_entities_match_the_final_catalog_exactly(self):
        expected_types = {
            "exchange": [
                "exchange-mail-flow", "exchange-draft", "exchange-attachment-reply",
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
            self.assertEqual(set(self.project["services"][name]["scenarios"]),
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
                self.assertEqual(len(signals), 8 if entity == "teams-call" else 2)

    def test_workspace_dependencies_are_optional_and_only_for_azure_export(self):
        self.assertEqual(set(self.service_template["parameters"]), {
            "modelName", "location", "service", "policy", "enableOtel", "workspaceName", "applicationInsightsResourceId",
            "suppressOneDriveRestore",
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
        self.assertEqual(self.module["properties"]["parameters"]["enableOtel"]["value"], "[variables('useOtel')]")

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

    def test_call_measurements_share_the_existing_journey_external_reports(self):
        signals = self.service_template["variables"]["teamsCallSignals"]
        self.assertEqual(len(signals), 15)
        self.assertEqual(len(set(signals)), 15)
        self.assertIn("teams-call-mean-connection-duration", signals)
        self.assertIn("teams-call-quality-packet-loss", signals)
        entity = next(item for item in self.service_resources if item["type"].endswith("/entities"))
        self.assertIn("equals(variables('nodes')[copyIndex()].name, 'teams-call')", entity["properties"])
        self.assertIn("variables('teamsCallSignals')", entity["properties"])

    def test_catalog_contains_only_journey_and_business_step_metadata(self):
        for service in self.catalog:
            self.assertEqual(set(service), {"service", "displayName", "journeys"})
            for journey in service["journeys"]:
                self.assertEqual(set(journey), {"name", "entityName", "displayName", "steps"})
                self.assertTrue(all(
                    set(step) in ({"name", "displayName"}, {"name", "displayName", "telemetryName"})
                    for step in journey["steps"]
                ))

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
        self.assertIn("variables('providerSignalNames')", groups)
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
