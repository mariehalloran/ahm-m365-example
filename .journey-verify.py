import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess

env = dict(os.environ, AZURE_CONFIG_DIR="/Users/mhalloran/.copilot/session-state/725630c1-5201-484a-b87d-c7df67dea53d/files/azure-consto")
base = "https://management.azure.com/subscriptions/17a37fff-b1ef-4af7-9bd2-70898b286aaf/resourceGroups/rg-m365-consto/providers/Microsoft.CloudHealth/healthmodels/"
prefix = "m365-experience-consto"
template = json.loads(Path(".journey-model.json").read_text())
runtime = template["variables"]["serviceDefinitions"]
planned = template["variables"]["plannedServiceDefinitions"]
functions = template["variables"]["providerActivityFunctions"]
for service in planned:
    service["journeys"] = [
        {
            "entityName": f"{values[0]}-planned-{values[1]}",
            "displayName": f"[Planned / unimplemented] {values[2]}",
            "steps": [{"name": f"step-{index + 1}", "displayName": step} for index, step in enumerate(values[3:])],
        }
        for values in (re.findall(r"'([^']*)'", expression) for expression in service["journeys"])
    ]


def get(path):
    url = base + path + "?api-version=2026-01-01-preview"
    values = []
    while url:
        assert url.startswith("https://management.azure.com/")
        result = subprocess.run(["az", "rest", "--method", "get", "--url", url],
                                env=env, text=True, capture_output=True, check=True)
        payload = json.loads(result.stdout)
        values.extend(payload["value"])
        url = payload.get("nextLink")
    return values


def inspect(service):
    name = service["service"]
    model = f"{prefix}-{name}"
    implemented = next((item["journeys"] for item in runtime if item["service"] == name), [])
    expected = {model}
    expected_relationships = set()
    calls = []
    if implemented:
        context = f"{name}-service-health"
        expected.add(context)
        expected_relationships.add((model, context))
        calls = [f"{context}-{call}" for call in ["health-overviews", "issues", *functions[name]]]
        expected.update(calls)
        expected_relationships.update((context, call) for call in calls)
    for journey in implemented + service["journeys"]:
        expected.add(journey["entityName"])
        expected_relationships.add((model, journey["entityName"]))
        for step in journey["steps"]:
            child = journey["entityName"] + "-" + step["name"]
            expected.add(child)
            expected_relationships.add((journey["entityName"], child))
    entities = get(model + "/entities")
    relationships = get(model + "/relationships")
    by_name = {entity["name"]: entity for entity in entities}
    assert set(by_name) == expected, (name, "inventory", expected - set(by_name), set(by_name) - expected)
    actual_relationships = {(item["properties"]["parentEntityName"], item["properties"]["childEntityName"]) for item in relationships}
    assert actual_relationships == expected_relationships, (name, "relationships", expected_relationships - actual_relationships)
    roots = {journey["entityName"] for journey in implemented + service["journeys"]}
    for entity in entities:
        properties = entity["properties"]
        assert (properties.get("icon", {}).get("iconName") == "UserFlow") == (entity["name"] in roots), (name, entity["name"], "icon")
        if "-planned-" in entity["name"]:
            assert properties.get("healthState") == "Unknown", (name, entity["name"], properties.get("healthState"))
            assert properties["displayName"].startswith("[Planned / unimplemented]"), entity["name"]
            assert not properties.get("signalAggregationGroups"), entity["name"]
            assert not properties.get("signalGroups", {}).get("external"), entity["name"]
            assert not properties.get("signalGroups", {}).get("azureLogAnalytics"), entity["name"]
            if entity["name"] in roots:
                assert properties["impact"] == "Suppressed", entity["name"]
    if implemented:
        assert by_name[f"{name}-service-health"]["properties"]["impact"] == "Suppressed"
        for call in calls:
            signals = by_name[call]["properties"].get("signalGroups", {}).get("external", {}).get("signals", [])
            assert len(signals) == 1, (name, call, "provider child has no ingested signal")
            assert signals[0]["status"]["reportedAt"] >= "2026-10-26T14:19:", (name, call, "stale provider report")
    else:
        assert by_name[model]["properties"]["healthState"] == "Unknown"
    return name, {
        "expectedEntityCount": len(expected), "deployedEntityCount": len(entities),
        "expectedRelationshipCount": len(expected_relationships), "deployedRelationshipCount": len(relationships),
        "implementedJourneys": [{"name": journey["entityName"], "displayName": journey["displayName"],
                                 "health": by_name[journey["entityName"]]["properties"].get("healthState")} for journey in implemented],
        "plannedJourneys": [{"name": journey["entityName"], "displayName": journey["displayName"],
                             "health": by_name[journey["entityName"]]["properties"].get("healthState")} for journey in service["journeys"]],
        "providerCalls": {call: by_name[call]["properties"] for call in calls},
        "serviceRoot": by_name[model]["properties"],
        "oldProviderParent": by_name.get(f"{name}-service-health", {}).get("properties"),
    }


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
    evidence = dict(executor.map(inspect, planned))
root_entities = get(prefix + "/entities")
root_relationships = get(prefix + "/relationships")
assert {item["name"] for item in root_entities} == {prefix, *[f"{service['service']}-experience" for service in planned]}
assert len(root_relationships) == 4
for reference in root_entities:
    name = reference["name"]
    properties = reference["properties"]
    if name != prefix:
        service = name.removesuffix("-experience")
        assert properties["signalGroups"]["azureResource"]["azureResourceId"].lower().endswith(f"/{prefix}-{service}")
        assert properties["impact"] == ("Suppressed" if service == "onedrive" else "Standard")
        if service == "onedrive":
            assert properties["healthState"] == "Unknown"
evidence["root"] = {"entities": root_entities, "relationships": root_relationships}
Path(".journey-live-evidence.json").write_text(json.dumps(evidence, indent=2))
print(json.dumps({name: {key: value for key, value in data.items() if key.endswith("Count")} for name, data in evidence.items() if name != "root"}))
print("Verified exact entity/relationship inventory, all 34 UserFlow roots, all planned nodes Unknown/report-free, suppression and native root reference destinations.")
