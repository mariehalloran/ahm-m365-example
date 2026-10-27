import { ClientAssertionCredential, ClientCertificateCredential, ManagedIdentityCredential, type TokenCredential } from "@azure/identity";
import { z } from "zod";
import { ConfigurationError, type Config } from "./config.js";
import { GraphClient } from "./graph.js";
import { AuthenticatedHttp, IntegrationError } from "./http.js";
import type { ServiceConfig } from "./service-config.js";
import { TeamsBotClient } from "./teams.js";
import { probeServices } from "./contracts.js";

export const teamsCallingScope = "https://graph.microsoft.com/.default";

export function createServiceCredential(
  env: NodeJS.ProcessEnv = process.env, authentication: ServiceConfig["graphAuthentication"] = "managed-identity",
  purpose: "Graph" | "health-report" = "Graph",
): TokenCredential {
  if (authentication === "managed-identity") {
    const parsed = z.object({ AZURE_CLIENT_ID: z.string().uuid() }).safeParse(env);
    if (!parsed.success) throw new ConfigurationError(`Managed identity ${purpose} access requires a valid AZURE_CLIENT_ID`);
    return new ManagedIdentityCredential({ clientId: parsed.data.AZURE_CLIENT_ID });
  }
  if (authentication !== "certificate") {
    throw new ConfigurationError(`Invalid ${purpose === "Graph" ? "graphAuthentication" : "healthReportAuthentication"} mode`);
  }
  const prefix = purpose === "Graph" ? "M365" : "AZURE";
  const fields = {
    tenantId: `${prefix}_TENANT_ID`,
    clientId: `${prefix}_CLIENT_ID`,
    certificatePath: `${prefix}_CLIENT_CERTIFICATE_PATH`,
  };
  const parsed = z.object({
    tenantId: z.string().uuid(),
    clientId: z.string().uuid(),
    certificatePath: z.string().trim().min(1),
  }).safeParse({
    tenantId: env[fields.tenantId], clientId: env[fields.clientId], certificatePath: env[fields.certificatePath],
  });
  if (!parsed.success) {
    throw new ConfigurationError(`Local live ${purpose} access requires app-only certificate settings: ${parsed.error.issues.map(issue => fields[issue.path[0] as keyof typeof fields]).join(", ")}`);
  }
  return new ClientCertificateCredential(
    parsed.data.tenantId, parsed.data.clientId, parsed.data.certificatePath,
  );
}

export function createHealthReportCredential(
  env: NodeJS.ProcessEnv = process.env, authentication: ServiceConfig["healthReportAuthentication"] = "managed-identity",
): TokenCredential {
  return createServiceCredential(env, authentication, "health-report");
}

export function createLiveGraphClient(
  env: NodeJS.ProcessEnv = process.env, authentication: ServiceConfig["graphAuthentication"] = "managed-identity",
): GraphClient {
  return new GraphClient(createServiceCredential(env, authentication));
}

export function createFederatedGraphClient(env: NodeJS.ProcessEnv, clientId: string): GraphClient {
  const parsed = z.object({
    AZURE_TENANT_ID: z.string().uuid(), clientId: z.string().uuid(),
  }).safeParse({ ...env, clientId });
  if (!parsed.success) throw new ConfigurationError("Graph federation requires valid AZURE_TENANT_ID and application client ID");
  const identity = createServiceCredential(env, "managed-identity");
  const credential = new ClientAssertionCredential(parsed.data.AZURE_TENANT_ID, parsed.data.clientId, async () => {
    const assertion = await identity.getToken("api://AzureADTokenExchange/.default");
    if (!assertion) throw new IntegrationError("authentication-failure");
    return assertion.token;
  });
  return new GraphClient(credential);
}

export function createTeamsReadbackGraph(env: NodeJS.ProcessEnv, clientId: string): GraphClient {
  const parsed = z.object({
    AZURE_TENANT_ID: z.string().uuid(), BOT_TENANT_ID: z.string().uuid(), clientId: z.string().uuid(),
  }).safeParse({ ...env, clientId });
  if (!parsed.success || parsed.data.AZURE_TENANT_ID.toLowerCase() !== parsed.data.BOT_TENANT_ID.toLowerCase()) {
    throw new ConfigurationError("Teams readback federation requires a valid application ID and matching Azure/bot tenants");
  }
  return createFederatedGraphClient(env, clientId);
}

