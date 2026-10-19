"""Read-only verification of service/journey/step queries; never ingests telemetry."""

import argparse
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
SERVICES = {
    "exchange": {
        "journey": "send-receive-mail",
        "duration": "mailflow.delivery.duration",
        "successes": 3,
        "seconds": 1,
        "steps": ["authenticate", "create-draft", "send", "confirm-delivery", "cleanup"],
    },
    "teams": {
        "journey": "publish-channel-message",
        "duration": "teams.message.publication.duration",
        "successes": 1,
        "seconds": 2,
        "steps": ["authenticate", "post-message", "confirm-publication", "cleanup"],
    },
    "sharepoint": {
        "journey": "save-reopen-file",
        "duration": "synthetic.probe.duration",
        "successes": 4,
        "seconds": 4,
        "steps": ["authenticate", "verify-drive", "upload-file", "read-file", "cleanup"],
    },
}
FIXED_TIME = "datetime(2026-10-19T12:30:00Z)"


def definitions(application_id):
    queries = []
    for service, profile in SERVICES.items():
        folder = ROOT / "synthetic-tests" / service / "queries" / "health-model"
        expected = {
            "success-percentage": 100 * profile["successes"] / (profile["successes"] + 2),
            "mean-latency": 2500 * profile["seconds"],
            "missing-observations": 0,
            "unexecutable-attempts": 1,
        }
        for name, value in expected.items():
            text = (folder / f"{name}.kql").read_text()
            queries.append((service, name, "", text.replace("__APPLICATION_INSIGHTS_RESOURCE_ID__", application_id), value))
        for index, step in enumerate(profile["steps"]):
            for name, value in [
                ("step-success", 100 * (index + 1) / (index + 2)),
                ("step-duration", 2500 * profile["seconds"] * (index + 1)),
            ]:
                text = (folder / f"{name}.kql").read_text()
                text = text.replace("__APPLICATION_INSIGHTS_RESOURCE_ID__", application_id).replace("__STEP__", step)
                queries.append((service, name, step, text, value))
    return queries


def execute(query, subscription, workspace_id):
    for attempt in range(3):
        response = subprocess.run(
            ["az", "rest", "--subscription", subscription, "--method", "post", "--url",
             f"https://management.azure.com{workspace_id}/query?api-version=2017-10-01",
             "--body", json.dumps({"query": query, "timespan": "PT1H"}), "--only-show-errors", "-o", "json"],
            check=False, capture_output=True, text=True, timeout=45,
        )
        if response.returncode == 0 or "Too Many Requests" not in response.stderr or attempt == 2:
            break
        print("Workspace fixture query throttled; pausing sixty seconds before retry.", file=sys.stderr, flush=True)
        time.sleep(60)
    time.sleep(1)
    if response.returncode:
        raise RuntimeError(response.stderr.strip())
    data = json.loads(response.stdout)
    if data.get("error"):
        raise RuntimeError(json.dumps(data["error"]))
    table = data["tables"][0]
    columns = [column["name"] for column in table["columns"]]
    return [dict(zip(columns, row)) for row in table["rows"]]


def fixture_source(application_id, scenario):
    rows = []

    def measurement(service, name, total, count, outcome="success", step=None,
                    mode="live", resource=None, journey=None, timestamp="12:29:00"):
        labels = {
            "probe.service": service, "probe.journey": journey or SERVICES[service]["journey"],
            "probe.mode": mode, "probe.outcome": outcome,
        }
        if step:
            labels["probe.step"] = step
        rows.append(
            f"datetime(2026-10-19T{timestamp}Z), {json.dumps(resource or application_id)}, "
            f"{json.dumps(name)}, {total}, {count}, dynamic({json.dumps(labels)})"
        )

    if scenario != "empty":
        for service, profile in SERVICES.items():
            if scenario == "data":
                measurement(service, "synthetic.probe.success", profile["successes"], profile["successes"])
                measurement(service, "synthetic.probe.success", 0, 1, "failure")
                measurement(service, "synthetic.probe.success", 0, 1, "unexecutable")
                measurement(service, profile["duration"], profile["seconds"], 1)
                measurement(service, profile["duration"], 9 * profile["seconds"], 3)
            else:
                count = 2 if scenario == "failed" else 0
                measurement(service, "synthetic.probe.success", 0, count, "failure")
                measurement(service, profile["duration"], 0, 0)
            for index, step in enumerate(profile["steps"]):
                count = 0 if scenario == "zero-count" else 2
                if scenario == "data":
                    measurement(service, "synthetic.step.success", index + 1, index + 1, step=step)
                    measurement(service, "synthetic.step.success", 0, 1, "failure", step)
                    seconds = profile["seconds"] * (index + 1)
                    measurement(service, "synthetic.step.duration", seconds, 1, step=step)
                    measurement(service, "synthetic.step.duration", 9 * seconds, 3, step=step)
                else:
                    measurement(service, "synthetic.step.success", 0, count, "failure", step)
                    measurement(service, "synthetic.step.duration", 0, 0, step=step)
            if scenario == "data":
                for options in [
                    {"mode": "simulation"}, {"resource": application_id + "-other"},
                    {"journey": "other-journey"}, {"timestamp": "12:00:00"}, {"timestamp": "12:31:00"},
                ]:
                    measurement(service, "synthetic.probe.success", 100, 100, **options)
                    measurement(service, "synthetic.step.success", 100, 100, step=profile["steps"][0], **options)
    schema = "datatable(TimeGenerated:datetime, _ResourceId:string, Name:string, Sum:real, ItemCount:long, Properties:dynamic)"
    return schema + " [\n" + ",\n".join(rows) + "\n]"


