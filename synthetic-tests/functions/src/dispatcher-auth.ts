import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

const uuid = z.string().uuid();
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Allows only the configured application-only coordinator identity in the configured Azure tenant. */
function validateDispatcherClaims(payload: JWTPayload, tenantId: string, clientId: string): void {
  if (typeof payload.tid !== "string" || payload.tid.toLowerCase() !== tenantId.toLowerCase() ||
      typeof payload.azp !== "string" || payload.azp.toLowerCase() !== clientId.toLowerCase() ||
      payload.scp !== undefined || payload.idtyp !== undefined && payload.idtyp !== "app") {
    throw new Error("The access token is not the selected coordinator managed identity");
  }
}

/** Verifies Entra's signature, tenant-specific v2 issuer, API audience, lifetime and calling identity. */
export async function verifyDispatcher(authorization: string | null, env: NodeJS.ProcessEnv): Promise<void> {
  const tenant = uuid.parse(env.AZURE_TENANT_ID);
  const api = uuid.parse(env.FUNCTION_API_CLIENT_ID);
  const coordinator = uuid.parse(env.COORDINATOR_CLIENT_ID);
  if (!authorization || authorization.length > 8192 || !/^Bearer [^\s]+$/i.test(authorization)) {
    throw new Error("A managed-identity bearer token is required");
  }
  let selectedKeys = keys.get(tenant);
  if (!selectedKeys) {
    selectedKeys = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`), {
      timeoutDuration: 2000, cacheMaxAge: 3600000, cooldownDuration: 30000,
    });
    keys.set(tenant, selectedKeys);
  }
  const { payload } = await jwtVerify(authorization.slice(7), selectedKeys, {
    algorithms: ["RS256"], issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    audience: api, requiredClaims: ["exp", "iat", "tid", "azp"], clockTolerance: 5,
  });
  validateDispatcherClaims(payload, tenant, coordinator);
}
