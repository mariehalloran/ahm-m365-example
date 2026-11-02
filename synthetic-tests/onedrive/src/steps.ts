import { z } from "zod";
import type { OneDriveProbe } from "../../utils/src/configuration/resolved-probes.js";
import type { GraphFileOperations } from "../../utils/src/integrations/graph.js";
import { IntegrationError } from "../../utils/src/integrations/http.js";
import {
  createAttemptFolder, digest, type FileAttempt as DriveFileAttempt, type OwnedFolderAttempt,
} from "../../utils/src/integrations/drive-files.js";
export {
  createOwnedFolder, deleteOwnedFolder, downloadFile, findPriorVersion, listVersions,
  reopenOwnedFile, verifyBytes, writeFile,
} from "../../utils/src/integrations/drive-files.js";

export interface Payload {
  schemaVersion: "1.0";
  owner: "ahm-onedrive";
  targetId: string;
  userId: string;
  correlationId: string;
  revision: 1 | 2;
  text: string;
  sha256: string;
}

export interface FileAttempt extends DriveFileAttempt {
  probe: OneDriveProbe;
}

const encoded = encodeURIComponent;

/** Correlates the OneDrive payload to its configured account and this attempt. */
export function payload(attempt: FileAttempt, revision: 1 | 2): Payload {
  const text = `OneDrive synthetic ${attempt.correlationId} revision ${revision}`;
  return {
    schemaVersion: "1.0", owner: "ahm-onedrive", targetId: attempt.probe.id,
    userId: attempt.probe.userId, correlationId: attempt.correlationId, revision, text, sha256: digest(text),
  };
}

/** Resolves the selected user's approved app folder before creating cycle-owned scratch data. */
export async function openAppFolder(graph: GraphFileOperations, attempt: FileAttempt, signal: AbortSignal): Promise<OwnedFolderAttempt> {
  // AppFolder-only access need not permit reading the drive root; resolve through the approved user instead.
  const root = await graph.json(`/users/${encoded(attempt.probe.userId)}/drive/special/approot`,
    z.object({
      id: z.string().min(1), folder: z.object({}), specialFolder: z.object({ name: z.literal("approot") }),
      parentReference: z.object({ driveId: z.string().min(1) }),
    }), signal);
  if (attempt.driveId && root.parentReference.driveId !== attempt.driveId) throw new IntegrationError("configuration-failure");
  attempt.driveId = root.parentReference.driveId;
  attempt.parentId = root.id;
  return createAttemptFolder(graph, attempt, signal);
}
