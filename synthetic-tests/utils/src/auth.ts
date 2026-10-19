import { ClientCertificateCredential, ManagedIdentityCredential } from "@azure/identity";
import { z } from "zod";
import { ConfigurationError, type Config } from "./config.js";
import { GraphClient } from "./graph.js";
import { AuthenticatedHttp } from "./http.js";
import type { ServiceConfig } from "./service-config.js";
import { TeamsBotClient } from "./teams.js";

export function createLiveGraphClient(
  env: NodeJS.ProcessEnv = process.env, authentication: ServiceConfig["graphAuthentication"] = "managed-identity",
): GraphClient {
  if (authentication === "managed-identity") {
    const parsed = z.object({ AZURE_CLIENT_ID: z.string().uuid() }).safeParse(env);
    if (!parsed.success) throw new ConfigurationError("Managed identity Graph access requires a valid AZURE_CLIENT_ID");
    const credential = new ManagedIdentityCredential({ clientId: parsed.data.AZURE_CLIENT_ID });
    return new GraphClient(new AuthenticatedHttp(credential, "https://graph.microsoft.com/.default"));
  }
  if (authentication !== "certificate") throw new ConfigurationError("Invalid graphAuthentication mode");
  const parsed = z.object({
    AZURE_TENANT_ID: z.string().uuid(),
    AZURE_CLIENT_ID: z.string().uuid(),
    AZURE_CLIENT_CERTIFICATE_PATH: z.string().trim().min(1),
  }).safeParse(env);
  if (!parsed.success) {
    throw new ConfigurationError(`Local live Graph access requires app-only certificate settings: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  }
  const credential = new ClientCertificateCredential(
    parsed.data.AZURE_TENANT_ID, parsed.data.AZURE_CLIENT_ID, parsed.data.AZURE_CLIENT_CERTIFICATE_PATH,
  );
  return new GraphClient(new AuthenticatedHttp(credential, "https://graph.microsoft.com/.default"));
}

export function createLiveTeamsBot(config: Config, env: NodeJS.ProcessEnv = process.env): TeamsBotClient {
  const parsed = z.object({
    BOT_TENANT_ID: z.string().uuid(),
    BOT_CLIENT_ID: z.string().uuid(),
    BOT_CLIENT_CERTIFICATE_PATH: z.string().trim().min(1),
    AZURE_TENANT_ID: z.string().uuid(),
  }).safeParse(env);
  if (!parsed.success) {
    throw new ConfigurationError(`Live Teams access requires bot certificate settings and a Graph observer tenant: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  }
  const identity = parsed.data;
  const botTenant = identity.BOT_TENANT_ID.toLowerCase();
  if (identity.AZURE_TENANT_ID.toLowerCase() !== botTenant ||
      config.probes.some(probe => probe.type === "teams-channel-message" && probe.tenantId?.toLowerCase() !== botTenant)) {
    throw new ConfigurationError("Teams targets, bot credentials, and Graph observer must use the same approved tenant");
  }
  const credential = new ClientCertificateCredential(
    identity.BOT_TENANT_ID, identity.BOT_CLIENT_ID, identity.BOT_CLIENT_CERTIFICATE_PATH,
  );
  return new TeamsBotClient(
    new AuthenticatedHttp(credential, "https://api.botframework.com/.default"),
    identity.BOT_CLIENT_ID,
  );
}
