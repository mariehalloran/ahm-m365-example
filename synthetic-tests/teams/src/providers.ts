import { collectProviderSources, type ProviderCollector, type ProviderSourceDefinition } from "../../utils/src/provider-collection.js";
import { serviceActivitySources } from "../../utils/src/service-activity.js";
import { serviceHealthSources } from "../../utils/src/service-health.js";
import { serviceMessageSources } from "../../utils/src/service-messages.js";

export const teamsProviders: ProviderCollector = async context => {
  const sources: ProviderSourceDefinition[] = context.service.serviceHealth ? serviceHealthSources("teams") : [];
  if (context.service.serviceMessages) sources.push(...serviceMessageSources("teams"));
  sources.push(...serviceActivitySources(context.service));
  return collectProviderSources(context, sources);
};
