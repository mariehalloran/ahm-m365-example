import { runServiceCommand } from "../../utils/src/command.js";
import { oneDriveProbe } from "./journey.js";
import { oneDriveProviders } from "./providers.js";

await runServiceCommand("onedrive", oneDriveProbe, process.argv.slice(2), oneDriveProviders);
