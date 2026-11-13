import { dispatchProbeHandlers } from "../../utils/src/execution/probes.js";
import { exchangeProbe } from "./journey.js";
import { exchangeAttachmentProbe, exchangeRecurringProbe, exchangeReplyProbe } from "./extended-journeys.js";

export { exchangeProviders as providers } from "./providers.js";
export const handler = dispatchProbeHandlers({
  "exchange-mail-flow": exchangeProbe,
  "exchange-attachment": exchangeAttachmentProbe,
  "exchange-reply": exchangeReplyProbe,
  "exchange-recurring-calendar": exchangeRecurringProbe,
});
