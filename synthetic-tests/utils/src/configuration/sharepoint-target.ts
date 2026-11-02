import { createHash } from "node:crypto";
import { z } from "zod";

export interface SharePointLocation {
  siteUrl: string;
  libraryName: string;
  folderName: string;
  listName: string;
}

/** Accepts an explicit SharePoint team/site URL, never a personal OneDrive or tenant root. */
function isSharePointSiteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    // Validate the supplied path before URL normalization can silently remove dot segments.
    const raw = /^https:\/\/([^/?#]+)(\/[^?#]*)/i.exec(value);
    if (!raw || raw[1]!.toLowerCase() !== url.hostname) return false;
    const segments = raw[2]!.replace(/\/$/, "").split("/").slice(1).map(decodeURIComponent);
    return url.protocol === "https:" && /^[a-z0-9][a-z0-9-]*\.sharepoint\.com$/.test(url.hostname) &&
      !url.hostname.endsWith("-my.sharepoint.com") && !url.port && !url.username && !url.password &&
      !url.search && !url.hash && !/[\\\u0000-\u001f\u007f]/.test(value) &&
      ["sites", "teams"].includes(segments[0] ?? "") && segments.length >= 2 &&
      segments.every(segment => segment.length > 0 && ![".", ".."].includes(segment) &&
        !/[\\/:?#%\u0000-\u001f\u007f]/.test(segment));
  } catch {
    return false;
  }
}

export const sharePointSiteUrlSchema = z.string().trim().url().max(2048).refine(isSharePointSiteUrl, {
  message: "Use the HTTPS /sites/... or /teams/... URL of the approved non-personal SharePoint site",
}).transform(value => new URL(value).href.replace(/\/$/, ""));

/** Derives one stable internal key from user-owned location choices, not discovered resource IDs. */
export function sharePointTargetId(target: SharePointLocation): string {
  const parsed = sharePointSiteUrlSchema.safeParse(target.siteUrl);
  const siteUrl = parsed.success ? parsed.data : target.siteUrl.trim().replace(/\/$/, "");
  const choices = [siteUrl, target.libraryName, target.folderName, target.listName]
    .map(value => value.trim().toLowerCase());
  return `sharepoint-${createHash("sha256").update(JSON.stringify(choices)).digest("hex")}`;
}
