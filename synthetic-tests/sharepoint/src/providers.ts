import { collectProviderSources, type ProviderCollector } from "../../utils/src/provider-collection.js";
import { serviceHealthSources } from "../../utils/src/service-health.js";

export const sharepointProviders: ProviderCollector = async context =>
  collectProviderSources(context, context.service.serviceHealth ? serviceHealthSources("sharepoint") : []);
