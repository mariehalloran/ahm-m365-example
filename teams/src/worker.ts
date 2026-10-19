import { runServiceCommand } from "../../utils/src/command.js";
import { teamsProbe } from "./journey.js";
import { teamsProviders } from "./providers.js";

await runServiceCommand("teams", teamsProbe, process.argv.slice(2), teamsProviders);
