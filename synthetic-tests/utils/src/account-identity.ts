import { createHash } from "node:crypto";

export type AccountTarget = { mailbox: string } | { userPrincipalName: string };

export function accountTargetId(target: AccountTarget | string): string {
  const address = typeof target === "string" ? target
    : "mailbox" in target ? target.mailbox : target.userPrincipalName;
  return `account-${createHash("sha256").update(address.trim().toLowerCase()).digest("hex")}`;
}
