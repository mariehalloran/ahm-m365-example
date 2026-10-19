import { runServiceCommand } from "../../utils/src/command.js";
import { sharepointProbe } from "./journey.js";
import { sharepointProviders } from "./providers.js";

await runServiceCommand("sharepoint", sharepointProbe, process.argv.slice(2), sharepointProviders);
