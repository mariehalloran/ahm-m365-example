import { collectProviderSources, type ProviderCollector, type ProviderSourceDefinition } from "../../utils/src/providers/provider-collection.js";
import { serviceActivitySources } from "../../utils/src/providers/service-activity.js";
import { serviceHealthSources } from "../../utils/src/providers/service-health.js";
import { serviceMessageSources } from "../../utils/src/providers/service-messages.js";

export const exchangeProviders: ProviderCollector = async context => {
  const sources: ProviderSourceDefinition[] = context.service.serviceHealth ? serviceHealthSources("exchange") : [];
  if (context.service.serviceMessages) sources.push(...serviceMessageSources("exchange"));
  sources.push(...serviceActivitySources(context.service));
  return collectProviderSources(context, sources);
};
