import { runServiceCommand } from "../../utils/src/command.js";
import { oneDriveProbe } from "./journey.js";

await runServiceCommand("onedrive", oneDriveProbe, process.argv.slice(2));
