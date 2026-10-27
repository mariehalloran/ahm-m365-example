import { describe, expect, it } from "vitest";
import { probeServices } from "../../utils/src/contracts.js";
import { executionLanes } from "../../utils/src/execution-lanes.js";
import { parseServiceConfig, readServiceConfig, serviceProbes } from "../../utils/src/service-config.js";

const families = {
  "send-receive-mail": "exchange-mail-flow",
  "edit-reopen-draft": "exchange-draft",
  "attachment-mail": "exchange-attachment",
  "reply-mail": "exchange-reply",
  "distribution-list-mail": "exchange-distribution-list",
  "recurring-calendar": "exchange-recurring-calendar",
  "meeting-invitation": "exchange-meeting",
} as const;
const selected = Object.fromEntries(Object.keys(families).map(journey => [journey, true]));
const accounts = ["first@example.invalid", "second@example.invalid"];
const targets = accounts.map((mailbox, index) => ({
  id: `exchange-pair-${index}`, mailbox, recipientMailbox: accounts[1 - index],
  distributionList: { address: "synthetic-list@example.invalid", expectedRecipients: accounts },
}));

describe("Exchange focused journey execution selection", () => {
  it.each(["exchange/config.json", "exchange/config.live.example.json"])(
    "runs all selected account pairs for seven journeys with independent 60/300-second lanes in %s", async path => {
      const service = parseServiceConfig({ ...await readServiceConfig(path), enabled: true, targets });
      const probes = serviceProbes(service, selected);
      expect(probes).toHaveLength(14);
      expect(new Set(probes.map(probe => probe.type))).toEqual(new Set(Object.values(families)));
      for (const [journey, type] of Object.entries(families)) {
        expect(probeServices[type].journey).toBe(journey);
        expect(probes.filter(probe => probe.type === type).map(probe => probe.mailbox)).toEqual(accounts);
        expect(probes.filter(probe => probe.type === type).map(probe => probe.recipientMailbox)).toEqual([...accounts].reverse());
      }
      const lanes = executionLanes(service);
      expect(lanes).toHaveLength(2);
      expect(lanes[0]).toMatchObject({ name: "mail", intervalSeconds: 60, journeys: ["send-receive-mail"] });
      expect(lanes[1]).toMatchObject({ name: "extended", intervalSeconds: 300 });
      expect(new Set(lanes[1]!.journeys)).toEqual(new Set(Object.keys(families).filter(name => name !== "send-receive-mail")));
      expect(lanes.flatMap(lane => lane.journeys)).toHaveLength(7);
    },
  );
  it("honors root scenario deselection for every account without silently restoring a core or optional variant", async () => {
    const service = parseServiceConfig({ ...await readServiceConfig("exchange/config.json"), enabled: true, targets });
    const probes = serviceProbes(service, { ...selected, "recurring-calendar": false });
    expect(probes).toHaveLength(12);
    expect(probes.some(probe => probe.type === "exchange-recurring-calendar")).toBe(false);
    expect(serviceProbes(service, {})).toEqual([]);
  });
});
