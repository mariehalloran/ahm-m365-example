import { dispatchProbeHandlers } from "../../utils/src/execution/probes.js";
import { teamsConversationProbe } from "./conversation.js";
import { teamsCallProbe } from "./call.js";

export { teamsProviders as providers } from "./providers.js";
export const handler = dispatchProbeHandlers({
  "teams-channel-message": teamsConversationProbe,
  "teams-call": teamsCallProbe,
});
