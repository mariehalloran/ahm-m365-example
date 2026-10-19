import { collectProviderSources, type ProviderCollector, type ProviderSourceDefinition } from "../../utils/src/provider-collection.js";
import { getMessageVolumeMetricsForTeamsChat, serviceActivityWindow } from "../../utils/src/service-activity.js";
import { serviceHealthSources } from "../../utils/src/service-health.js";

export const teamsProviders: ProviderCollector = async context => {
  const sources: ProviderSourceDefinition[] = context.service.serviceHealth ? serviceHealthSources("teams") : [];
  if (context.service.serviceActivity.enabled) sources.push({
    source: "getMessageVolumeMetricsForTeamsChat", apiVersion: "beta",
    async collect(graph, signal, collectedAt) {
      const window = serviceActivityWindow(context.service.serviceActivity, Date.parse(collectedAt));
      const rows = await getMessageVolumeMetricsForTeamsChat(graph, window, signal);
      return rows.map(row => ({
        kind: "activity", service: "teams", collectedAt, function: "getMessageVolumeMetricsForTeamsChat",
        intervalStart: row.intervalStartDateTime,
        intervalEnd: new Date(Date.parse(row.intervalStartDateTime) + window.aggregationIntervalMinutes * 60_000).toISOString(),
        aggregationIntervalMinutes: window.aggregationIntervalMinutes, value: row.value,
      }));
    },
  });
  return collectProviderSources(context, sources);
};
