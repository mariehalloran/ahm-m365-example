import { runServiceCommand } from "../../utils/src/command.js";
import { exchangeProbe } from "./journey.js";
import { exchangeProviders } from "./providers.js";

await runServiceCommand("exchange", exchangeProbe, process.argv.slice(2), exchangeProviders);
