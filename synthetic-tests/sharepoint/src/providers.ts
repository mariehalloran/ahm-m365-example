import { collectProviderSources, type ProviderCollector, type ProviderSourceDefinition } from "../../utils/src/providers/provider-collection.js";
import { serviceHealthSources } from "../../utils/src/providers/service-health.js";
import { serviceMessageSources } from "../../utils/src/providers/service-messages.js";

/** Collects only approved stable SharePoint supporting context on the independent provider lane. */
export const sharePointProviders: ProviderCollector = async context => {
  const sources: ProviderSourceDefinition[] = context.service.serviceHealth ? serviceHealthSources("sharepoint") : [];
  if (context.service.serviceMessages) sources.push(...serviceMessageSources("sharepoint"));
  return collectProviderSources(context, sources);
};
