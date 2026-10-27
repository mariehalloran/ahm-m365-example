export const serviceCatalog = {
  exchange: { target: "Exchange Online", displayName: "Exchange Experience" },
  teams: { target: "Microsoft Teams", displayName: "Teams Experience" },
  onedrive: { target: "OneDrive for Business", displayName: "OneDrive Experience" },
} as const;

const exchangeMailGroup = { entityName: "exchange-mail", displayName: "Mail" } as const;
const exchangeCalendarGroup = { entityName: "exchange-calendar", displayName: "Calendar" } as const;

export const journeyCatalog = {
  "exchange-mail-flow": {
    service: "exchange", journey: "send-receive-mail", entityName: "exchange-global",
    displayName: "Send and receive email", group: exchangeMailGroup,
    steps: {
      "create-draft": { displayName: "Create email" },
      send: { displayName: "Send email" },
      "confirm-delivery": { displayName: "Confirm delivery" },
    },
  },
  "exchange-draft": {
    service: "exchange", journey: "edit-reopen-draft", entityName: "exchange-draft",
    displayName: "Save, edit and reopen draft", group: exchangeMailGroup,
    steps: {
      "create-draft": { displayName: "Create draft" },
      "read-initial-draft": { displayName: "Read saved draft" },
      "update-draft": { displayName: "Edit draft" },
      "read-draft": { displayName: "Reopen and verify draft" },
      "delete-draft": { displayName: "Delete draft" },
    },
  },
  "exchange-attachment": {
    service: "exchange", journey: "attachment-mail", entityName: "exchange-attachment",
    displayName: "Send and verify attachment", group: exchangeMailGroup,
    steps: {
      "send-attachment": { displayName: "Send attachment" },
      "verify-attachment": { displayName: "Verify delivered attachment hash" },
    },
  },
  "exchange-reply": {
    service: "exchange", journey: "reply-mail", entityName: "exchange-reply",
    displayName: "Reply to a received message and verify delivery", group: exchangeMailGroup,
    steps: {
      "reply-mail": { displayName: "Reply to retained received message" },
      "confirm-reply-mail": { displayName: "Verify correlated reply at sender" },
    },
  },
  "exchange-distribution-list": {
    service: "exchange", journey: "distribution-list-mail", entityName: "exchange-distribution",
    displayName: "Deliver through distribution list", group: exchangeMailGroup,
    steps: {
      "send-group-mail": { displayName: "Send to distribution list" },
      "confirm-group-delivery": { displayName: "Verify every expected recipient" },
    },
  },
  "exchange-recurring-calendar": {
    service: "exchange", journey: "recurring-calendar", entityName: "exchange-recurring",
    displayName: "Create, edit and remove recurring calendar event", group: exchangeCalendarGroup,
    steps: {
      "create-event": { displayName: "Create recurring series" },
      "read-occurrence": { displayName: "Read occurrence" },
      "update-event": { displayName: "Update recurring series" },
      "verify-event": { displayName: "Verify series and occurrence update" },
      "delete-event": { displayName: "Delete recurring series" },
    },
  },
  "exchange-meeting": {
    service: "exchange", journey: "meeting-invitation", entityName: "exchange-meeting",
    displayName: "Invite, accept and cancel meeting", group: exchangeCalendarGroup,
    steps: {
      "create-meeting": { displayName: "Send meeting invitation" },
      "confirm-invitation": { displayName: "Read attendee invitation" },
      "verify-attendee-calendar": { displayName: "Verify attendee calendar event" },
      "accept-meeting": { displayName: "Accept as attendee" },
      "confirm-acceptance": { displayName: "Observe acceptance as organizer" },
      "cancel-meeting": { displayName: "Cancel as organizer" },
    },
  },
  "teams-channel-message": {
    service: "teams", journey: "channel-conversation", entityName: "teams-global",
    displayName: "Post, read back and reply in a channel as a bot",
    steps: {
      "post-message": { displayName: "Post root as the selected bot" },
      "confirm-publication": { displayName: "Verify persisted root author and correlation" },
      "post-reply": { displayName: "Reply in the thread as the same bot" },
      "confirm-reply": { displayName: "Verify persisted reply author and correlation" },
    },
  },
  "teams-call": {
    service: "teams", journey: "scheduled-meeting", entityName: "teams-call",
    displayName: "Join a scheduled meeting, verify metadata and rosters, and leave",
    steps: {
      "place-call": { displayName: "Join dedicated meeting as two distinct bots" },
      "wait-for-answer": { displayName: "Verify both owned calls established" },
      "verify-meeting-metadata": { displayName: "Verify dedicated meeting metadata" },
      "verify-participants": { displayName: "Verify both bot identities in both meeting rosters" },
      "end-call": { displayName: "Leave both owned calls and verify disconnected" },
    },
  },
  "onedrive-roundtrip": {
    service: "onedrive", journey: "user-drive-roundtrip", entityName: "onedrive-planned-user-drive-roundtrip",
    displayName: "Create, reopen, verify and delete user-drive file",
    steps: {
      "create-folder-file": { entityName: "step-1", displayName: "Create owned folder and file in selected folder" },
      "reopen-file": { entityName: "step-2", displayName: "Enumerate and download owned file" },
      "verify-file-hash": { entityName: "step-3", displayName: "Verify exact content hash" },
      "delete-owned-artifacts": { entityName: "step-4", displayName: "Delete owned artifacts and verify removal" },
    },
  },
  "onedrive-appfolder": {
    service: "onedrive", journey: "app-folder-lifecycle", entityName: "onedrive-planned-app-folder-lifecycle",
    displayName: "Write, read, update and delete app-folder data",
    steps: {
      "write-app-data": { entityName: "step-1", displayName: "Create cycle-owned folder and app data" },
      "read-app-data": { entityName: "step-2", displayName: "Read and verify data" },
      "update-app-data": { entityName: "step-3", displayName: "Update, reread and verify persisted state" },
      "delete-app-scratch": { entityName: "step-4", displayName: "Delete cycle-owned folder and verify removal" },
    },
  },
  "onedrive-versions": {
    service: "onedrive", journey: "document-versions", entityName: "onedrive-planned-document-versions",
    displayName: "Update document and retrieve prior version",
    steps: {
      "update-document": { entityName: "step-1", displayName: "Write and verify two document revisions" },
      "list-versions": { entityName: "step-2", displayName: "Enumerate actual document version history" },
      "read-prior-version": { entityName: "step-3", displayName: "Download prior version and verify bytes" },
      "restore-version": { entityName: "step-4", displayName: "Optional: restore downloaded prior bytes and verify" },
    },
  },
} as const;