def verify(args, queries, workspace_id, application_id):
    checks = 0
    for scenario in ["data", "empty", "failed", "zero-count"]:
        source = fixture_source(application_id, scenario)
        for service, name, step, text, expected in queries:
            text = re.sub(r"ago\((\d+m)\)", lambda match: f"({FIXED_TIME} - {match[1]})", text)
            text = text.replace("now()", FIXED_TIME).replace("AppMetrics", source, 1)
            rows = execute(text, args.subscription, workspace_id)
            if scenario != "data":
                if name == "missing-observations":
                    expected = 0 if scenario == "failed" else 1
                elif name == "unexecutable-attempts":
                    expected = 0
                elif scenario == "failed" and name in ["success-percentage", "step-success"]:
                    expected = 0
                else:
                    assert rows == [], (scenario, service, name, step, rows)
                    checks += 1
                    continue
            assert len(rows) == 1 and math.isclose(rows[0]["Value"], expected), (
                scenario, service, name, step, rows, expected,
            )
            checks += 1
    print(f"PASS: {checks} read-only service/journey/step Kusto fixture checks; no telemetry ingested")


def verify_provider_context(args, workspace_id, application_id):
    schema = "datatable(TimeGenerated:datetime, _ResourceId:string, Message:string, Properties:dynamic)"
    checks = 0
    for service in SERVICES:
        query = (ROOT / "synthetic-tests" / service / "queries" / "health-model" / "service-health-status.kql").read_text()
        query = query.replace("__APPLICATION_INSIGHTS_RESOURCE_ID__", application_id)
        query = re.sub(r"ago\((\d+m)\)", lambda match: f"({FIXED_TIME} - {match[1]})", query)
        query = query.replace("now()", FIXED_TIME)

        def record(status, version="v1.0", body="m365-service-health-overview",
                   mode="live", minute=29, resource=application_id, source_service=service,
                   collected_at="2026-10-19T12:29:00Z"):
            properties = {
                "provider.service": source_service, "provider.mode": mode,
                "provider.status": status, "provider.api_version": version,
                "provider.collected_at": collected_at,
            }
            return (f'datetime(2026-10-19T12:{minute:02d}:00Z), {json.dumps(resource)}, '
                    f'{json.dumps(body)}, dynamic({json.dumps(properties)})')

        cases = [
            ("operational", [record("serviceOperational")], 100),
            ("degraded", [record("serviceDegradation")], 50),
            ("interrupted", [record("serviceInterruption")], 0),
            ("recovering", [record("restoringService")], 50),
            ("unknown-status", [record("unknownFutureValue")], None),
            ("empty", [], None),
            ("beta-only", [record("serviceInterruption", version="beta", body="m365-service-activity")], None),
            ("beta-wrong-body", [record("serviceInterruption", version="beta")], None),
            ("issue-is-not-overview", [record("serviceInterruption", body="m365-service-health-issue")], None),
            ("simulation", [record("serviceOperational", mode="simulation")], None),
            ("wrong-resource", [record("serviceOperational", resource=application_id + "-other")], None),
            ("wrong-service", [record("serviceOperational", source_service="unrelated")], None),
            ("stale", [record("serviceOperational", minute=0, collected_at="2026-10-19T12:00:00Z")], None),
            ("future", [record("serviceOperational", minute=31, collected_at="2026-10-19T12:31:00Z")], None),
            ("beta-does-not-replace-stable", [
                record("serviceOperational", minute=28),
                record("serviceInterruption", version="beta", body="m365-service-activity"),
            ], 100),
            ("new-unknown-does-not-fall-back", [
                record("serviceOperational", minute=28),
                record("unknownFutureValue"),
            ], None),
        ]
        for name, rows, expected in cases:
            source = schema + " [\n" + ",\n".join(rows) + "\n]"
            actual = execute(query.replace("AppTraces", source, 1), args.subscription, workspace_id)
            if expected is None:
                assert actual == [], (service, name, actual)
            else:
                assert len(actual) == 1 and actual[0]["Value"] == expected, (service, name, actual)
            checks += 1
    print(f"PASS: {checks} read-only provider-context fixtures; beta/simulation never affect stable context")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--subscription", required=True)
    parser.add_argument("--resource-group", default="rg-m365-demo")
    parser.add_argument("--workspace-name", default="law-m365-experience-poc")
    parser.add_argument("--application-insights-name", default="appi-m365-experience-poc")
    parser.add_argument("--fixtures", action="store_true")
    parser.add_argument("--provider-fixtures", action="store_true")
    args = parser.parse_args()
    group_id = f"/subscriptions/{args.subscription}/resourceGroups/{args.resource_group}"
    workspace_id = f"{group_id}/providers/Microsoft.OperationalInsights/workspaces/{args.workspace_name}"
    application_id = f"{group_id}/providers/Microsoft.Insights/components/{args.application_insights_name}"
    queries = definitions(application_id)
    if args.provider_fixtures:
        verify_provider_context(args, workspace_id, application_id)
    elif args.fixtures:
        verify(args, queries, workspace_id, application_id)
    else:
        for service, name, step, query, _ in queries:
            print(json.dumps({"service": service, "signal": name, "step": step,
                              "rows": execute(query, args.subscription, workspace_id)}))
