import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import { z } from "zod";
import { ConfigurationError } from "./config.js";

export const callingDiscoveryUrl = "https://api.aps.skype.com/v1/.well-known/OpenIdConfiguration";
export const callingKeysUrl = "https://api.aps.skype.com/v1/keys";
const tenantClaim = "http://schemas.microsoft.com/identity/claims/tenantid";
const issuers = ["https://graph.microsoft.com", "https://api.botframework.com"];
const diagnosticClaims = ["iss", "aud", "exp", "nbf", "iat", "tid", tenantClaim];
const diagnosticReasons = ["missing", "invalid", "check_failed", "mismatch"];
const diagnosticCodes = [
  "ERR_JWT_CLAIM_VALIDATION_FAILED", "ERR_JWT_EXPIRED", "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED", "ERR_JWKS_NO_MATCHING_KEY", "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWKS_TIMEOUT", "ERR_JWK_INVALID", "ERR_JWKS_INVALID", "ERR_JWS_INVALID", "ERR_JWT_INVALID",
  "ERR_JOSE_NOT_SUPPORTED",
];
export interface CallingAuthenticationDiagnostic {
  authErrorCode: string;
  authClaim?: string;
  authReason?: string;
}
export interface CallingIdentity {
  botClientId: string;
}

class CallingClaimError extends Error {
  constructor(readonly claim: "aud" | "nbf" | "tid" | typeof tenantClaim, readonly reason: "missing" | "invalid" | "mismatch") {
    super("Calling notification claim validation failed");
  }
}

export function callingAuthenticationDiagnostic(error: unknown): CallingAuthenticationDiagnostic {
  if (error instanceof CallingClaimError) {
    return { authErrorCode: "CALLING_CLAIM_INVALID", authClaim: error.claim, authReason: error.reason };
  }
  if (!(error instanceof errors.JOSEError)) return { authErrorCode: "AUTHENTICATION_FAILED" };
  const diagnostic: CallingAuthenticationDiagnostic = {
    authErrorCode: diagnosticCodes.includes(error.code) ? error.code : "AUTHENTICATION_FAILED",
  };
  if (error instanceof errors.JWTClaimValidationFailed || error instanceof errors.JWTExpired) {
    if (diagnosticClaims.includes(error.claim)) diagnostic.authClaim = error.claim;
    if (diagnosticReasons.includes(error.reason)) diagnostic.authReason = error.reason;
  }
  return diagnostic;
}

async function boundedFetch(fetcher: typeof fetch, url: string | URL, init?: RequestInit): Promise<Response> {
  const response = await fetcher(url, {
    ...init, redirect: "error",
    signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(2000)]),
  });
  if (response.status !== 200 || !response.body) throw new Error("Calling signing metadata unavailable");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 131072) throw new Error("Calling signing metadata limit");
    chunks.push(Buffer.from(chunk));
  }
  return new Response(Buffer.concat(chunks), { status: 200, headers: { "Content-Type": "application/json" } });
}

export async function createTeamsCallingVerifier(
  env: NodeJS.ProcessEnv, botClientIds: readonly string[], fetcher: typeof fetch = fetch, now: () => number = Date.now,
): Promise<(token: string) => Promise<CallingIdentity>> {
  const parsed = z.object({
    BOT_TENANT_ID: z.string().uuid(),
    audiences: z.array(z.string().uuid()).min(2),
  }).safeParse({ ...env, audiences: botClientIds });
  if (!parsed.success || new Set(parsed.data.audiences.map(id => id.toLowerCase())).size !== botClientIds.length) {
    throw new ConfigurationError("Calling callback requires BOT_TENANT_ID and distinct explicit client IDs for every selected bot pair");
  }
  const audiences = parsed.data.audiences;
  let keys: ReturnType<typeof createRemoteJWKSet> | undefined;
  let refreshAt = 0;
  let refreshing: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;
  async function signingKeys() {
    if (keys && now() < refreshAt) return keys;
    refreshing ??= (async () => {
      const metadata: unknown = await (await boundedFetch(fetcher, callingDiscoveryUrl)).json();
      const discovery = z.object({ jwks_uri: z.literal(callingKeysUrl) }).parse(metadata);
      const selected = createRemoteJWKSet(new URL(discovery.jwks_uri), {
        cacheMaxAge: 600000, cooldownDuration: 30000, timeoutDuration: 2000,
        [customFetch]: (url, init) => boundedFetch(fetcher, url, init),
      });
      await selected.reload();
      keys = selected;
      refreshAt = now() + 3600000;
      return selected;
    })();
    try { return await refreshing; }
    finally { refreshing = undefined; }
  }
  await signingKeys();
  return async token => {
    const { payload } = await jwtVerify(token, await signingKeys(), {
      algorithms: ["RS256"], issuer: issuers, audience: audiences,
      requiredClaims: ["exp"], clockTolerance: 5,
    });
    if (typeof payload.nbf === "number" && typeof payload.exp === "number" && payload.nbf > payload.exp) {
      throw new CallingClaimError("nbf", "invalid");
    }
    if (typeof payload.aud !== "string" || !audiences.includes(payload.aud)) throw new CallingClaimError("aud", "invalid");
    // JwtSecurityTokenHandler maps signed "tid" to the URI claim; jose preserves raw claim names.
    const tenantClaims = ([tenantClaim, "tid"] as const).filter(claim => Object.hasOwn(payload, claim));
    if (!tenantClaims.length) throw new CallingClaimError(tenantClaim, "missing");
    for (const claim of tenantClaims) {
      const value = payload[claim];
      if (typeof value !== "string" || !z.string().uuid().safeParse(value).success) {
        throw new CallingClaimError(claim, "invalid");
      }
      if (value.toLowerCase() !== parsed.data.BOT_TENANT_ID.toLowerCase()) {
        throw new CallingClaimError(claim, "mismatch");
      }
    }
    return { botClientId: payload.aud.toLowerCase() };
  };
}
