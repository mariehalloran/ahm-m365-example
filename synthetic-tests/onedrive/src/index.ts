import { dispatchProbeHandlers } from "../../utils/src/execution/probes.js";
import { oneDriveProbe } from "./journey.js";

export { oneDriveProviders as providers } from "./providers.js";
export const handler = dispatchProbeHandlers({
  "onedrive-roundtrip": oneDriveProbe,
  "onedrive-appfolder": oneDriveProbe,
});
