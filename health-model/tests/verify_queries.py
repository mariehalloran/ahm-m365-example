"""Verify service metric aggregates with read-only Kusto fixtures or live workspace queries."""

import argparse
import json
import math
from pathlib import Path
import subprocess

SUBSCRIPTION = "46433637-4539-481a-b054-e2c9f83ae51d"
RESOURCE_GROUP = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-m365-demo"
APPLICATION_ID = f"{RESOURCE_GROUP}/providers/Microsoft.Insights/components/appi-m365-experience-poc"
WORKSPACE_ID = f"{RESOURCE_GROUP}/providers/Microsoft.OperationalInsights/workspaces/law-m365-experience-poc"
QUERY_DIRECTORY = Path(__file__).resolve().parents[1] / "queries"
SIGNALS = [
    ("exchange success", "success-percentage.kql", "exchange", "5m", "", 80),
    ("exchange mean", "mean-latency.kql", "exchange", "5m", "mailflow.delivery.duration", 8000),
    ("sharepoint success", "success-percentage.kql", "sharepoint", "15m", "", 75),
    ("sharepoint mean", "mean-latency.kql", "sharepoint", "15m", "synthetic.probe.duration", 4500),
    ("missing services", "missing-services.kql", "", "", "", 0),
    ("unexecutable attempts", "unexecutable-attempts.kql", "", "", "", 1),
]


def render(filename, service="", lookback="", metric=""):
    return (QUERY_DIRECTORY / filename).read_text().replace(
        "__APPLICATION_INSIGHTS_RESOURCE_ID__", APPLICATION_ID
    ).replace("__SERVICE__", service).replace("__LOOKBACK__", lookback).replace("__DURATION_METRIC__", metric)


def execute(query):
    result = subprocess.run(
        ["az", "rest", "--subscription", SUBSCRIPTION, "--method", "post", "--url",
         f"https://management.azure.com{WORKSPACE_ID}/query?api-version=2017-10-01",
         "--body", json.dumps({"query": query, "timespan": "PT1H"}), "--only-show-errors", "-o", "json"],
        check=False, capture_output=True, text=True,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    data = json.loads(result.stdout)
    if data.get("error"):
        raise RuntimeError(json.dumps(data["error"]))
    table = data["tables"][0]
    return [dict(zip((column["name"] for column in table["columns"]), row)) for row in table["rows"]]


def fixtures():
    rows = []

    def metric(service, name, total, count, outcome="success", mode="live", resource=APPLICATION_ID, minute=29):
        labels = {"probe.service": service, "probe.mode": mode, "probe.outcome": outcome}
        rows.append(f'datetime(2026-10-19T12:{minute:02d}:00Z), {json.dumps(resource)}, '
                    f'{json.dumps(name)}, {total}, {count}, dynamic({json.dumps(labels)})')

    metric("exchange", "synthetic.probe.runs", 8, 1)
    metric("exchange", "synthetic.probe.runs", 1, 1, outcome="failure")
    metric("exchange", "synthetic.probe.runs", 1, 1, outcome="unexecutable")
    metric("exchange", "mailflow.delivery.duration", 10, 2)
    metric("exchange", "mailflow.delivery.duration", 30, 3)
    metric("sharepoint", "synthetic.probe.runs", 3, 1)
    metric("sharepoint", "synthetic.probe.runs", 1, 1, outcome="failure")
    metric("sharepoint", "synthetic.probe.duration", 3, 1)
    metric("sharepoint", "synthetic.probe.duration", 15, 3)
    for service in ("exchange", "sharepoint"):
        metric(service, "synthetic.probe.runs", 1000, 1, mode="simulation")
        metric(service, "synthetic.probe.runs", 1000, 1, resource=APPLICATION_ID + "-other")
        metric(service, "synthetic.probe.runs", 1000, 1, minute=0)
        metric(service, "synthetic.probe.runs", 1000, 1, minute=31)
    schema = "datatable(TimeGenerated:datetime, _ResourceId:string, Name:string, Sum:real, ItemCount:long, Properties:dynamic)"
    zero_rows = [
        f'datetime(2026-10-19T12:29:00Z), {json.dumps(APPLICATION_ID)}, {json.dumps(name)}, 0, 0, '
        f'dynamic({json.dumps({"probe.service": service, "probe.mode": "live", "probe.outcome": "success"})})'
        for service, name in (
            ("exchange", "synthetic.probe.runs"), ("sharepoint", "synthetic.probe.runs"),
            ("exchange", "mailflow.delivery.duration"), ("sharepoint", "synthetic.probe.duration"),
        )
    ]
    checks = 0
    for scenario in ("data", "empty", "zero-delta"):
        for name, filename, service, window, duration, expected in SIGNALS:
            selected = rows if scenario == "data" else zero_rows if scenario == "zero-delta" else []
            source = schema + " [\n" + ",\n".join(selected) + "\n]"
            query = render(filename, service, window, duration).replace("AppMetrics", source)
            query = query.replace("now()", "datetime(2026-10-19T12:30:00Z)")
            result = execute(query)
            expected = (2 if filename == "missing-services.kql" else 0) if scenario != "data" else expected
            if scenario != "data" and service:
                assert result == [], (name, result)
            else:
                assert len(result) == 1 and math.isclose(result[0]["Value"], expected), (name, result)
                if name == "exchange success" and scenario == "data":
                    assert result[0]["Failed"] == 1 and result[0]["Unexecutable"] == 1, result
            checks += 1
    # Cadence-aware service freshness: seven-minute-old SharePoint runs are still recent;
    # Exchange runs of that age are missing. No target inventory is required.
    stale = schema + ' [datetime(2026-10-19T12:23:00Z), ' + json.dumps(APPLICATION_ID)
    stale += ', "synthetic.probe.runs", 1, 1, dynamic({"probe.service":"sharepoint","probe.mode":"live"})]'
    query = render("missing-services.kql").replace("AppMetrics", stale).replace("now()", "datetime(2026-10-19T12:30:00Z)")
    assert execute(query)[0]["Value"] == 1
    print(f"PASS: {checks + 1} read-only aggregation fixture checks; no telemetry ingested")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", action="store_true")
    if parser.parse_args().fixtures:
        fixtures()
    else:
        for name, filename, service, window, metric, _ in SIGNALS:
            print(json.dumps({"signal": name, "rows": execute(render(filename, service, window, metric))}))
