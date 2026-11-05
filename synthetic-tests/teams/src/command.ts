import { runServiceCommand } from "../../utils/src/execution/command.js";
import { handler, providers } from "./index.js";

await runServiceCommand("teams", handler, process.argv.slice(2), providers);
