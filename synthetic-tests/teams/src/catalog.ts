export const teamsJourneyDefinitions = {
  "teams-channel-message": {
    service: "teams", target: "Microsoft Teams", journey: "channel-conversation", entityName: "teams-global",
    steps: ["authenticate", "post-message", "confirm-publication", "post-reply", "confirm-reply", "cleanup"],
  },
  "teams-call": {
    service: "teams", target: "Microsoft Teams", journey: "scheduled-meeting", entityName: "teams-call",
    steps: ["authenticate", "place-call", "wait-for-answer", "verify-meeting-metadata", "verify-participants", "play-audio", "end-call", "cleanup"],
  },
} as const;