export function createLiveTeamsBot(
  config: Config, env: NodeJS.ProcessEnv = process.env,
  authentication: ServiceConfig["graphAuthentication"] = "managed-identity",
): TeamsBotClient {
  if (authentication !== "managed-identity" && authentication !== "certificate") {
    throw new ConfigurationError("Invalid graphAuthentication mode");
  }
  const observerTenantField = authentication === "certificate" || env.M365_TENANT_ID !== undefined
    ? "M365_TENANT_ID" : "AZURE_TENANT_ID";
  const parsed = z.object({
    BOT_TENANT_ID: z.string().uuid(),
    BOT_CLIENT_ID: z.string().uuid(),
    observerTenant: z.string().uuid(),
  }).safeParse({ ...env, observerTenant: env[observerTenantField] });
  if (!parsed.success) {
    throw new ConfigurationError(`Live Teams access requires explicit bot settings and a Graph observer tenant: ${parsed.error.issues.map(issue => issue.path[0] === "observerTenant" ? observerTenantField : issue.path.join(".")).join(", ")}`);
  }
  const identity = parsed.data;
  const botTenant = identity.BOT_TENANT_ID.toLowerCase();
  if (identity.observerTenant.toLowerCase() !== botTenant ||
      config.probes.some(probe => probeServices[probe.type].service === "teams" && probe.tenantId?.toLowerCase() !== botTenant)) {
    throw new ConfigurationError("Teams targets, bot credentials, and Graph observer must use the same approved tenant");
  }
  return new TeamsBotClient(
    new AuthenticatedHttp(botCredential(config, env, identity), "https://api.botframework.com/.default"),
    identity.BOT_CLIENT_ID,
  );
}

function botCredential(
  config: Config, env: NodeJS.ProcessEnv, identity: { BOT_TENANT_ID: string; BOT_CLIENT_ID: string },
): TokenCredential {
  if (config.BOT_AUTHENTICATION !== "managed-identity" ||
      !z.string().uuid().safeParse(env.AZURE_TENANT_ID).success ||
      env.AZURE_TENANT_ID?.toLowerCase() !== identity.BOT_TENANT_ID.toLowerCase()) {
    throw new ConfigurationError("BOT_AUTHENTICATION requires managed-identity and a matching AZURE_TENANT_ID in the same approved bot tenant");
  }
  return new ManagedIdentityCredential({ clientId: identity.BOT_CLIENT_ID });
}

export function createTeamsCallingGraph(config: Config, env: NodeJS.ProcessEnv = process.env, peer = false): GraphClient {
  const parsed = z.object({
    BOT_TENANT_ID: z.string().uuid(), AZURE_TENANT_ID: z.string().uuid(),
    BOT_CLIENT_ID: z.string().uuid(), TEAMS_CALLING_PEER_CLIENT_ID: z.string().uuid(),
  }).safeParse(env);
  if (!parsed.success || config.BOT_AUTHENTICATION !== "managed-identity" ||
      parsed.data.AZURE_TENANT_ID.toLowerCase() !== parsed.data.BOT_TENANT_ID.toLowerCase() ||
      parsed.data.BOT_CLIENT_ID.toLowerCase() === parsed.data.TEAMS_CALLING_PEER_CLIENT_ID.toLowerCase() ||
      config.BOT_CLIENT_ID?.toLowerCase() !== parsed.data.BOT_CLIENT_ID.toLowerCase() ||
      config.TEAMS_CALLING_PEER_CLIENT_ID?.toLowerCase() !== parsed.data.TEAMS_CALLING_PEER_CLIENT_ID.toLowerCase()) {
    throw new ConfigurationError("Meeting calling requires two distinct explicit managed identities and matching AZURE_TENANT_ID/BOT_TENANT_ID");
  }
  if (config.probes.some(probe => probe.type === "teams-call" &&
      (probe.tenantId?.toLowerCase() !== parsed.data.BOT_TENANT_ID.toLowerCase() ||
       probe.peerBotClientId?.toLowerCase() !== parsed.data.TEAMS_CALLING_PEER_CLIENT_ID.toLowerCase()))) {
    throw new ConfigurationError("Teams meeting targets, peer bot and tenants must match their explicit environment allowlist");
  }
  const clientId = peer ? parsed.data.TEAMS_CALLING_PEER_CLIENT_ID : parsed.data.BOT_CLIENT_ID;
  return new GraphClient(new ManagedIdentityCredential({ clientId }));
}
