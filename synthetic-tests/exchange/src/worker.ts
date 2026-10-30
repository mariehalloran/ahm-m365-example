import { runServiceCommand } from "../../utils/src/execution/command.js";
import { dispatchProbeHandlers } from "../../utils/src/execution/probes.js";
import { exchangeDraftProbe } from "./draft-journey.js";
import { exchangeProbe } from "./journey.js";
import { exchangeProviders } from "./providers.js";
import {
  exchangeAttachmentProbe,
  exchangeRecurringProbe,
  exchangeReplyProbe,
} from "./extended-journeys.js";

/**
 * Starts the Exchange synthetic monitoring worker CLI with all supported journey handlers
 * and external provider collectors registered.
 */
async function runExchangeWorker(argv: string[]): Promise<void> {
  const probeDispatcher = dispatchProbeHandlers({
    "exchange-mail-flow": exchangeProbe,
    "exchange-draft": exchangeDraftProbe,
    "exchange-attachment": exchangeAttachmentProbe,
    "exchange-reply": exchangeReplyProbe,
    "exchange-recurring-calendar": exchangeRecurringProbe,
  });
  await runServiceCommand("exchange", probeDispatcher, argv, exchangeProviders);
}

await runExchangeWorker(process.argv.slice(2));