export const activityCatalog = {
  getConnectivityMetricsForExchange: { service: "exchange", unit: "Percent" },
  getMessageVolumeMetricsForEmailDelivery: { service: "exchange", unit: "Count" },
  getActiveUserMetricsForOutlookWebByReadEmail: { service: "exchange", unit: "Count" },
  getActiveUserMetricsForOutlookWebByAppOpening: { service: "exchange", unit: "Count" },
  getActiveUserMetricsForEmailByModernAuthentication: { service: "exchange", unit: "Count" },
  getUsageMetricsForTeamsByMeetingsJoined: { service: "teams", unit: "Count" },
  getUsageMetricsForTeamsByLaunch: { service: "teams", unit: "Count" },
  getMessageVolumeMetricsForTeamsChat: { service: "teams", unit: "Count" },
  getAudioStreamQoEMetricsForTeams: { service: "teams", unit: "Percent" },
  getAudioStreamsOverUdpMetricsForTeams: { service: "teams", unit: "Percent" },
} as const satisfies Record<string, { service: CatalogService; unit: "Count" | "Percent" }>;

type Journeys = typeof journeyCatalog;
export type CatalogService = keyof typeof serviceCatalog;
type TargetService = (typeof serviceCatalog)[CatalogService]["target"];
export type TestType = keyof Journeys;
export type StepName = "authenticate" | "cleanup" | {
  [T in TestType]: keyof Journeys[T]["steps"];
}[TestType];
export type ActivityFunction = keyof typeof activityCatalog;

export const testTypes: readonly [TestType, ...TestType[]] = Object.keys(journeyCatalog) as [TestType, ...TestType[]];
export const targetServices: readonly [TargetService, ...TargetService[]] =
  Object.values(serviceCatalog).map(service => service.target) as [TargetService, ...TargetService[]];
export const activityFunctionNames: readonly [ActivityFunction, ...ActivityFunction[]] =
  Object.keys(activityCatalog) as [ActivityFunction, ...ActivityFunction[]];

type ProbeServices = {
  readonly [T in TestType]: {
    readonly service: Journeys[T]["service"];
    readonly target: (typeof serviceCatalog)[Journeys[T]["service"]]["target"];
    readonly journey: Journeys[T]["journey"];
    readonly entityName: Journeys[T]["entityName"];
    readonly steps: readonly ("authenticate" | "cleanup" | keyof Journeys[T]["steps"])[];
  };
};
export const probeServices = Object.fromEntries(Object.entries(journeyCatalog).map(([type, journey]) => [
  type, {
    service: journey.service, target: serviceCatalog[journey.service].target,
    journey: journey.journey, entityName: journey.entityName,
    steps: ["authenticate", ...Object.keys(journey.steps), "cleanup"] as readonly StepName[],
  },
] as const)) as ProbeServices;
export const stepNames: readonly [StepName, ...StepName[]] =
  [...new Set(testTypes.flatMap<StepName>(type => probeServices[type].steps))] as [StepName, ...StepName[]];

export const journeyStepEntities: Partial<Record<TestType, Readonly<Record<string, string>>>> =
  Object.fromEntries(Object.entries(journeyCatalog).flatMap(([type, journey]) => {
    const aliases = Object.fromEntries(Object.entries(journey.steps).flatMap(([name, step]) =>
      "entityName" in step ? [[name, step.entityName] as const] : []));
    return Object.keys(aliases).length ? [[type, aliases] as const] : [];
  }));

export function serviceJourneys<S extends CatalogService>(service: S) {
  return Object.fromEntries(Object.entries(probeServices).filter(([, journey]) => journey.service === service)) as {
    readonly [T in TestType as Journeys[T]["service"] extends S ? T : never]: ProbeServices[T];
  };
}

export const activityFunctions = Object.fromEntries<readonly ActivityFunction[]>(Object.keys(serviceCatalog).map(service => [
  service, activityFunctionNames.filter(name => activityCatalog[name].service === service),
] as const)) as Readonly<Record<CatalogService, readonly ActivityFunction[]>>;

export const modelCatalog = {
  serviceDefinitions: Object.entries(serviceCatalog).map(([service, metadata]) => ({
    service, displayName: metadata.displayName,
    journeys: Object.values(journeyCatalog).filter(journey => journey.service === service).map(journey => ({
      name: journey.journey, entityName: journey.entityName, displayName: journey.displayName,
      ...("group" in journey ? { group: journey.group } : {}),
      steps: Object.entries(journey.steps).map(([name, step]) => ({
        name: "entityName" in step ? step.entityName : name, displayName: step.displayName,
        ...("entityName" in step ? { telemetryName: name } : {}),
      })),
    })),
  })),
  providerActivityFunctions: activityFunctions,
};
