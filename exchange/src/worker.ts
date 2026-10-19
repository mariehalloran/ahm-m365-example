import { runServiceCommand } from "../../utils/src/command.js";
import { exchangeProbe } from "./journey.js";

await runServiceCommand("exchange", exchangeProbe);
