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

    def test_explicit_beta_approval_is_mounted_without_hidden_profile_settings(self):
        self.assertFalse(self.template["parameters"]["enableBetaServiceActivity"]["defaultValue"])
        self.assertEqual(self.module["properties"]["parameters"]["enableBetaServiceActivity"]["value"],
                         "[parameters('enableBetaServiceActivity')]")
        environment = self.app["properties"]["template"]["containers"][0]["env"]
        self.assertIn("'ENABLE_BETA_SERVICE_ACTIVITY', 'value', if(parameters('enableBetaServiceActivity'), 'true', 'false')", environment)

    def test_real_worker_image_and_private_identity_pull_without_web_ingress(self):
        properties = self.app["properties"]
        self.assertIn("useTeamsCallback", properties["configuration"]["ingress"])
        self.assertIn("null()", properties["configuration"]["ingress"])
        self.assertIn("'allowInsecure', false", properties["configuration"]["ingress"])
        self.assertEqual(self.app["identity"]["type"], "UserAssigned")
        self.assertEqual(properties["configuration"]["registries"][0]["identity"], "[parameters('identityResourceId')]")
        self.assertEqual(properties["template"]["containers"][0]["image"], "[parameters('workerImage')]")
        self.assertEqual(properties["template"]["scale"], {"minReplicas": 1, "maxReplicas": 1})

    def test_public_callback_is_only_for_selected_live_scheduled_meetings(self):
        calling = self.worker["variables"]["useTeamsCallback"]
        self.assertIn("'teams'", calling)
        self.assertIn("'live'", calling)
        self.assertIn("scheduled-meeting", calling)
        self.assertNotIn("join-leave-call", calling)
        probes = self.app["properties"]["template"]["containers"][0]["probes"]
        self.assertIn("useTeamsCallback", probes)
        self.assertIn("/healthz", probes)

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
        self.assertIn("uniqueString(string(parameters('projectConfig')), string(parameters('serviceConfig')), string(parameters('serviceAccess')))", environment)
        self.assertEqual(self.app["properties"]["template"]["terminationGracePeriodSeconds"], 60)

    def test_cross_tenant_certificates_are_key_vault_references_and_separate_from_azure_identity(self):
        self.assertEqual(self.template["parameters"]["serviceAccess"]["defaultValue"], {})
        self.assertIn("serviceAccess", self.module["properties"]["parameters"])
        self.assertIn("certificate", self.worker["variables"]["useM365Certificate"])
        secrets = self.worker["variables"]["credentialSecrets"]
        for value in ("keyVaultUrl", "identityResourceId", "m365CertificateSecretUri"):
            self.assertIn(value, secrets)
        self.assertIn("'value', parameters('m365CertificatePem')", secrets)
        self.assertIn("container-app", secrets)
        self.assertEqual(self.template["parameters"]["serviceCertificates"]["type"].lower(), "secureobject")
        self.assertEqual(self.worker["parameters"]["m365CertificatePem"]["type"].lower(), "securestring")
        self.assertNotIn("serviceCertificates", self.template["outputs"])
        native_parameter = self.module["properties"]["parameters"]["m365CertificatePem"]
        self.assertIsInstance(native_parameter, str)
        self.assertIn("parameters('serviceCertificates')[", native_parameter)
        files = self.worker["variables"]["credentialFiles"]
        self.assertIn("m365.pem", files)
        self.assertNotIn("bot.pem", files)
        environment = self.app["properties"]["template"]["containers"][0]["env"]
        for name in ("M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_CERTIFICATE_PATH"):
            self.assertIn(name, environment)
        self.assertIn("'AZURE_CLIENT_ID', 'value', parameters('identityClientId')", environment)
        container = self.app["properties"]["template"]["containers"][0]
        self.assertIn("/etc/credentials", container["volumeMounts"])
        self.assertIn("credentialFiles", self.app["properties"]["template"]["volumes"])

    def test_worker_selection_checks_every_configured_journey(self):
        services = self.template["variables"]["services"]
        self.assertIn("'enabled'", services)
        self.assertIn("'scenarios'", services)
        self.assertIn("tryGet", services)
        self.assertIn("items(", services)
        self.assertNotIn("serviceJourneys", self.template["variables"])

    def test_onedrive_uses_existing_shared_environment_registry_and_service_scoped_identity(self):
        self.assertIn("'onedrive'", self.template["variables"]["services"])
        defaults = self.template["parameters"]["serviceConfigs"]["defaultValue"]
        self.assertIn("onedrive", defaults)
        identity = next(item for item in self.resources if item["type"] == "Microsoft.ManagedIdentity/userAssignedIdentities")
        self.assertIn("uami-", identity["name"])
        self.assertIn("variables('modelName')", identity["name"])
        self.assertIn("variables('services')", identity["name"])
        self.assertEqual(self.module["properties"]["parameters"]["environmentId"]["value"],
                         "[resourceId('Microsoft.App/managedEnvironments', format('cae-{0}', variables('modelName')))]")
        self.assertIn("registry", self.module["properties"]["parameters"]["registryServer"]["value"])

    def test_existing_foundation_can_be_reused_without_changing_registry_or_environment_policy(self):
        self.assertFalse(self.template["parameters"]["reuseExistingFoundation"]["defaultValue"])
        for resource in self.resources:
            if resource["type"] in {"Microsoft.ContainerRegistry/registries", "Microsoft.App/managedEnvironments"}:
                self.assertEqual(resource["condition"], "[not(parameters('reuseExistingFoundation'))]")

    def test_default_bot_uses_the_attached_uami_without_user_storage_or_certificate_fallback(self):
        environment = self.app["properties"]["template"]["containers"][0]["env"]
        self.assertIn("useBotIdentity", environment)
        self.assertIn("'BOT_CLIENT_ID', 'value', parameters('identityClientId')", environment)
        self.assertIn("parameters('identityClientId')", environment)
        self.assertIn("'BOT_TENANT_ID', 'value', parameters('tenantId')", environment)
        self.assertIn("parameters('tenantId')", environment)
        self.assertNotIn("useBotCertificate", self.worker["variables"])
        self.assertNotIn("useTeamsUser", self.worker["variables"])
        self.assertNotIn("useTeamsUser", self.template["variables"])
        identities = self.app["identity"]["userAssignedIdentities"]
        self.assertIn("needsTeamsPeer", identities)
        self.assertIn("botPeerManagedIdentityResourceId", identities)
        self.assertIn("TEAMS_CALLING_PEER_CLIENT_ID", environment)
        self.assertIn("botPeerClientId", environment)
        self.assertNotIn("botPeerClientId", self.app["properties"]["configuration"]["registries"][0]["identity"])

    def test_removed_sharepoint_and_delegated_storage_have_no_compiled_deployment_path(self):
        self.assertFalse(any(item["type"].startswith("Microsoft.Storage/") for item in self.resources))
        compiled = json.dumps(self.template)
        for removed in ("sharepoint", "user-delegated", "teamsCache", "teamsPublicClientId", "botCertificateSecretUri"):
            self.assertNotIn(removed, compiled)
        defaults = self.template["parameters"]["serviceConfigs"]["defaultValue"]
        self.assertEqual(set(defaults), {"exchange", "teams", "onedrive"})
        self.assertIn("channel-conversation", self.worker["variables"]["hasTeamsMessages"])
        self.assertIn("scheduled-meeting", self.worker["variables"]["needsTeamsPeer"])
        for removed in ("answered-audio", "recipient-file-sharing", "adaptive-card", "two-bot-conversation"):
            self.assertNotIn(removed, compiled)

    def test_bot_worker_has_no_user_cache_and_provider_auth_stays_separate(self):
        environment = self.app["properties"]["template"]["containers"][0]["env"]
        for name in ("TEAMS_PUBLIC_CLIENT_ID", "TEAMS_CACHE_ACCOUNT_URL", "TEAMS_CACHE_CONTAINER", "TEAMS_CACHE_BLOB"):
            self.assertNotIn(name, environment)
        self.assertIn("needsApplicationGraph", self.worker["variables"]["useM365Certificate"])
        self.assertIn("useProviderContext", self.worker["variables"]["needsApplicationGraph"])
        provider_context = self.worker["variables"]["useProviderContext"]
        for required in ("and(", "or(", "parameters('projectConfig')", "parameters('serviceConfig')", "serviceHealth", "serviceActivity"):
            self.assertIn(required, provider_context)
        self.assertNotIn("accessToken", environment)
        self.assertNotIn("refreshToken", environment)


if __name__ == "__main__":
    unittest.main()
