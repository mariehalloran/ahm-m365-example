import type { Probe } from "../../shared/src/contracts.js";
import type { ProbeHandler } from "../../shared/src/probes.js";
import { exchangeProbe } from "../exchange/src/probe.js";
import { sharepointProbe } from "../sharepoint/src/probe.js";

export const handlers: Readonly<Record<Probe["type"], ProbeHandler>> = {
  "exchange-mail-flow": exchangeProbe,
  "sharepoint-file": sharepointProbe,
};
