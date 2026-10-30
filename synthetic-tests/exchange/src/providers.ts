import {
  collectProviderSources,
  type ProviderCollector,
  type ProviderSourceDefinition,
} from "../../utils/src/providers/provider-collection.js";
import { serviceActivitySources } from "../../utils/src/providers/service-activity.js";
import { serviceHealthSources } from "../../utils/src/providers/service-health.js";
import { serviceMessageSources } from "../../utils/src/providers/service-messages.js";

/**
 * Collects configured Exchange external provider signals, including stable M365 Service Health,
 * service messages, and optional beta serviceActivity metrics.
 */
export const exchangeProviders: ProviderCollector = async (context) => {
  const sources: ProviderSourceDefinition[] = [];
  if (context.service.serviceHealth) {
    sources.push(...serviceHealthSources("exchange"));
  }
  if (context.service.serviceMessages) {
    sources.push(...serviceMessageSources("exchange"));
  }
  sources.push(...serviceActivitySources(context.service));
  return collectProviderSources(context, sources);
};
