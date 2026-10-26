import { collectProviderSources, type ProviderCollector, type ProviderSourceDefinition } from "../../utils/src/provider-collection.js";
import { serviceActivitySources } from "../../utils/src/service-activity.js";
import { serviceHealthSources } from "../../utils/src/service-health.js";

export const teamsProviders: ProviderCollector = async context => {
  const sources: ProviderSourceDefinition[] = context.service.serviceHealth ? serviceHealthSources("teams") : [];
  sources.push(...serviceActivitySources(context.service));
  return collectProviderSources(context, sources);
};
