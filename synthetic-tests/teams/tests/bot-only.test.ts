import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../utils/src/config.js";
import { probeSchema, probeServices, resultSchema, testTypes } from "../../utils/src/contracts.js";
import { parseProjectConfig, readProjectConfig } from "../../utils/src/project-config.js";
import { parseServiceFileConfig } from "../../utils/src/service-config.js";
import { teamsJourneyDefinitions } from "../src/catalog.js";

const project = await readProjectConfig("../monitoring.config.json");
const file = JSON.parse(readFileSync("teams/config.json", "utf8"));

describe("executable bot-only scope", () => {
  it("selects only the same-bot channel roundtrip and two-bot scheduled meeting", () => {
    expect(Object.keys(teamsJourneyDefinitions)).toEqual(["teams-channel-message", "teams-call"]);
    expect(project.services.teams.scenarios).toEqual({
      "channel-conversation": true, "scheduled-meeting": true,
    });
    expect(probeServices["teams-channel-message"]).toMatchObject({
      journey: "channel-conversation", entityName: "teams-global",
      steps: ["authenticate", "post-message", "confirm-publication", "post-reply", "confirm-reply", "cleanup"],
    });
    expect(probeServices["teams-call"].steps).toEqual([
      "authenticate", "place-call", "wait-for-answer", "verify-meeting-metadata",
      "verify-participants", "end-call", "cleanup",
    ]);
  });

  it.each(["user-delegated", "certificate", "cli", "default"])("rejects obsolete participant authentication %s", mode => {
    expect(() => parseServiceFileConfig({ ...file, teamsAuthentication: mode })).toThrow("teamsAuthentication");
    expect(() => parseServiceFileConfig({ ...file, botAuthentication: mode })).toThrow("botAuthentication");
    expect(() => loadConfig({ TEAMS_AUTHENTICATION: mode })).toThrow("TEAMS_AUTHENTICATION");
    expect(() => loadConfig({ BOT_AUTHENTICATION: mode })).toThrow("BOT_AUTHENTICATION");
  });

  it.each([
    "two-bot-conversation", "answered-audio", "recipient-file-sharing", "adaptive-card", "reply-channel-message",
  ])("rejects removed or misleading root scenario %s", scenario => {
    expect(() => parseProjectConfig({
      ...project, services: { ...project.services, teams: {
        ...project.services.teams, scenarios: { ...project.services.teams.scenarios, [scenario]: true },
      } },
    })).toThrow("services.teams.scenarios");
  });

  it.each([
    "teams-two-party-audio", "teams-file-sharing", "teams-adaptive-card", "teams-thread-reply",
    "sharepoint-file", "sharepoint-rename", "onedrive-sharing", "onedrive-search",
  ])("rejects removed test type %s at runtime and report boundaries", type => {
    expect(testTypes).not.toContain(type);
    expect(probeSchema.safeParse({ id: "removed", cohort: "teams-global", type }).success).toBe(false);
    expect(resultSchema.safeParse({
      schemaVersion: "2.0", testType: type, testId: "removed", targetService: "Microsoft Teams",
      success: false, durationMs: 1, observedAt: new Date().toISOString(),
      correlationId: "11111111-1111-4111-8111-111111111111",
    }).success).toBe(false);
  });

  it("has no unused prototypes, delegated bootstrap, token cache, SharePoint project or capability stubs", () => {
    for (const path of [
      "teams/src/audio.ts", "teams/src/card.ts", "teams/src/capabilities.ts", "teams/src/activities.ts",
      "teams/src/files.ts", "teams/src/bootstrap.ts", "utils/src/teams-user.ts", "utils/src/teams-user-auth.ts",
      "utils/src/teams-call-media.ts",
      "sharepoint/src/worker.ts", "../health-model/infra/planned-catalog.bicep",
    ]) expect(existsSync(path)).toBe(false);
    for (const name of ["conversation", "call"]) {
      expect(readFileSync(`teams/src/${name}.ts`, "utf8")).not.toMatch(/failUnsupportedAssertion|teams-unsupported-assertion/);
    }
  });
});
