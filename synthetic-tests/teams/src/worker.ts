import { runServiceCommand } from "../../utils/src/execution/command.js";
import { dispatchProbeHandlers } from "../../utils/src/execution/probes.js";
import { teamsConversationProbe } from "./conversation.js";
import { teamsProviders } from "./providers.js";
import { teamsCallProbe } from "./call.js";

await runServiceCommand("teams", dispatchProbeHandlers({
  "teams-channel-message": teamsConversationProbe,
  "teams-call": teamsCallProbe,
}), process.argv.slice(2), teamsProviders);
