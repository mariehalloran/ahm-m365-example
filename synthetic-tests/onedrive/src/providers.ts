import { collectProviderSources, type ProviderCollector, type ProviderSourceDefinition } from "../../utils/src/providers/provider-collection.js";
import { serviceHealthSources } from "../../utils/src/providers/service-health.js";
import { serviceMessageSources } from "../../utils/src/providers/service-messages.js";

export const oneDriveProviders: ProviderCollector = async context => {
  const sources: ProviderSourceDefinition[] = context.service.serviceHealth ? serviceHealthSources("onedrive") : [];
  if (context.service.serviceMessages) sources.push(...serviceMessageSources("onedrive"));
  return collectProviderSources(context, sources);
};
