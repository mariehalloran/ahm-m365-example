import { collectProviderSources, type ProviderCollector, type ProviderSourceDefinition } from "../../utils/src/provider-collection.js";
import { getConnectivityMetricsForExchange, serviceActivityWindow } from "../../utils/src/service-activity.js";
import { serviceHealthSources } from "../../utils/src/service-health.js";

export const exchangeProviders: ProviderCollector = async context => {
  const sources: ProviderSourceDefinition[] = context.service.serviceHealth ? serviceHealthSources("exchange") : [];
  if (context.service.serviceActivity.enabled) sources.push({
    source: "getConnectivityMetricsForExchange", apiVersion: "beta",
    async collect(graph, signal, collectedAt) {
      const window = serviceActivityWindow(context.service.serviceActivity, Date.parse(collectedAt));
      const rows = await getConnectivityMetricsForExchange(graph, window, signal);
      return rows.map(row => ({
        kind: "activity", service: "exchange", collectedAt, function: "getConnectivityMetricsForExchange",
        intervalStart: row.intervalStartDateTime,
        intervalEnd: new Date(Date.parse(row.intervalStartDateTime) + window.aggregationIntervalMinutes * 60_000).toISOString(),
        aggregationIntervalMinutes: window.aggregationIntervalMinutes, percentage: row.percentage,
      }));
    },
  });
  return collectProviderSources(context, sources);
};
