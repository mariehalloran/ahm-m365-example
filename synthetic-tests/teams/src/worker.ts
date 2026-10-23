import { runServiceCommand } from "../../utils/src/command.js";
import { dispatchProbeHandlers } from "../../utils/src/probes.js";
import { teamsProbe, teamsReplyProbe } from "./journey.js";
import { teamsProviders } from "./providers.js";
import { teamsCallProbe } from "./call.js";

await runServiceCommand("teams", dispatchProbeHandlers({
  "teams-channel-message": teamsProbe,
  "teams-channel-reply": teamsReplyProbe,
  "teams-call": teamsCallProbe,
}), process.argv.slice(2), teamsProviders);
