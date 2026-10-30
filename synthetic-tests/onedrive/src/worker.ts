import { runServiceCommand } from "../../utils/src/execution/command.js";
import { oneDriveProbe } from "./journey.js";
import { oneDriveProviders } from "./providers.js";
import { dispatchProbeHandlers } from "../../utils/src/execution/probes.js";

await runServiceCommand("onedrive", dispatchProbeHandlers({
  "onedrive-roundtrip": oneDriveProbe,
  "onedrive-appfolder": oneDriveProbe,
  "onedrive-versions": oneDriveProbe,
}), process.argv.slice(2), oneDriveProviders);
