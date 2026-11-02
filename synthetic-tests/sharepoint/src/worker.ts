import { runServiceCommand } from "../../utils/src/execution/command.js";
import { dispatchProbeHandlers } from "../../utils/src/execution/probes.js";
import { sharePointDocumentProbe } from "./document-journey.js";
import { sharePointListProbe } from "./list-journey.js";
import { sharePointProviders } from "./providers.js";

await runServiceCommand("sharepoint", dispatchProbeHandlers({
  "sharepoint-roundtrip": sharePointDocumentProbe,
  "sharepoint-versions": sharePointDocumentProbe,
  "sharepoint-list-item": sharePointListProbe,
}), process.argv.slice(2), sharePointProviders);
