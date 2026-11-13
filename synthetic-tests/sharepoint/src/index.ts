import { dispatchProbeHandlers } from "../../utils/src/execution/probes.js";
import { sharePointDocumentProbe } from "./document-journey.js";
import { sharePointListProbe } from "./list-journey.js";

export { sharePointProviders as providers } from "./providers.js";
export const handler = dispatchProbeHandlers({
  "sharepoint-roundtrip": sharePointDocumentProbe,
  "sharepoint-list-item": sharePointListProbe,
});
