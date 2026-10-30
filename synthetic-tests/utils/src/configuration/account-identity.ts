import { createHash } from "node:crypto";

export type AccountTarget = { mailbox: string } | { userPrincipalName: string };

/** Extracts the raw email address or user principal name from an account target. */
function resolveAccountAddress(target: AccountTarget | string): string {
  if (typeof target === "string") {
    return target;
  }
  if ("mailbox" in target) {
    return target.mailbox;
  }
  return target.userPrincipalName;
}

/** Derives a deterministic target identifier (`account-<sha256>`) from a mailbox address or UPN. */
export function accountTargetId(target: AccountTarget | string): string {
  const normalizedAddress = resolveAccountAddress(target).trim().toLowerCase();
  const digest = createHash("sha256").update(normalizedAddress).digest("hex");
  return `account-${digest}`;
}
