import { runServiceCommand } from "../../utils/src/command.js";
import { dispatchProbeHandlers } from "../../utils/src/probes.js";
import { exchangeDraftProbe } from "./draft-journey.js";
import { exchangeProbe } from "./journey.js";
import { exchangeProviders } from "./providers.js";
import { exchangeAttachmentProbe, exchangeDistributionProbe, exchangeMeetingProbe, exchangeRecurringProbe } from "./extended-journeys.js";

await runServiceCommand("exchange", dispatchProbeHandlers({
  "exchange-mail-flow": exchangeProbe,
  "exchange-draft": exchangeDraftProbe,
  "exchange-attachment-reply": exchangeAttachmentProbe,
  "exchange-distribution-list": exchangeDistributionProbe,
  "exchange-recurring-calendar": exchangeRecurringProbe,
  "exchange-meeting": exchangeMeetingProbe,
}), process.argv.slice(2), exchangeProviders);
