import { runServiceCommand } from "../../utils/src/command.js";
import { dispatchProbeHandlers } from "../../utils/src/probes.js";
import { exchangeDraftProbe } from "./draft-journey.js";
import { exchangeProbe } from "./journey.js";
import { exchangeProviders } from "./providers.js";
import { exchangeAttachmentProbe, exchangeRecurringProbe, exchangeReplyProbe } from "./extended-journeys.js";

await runServiceCommand("exchange", dispatchProbeHandlers({
  "exchange-mail-flow": exchangeProbe,
  "exchange-draft": exchangeDraftProbe,
  "exchange-attachment": exchangeAttachmentProbe,
  "exchange-reply": exchangeReplyProbe,
  "exchange-recurring-calendar": exchangeRecurringProbe,
}), process.argv.slice(2), exchangeProviders);
