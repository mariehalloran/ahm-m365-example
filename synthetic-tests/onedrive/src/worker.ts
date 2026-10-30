import { runServiceCommand } from "../../utils/src/command.js";
import { oneDriveProbe } from "./journey.js";
import { oneDriveProviders } from "./providers.js";
import { dispatchProbeHandlers } from "../../utils/src/probes.js";

await runServiceCommand("onedrive", dispatchProbeHandlers({
  "onedrive-roundtrip": oneDriveProbe,
  "onedrive-appfolder": oneDriveProbe,
  "onedrive-versions": oneDriveProbe,
}), process.argv.slice(2), oneDriveProviders);
