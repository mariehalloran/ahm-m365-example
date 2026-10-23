import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { callingAuthenticationDiagnostic, callingDiscoveryUrl, callingKeysUrl, createTeamsCallingVerifier } from "../../utils/src/teams-calling-auth.js";

const clientId = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const tenantClaim = "http://schemas.microsoft.com/identity/claims/tenantid";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let other: Awaited<ReturnType<typeof generateKeyPair>>;
let publicJwk: object;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  other = await generateKeyPair("RS256");
  publicJwk = { ...await exportJWK(keys.publicKey), kid: "known", alg: "RS256", use: "sig" };
});
function token(overrides: Record<string, unknown> = {}, key = keys.privateKey, kid = "known") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: "https://graph.microsoft.com", aud: clientId, exp: now + 60, nbf: now - 10,
    [tenantClaim]: tenantId, ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid, jku: "https://attacker.invalid/keys" }).sign(key);
}
async function fixture() {
  const fetcher = vi.fn<typeof fetch>(async input => {
    if (String(input) === callingDiscoveryUrl) return Response.json({ jwks_uri: callingKeysUrl });
    if (String(input) === callingKeysUrl) return Response.json({ keys: [publicJwk] });
    throw new Error("Untrusted signing metadata URL");
  });
  return { fetcher, verify: await createTeamsCallingVerifier({ BOT_CLIENT_ID: clientId, BOT_TENANT_ID: tenantId }, fetcher) };
}

describe("canonical Microsoft communications callback JWT verification", () => {
  it.each(["https://graph.microsoft.com", "https://api.botframework.com"])("accepts signed %s tokens for only this bot/tenant", async iss => {
    const { verify, fetcher } = await fixture();
    await expect(verify(await token({ iss }))).resolves.toBeUndefined();
    await expect(verify(await token({ iss }))).resolves.toBeUndefined();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([callingDiscoveryUrl, callingKeysUrl]);
  });
  it.each([
    { iss: "https://login.microsoftonline.com/tenant/v2.0" },
    { aud: `api://${clientId}` }, { aud: [clientId, "another-app"] },
    { aud: tenantId }, { [tenantClaim]: "wrong-tenant" }, { [tenantClaim]: undefined },
    { exp: 0 }, { exp: undefined }, { nbf: Math.floor(Date.now() / 1000) + 3600 },
    { nbf: null },
  ])("rejects invalid identity or lifetime claims without payload disclosure: %j", async claims => {
    const { verify } = await fixture();
    await expect(verify(await token(claims))).rejects.toThrow();
  });
  it.each([
    { [tenantClaim]: undefined, tid: tenantId },
    { [tenantClaim]: tenantId, tid: tenantId },
    { [tenantClaim]: undefined, tid: tenantId, nbf: undefined },
  ])("normalizes equivalent signed tenant claim naming without requiring optional nbf", async claims => {
    const { verify } = await fixture();
    await expect(verify(await token(claims))).resolves.toBeUndefined();
  });
  it.each([
    { [tenantClaim]: tenantId, tid: "33333333-3333-4333-8333-333333333333" },
    { [tenantClaim]: "33333333-3333-4333-8333-333333333333", tid: tenantId },
    { [tenantClaim]: null, tid: tenantId },
    { [tenantClaim]: undefined, tid: [tenantId] },
    { [tenantClaim]: undefined, tid: undefined },
  ])("rejects missing, invalid or conflicting tenant claim aliases", async claims => {
    const { verify } = await fixture();
    await expect(verify(await token(claims))).rejects.toThrow();
  });
  it("rejects nbf after exp even when both fall within the clock tolerance", async () => {
    const { verify } = await fixture();
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(await token({ exp: now + 1, nbf: now + 2 }))).rejects.toThrow();
  });
  it("reports only allowlisted error codes, claim names and reasons from signed-token failures", async () => {
    const { verify } = await fixture();
    const diagnostic = async (claims: Record<string, unknown>) => {
      try { await verify(await token(claims)); throw new Error("Expected rejection"); }
      catch (error) { return callingAuthenticationDiagnostic(error); }
    };
    expect(await diagnostic({ aud: "PRIVATE-AUDIENCE" })).toEqual({
      authErrorCode: "ERR_JWT_CLAIM_VALIDATION_FAILED", authClaim: "aud", authReason: "check_failed",
    });
    expect(await diagnostic({ exp: undefined })).toEqual({
      authErrorCode: "ERR_JWT_CLAIM_VALIDATION_FAILED", authClaim: "exp", authReason: "missing",
    });
    expect(await diagnostic({ [tenantClaim]: undefined, tid: "33333333-3333-4333-8333-333333333333" })).toEqual({
      authErrorCode: "CALLING_CLAIM_INVALID", authClaim: "tid", authReason: "mismatch",
    });
    expect(callingAuthenticationDiagnostic(Object.assign(new Error("PRIVATE error body"), {
      code: "PRIVATE", claim: "PRIVATE", reason: "PRIVATE",
    }))).toEqual({ authErrorCode: "AUTHENTICATION_FAILED" });
  });
  it("verifies signatures before normalizing raw tid", async () => {
    const { verify } = await fixture();
    try {
      await verify(await token({ [tenantClaim]: undefined, tid: tenantId }, other.privateKey));
      throw new Error("Expected signature rejection");
    } catch (error) {
      expect(callingAuthenticationDiagnostic(error)).toEqual({ authErrorCode: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" });
    }
  });
  it("rejects forged signatures and non-RS256 algorithms", async () => {
    const { verify } = await fixture();
    await expect(verify(await token({}, other.privateKey))).rejects.toThrow();
    const hmac = await new SignJWT({ aud: clientId }).setProtectedHeader({ alg: "HS256" }).sign(new Uint8Array(32));
    await expect(verify(hmac)).rejects.toThrow();
    await expect(verify("not-a-jwt")).rejects.toThrow();
  });
  it("never follows JWT-provided key URLs or floods JWKS for unknown keys", async () => {
    const { verify, fetcher } = await fixture();
    const unknown = await token({}, other.privateKey, "unknown");
    for (let attempt = 0; attempt < 10; attempt++) await expect(verify(unknown)).rejects.toThrow();
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([callingDiscoveryUrl, callingKeysUrl]);
  });
  it("rejects discovery pointing outside the fixed trusted calling keys endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ jwks_uri: "https://attacker.invalid/keys" }));
    await expect(createTeamsCallingVerifier({ BOT_CLIENT_ID: clientId, BOT_TENANT_ID: tenantId }, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
