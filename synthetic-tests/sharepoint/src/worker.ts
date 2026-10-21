import { runServiceCommand } from "../../utils/src/command.js";
import { dispatchProbeHandlers } from "../../utils/src/probes.js";
import { sharepointProbe } from "./journey.js";
import { sharepointProviders } from "./providers.js";
import { sharepointRenameProbe } from "./rename-journey.js";

await runServiceCommand("sharepoint", dispatchProbeHandlers({
  "sharepoint-file": sharepointProbe,
  "sharepoint-rename": sharepointRenameProbe,
}), process.argv.slice(2), sharepointProviders);
