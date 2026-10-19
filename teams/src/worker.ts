import { runServiceCommand } from "../../utils/src/command.js";
import { teamsProbe } from "./journey.js";

await runServiceCommand("teams", teamsProbe);
