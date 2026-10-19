import { runServiceCommand } from "../../utils/src/command.js";
import { sharepointProbe } from "./journey.js";

await runServiceCommand("sharepoint", sharepointProbe);
