import { z } from "zod";
import { readProjectDocument, serviceTypes, type ProjectDocument } from "../../utils/src/configuration/project-config.js";
import { ConfigurationError } from "../../utils/src/configuration/config.js";
import { canonicalProjectFile } from "../../utils/src/paths.js";

let snapshot: Promise<ProjectDocument> | undefined;
const serviceSuffix = { exchange: "ex", teams: "tm", onedrive: "od", sharepoint: "sp" } as const;

/** Loads one immutable, hash-verified root snapshot using the Function host's selected managed identity. */
export function runtimeDocument(): Promise<ProjectDocument> {
  const file = process.env.AZURE_FUNCTIONS_ENVIRONMENT === "Development"
    ? process.env.MONITORING_CONFIG_FILE ?? canonicalProjectFile : canonicalProjectFile;
  snapshot ??= readProjectDocument(file).then(document => {
    const expectedApp = process.env.MONITORING_ROLE === "watchdog"
      ? `${document.deployment?.functions.appName.slice(0, 54)}-watch`
      : (() => {
        const service = z.enum(serviceTypes).parse(process.env.MONITORING_SERVICE);
        return `${document.deployment?.functions.appName.slice(0, 57)}-${serviceSuffix[service]}`;
      })();
    if (!document.deployment || expectedApp !== process.env.FUNCTION_APP_NAME) {
      throw new ConfigurationError("The root snapshot does not match this Function app");
    }
    z.string().regex(/^[a-f0-9]{64}$/).parse(process.env.MONITORING_CONFIG_SHA256);
    return document;
  });
  return snapshot;
}

/** Selects registered journey/provider handlers without importing any command-line entrypoint. */
export async function serviceHandlers(service: "exchange" | "teams" | "onedrive" | "sharepoint") {
  switch (service) {
    case "exchange": return import("../../exchange/src/index.js");
    case "teams": return import("../../teams/src/index.js");
    case "onedrive": return import("../../onedrive/src/index.js");
    case "sharepoint": return import("../../sharepoint/src/index.js");
  }
}
