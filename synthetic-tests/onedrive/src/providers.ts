import { collectProviderSources, type ProviderCollector, type ProviderSourceDefinition } from "../../utils/src/provider-collection.js";
import { serviceHealthSources } from "../../utils/src/service-health.js";
import { serviceMessageSources } from "../../utils/src/service-messages.js";

export const oneDriveProviders: ProviderCollector = async context => {
  const sources: ProviderSourceDefinition[] = context.service.serviceHealth ? serviceHealthSources("onedrive") : [];
  if (context.service.serviceMessages) sources.push(...serviceMessageSources("onedrive"));
  return collectProviderSources(context, sources);
};
