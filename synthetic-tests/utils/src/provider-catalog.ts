export const activityFunctionNames = [
  "getConnectivityMetricsForExchange",
  "getMessageVolumeMetricsForEmailDelivery",
  "getActiveUserMetricsForOutlookWebByReadEmail",
  "getActiveUserMetricsForOutlookWebByAppOpening",
  "getActiveUserMetricsForEmailByModernAuthentication",
  "getUsageMetricsForTeamsByMeetingsJoined",
  "getUsageMetricsForTeamsByLaunch",
  "getMessageVolumeMetricsForTeamsChat",
  "getAudioStreamQoEMetricsForTeams",
  "getAudioStreamsOverUdpMetricsForTeams",
] as const;
export type ActivityFunction = (typeof activityFunctionNames)[number];
export const activityFunctions = {
  exchange: activityFunctionNames.slice(0, 5),
  teams: activityFunctionNames.slice(5),
  sharepoint: [],
  onedrive: [],
} as const;
export function isPercentageActivity(name: ActivityFunction): boolean {
  return ["getConnectivityMetricsForExchange", "getAudioStreamQoEMetricsForTeams", "getAudioStreamsOverUdpMetricsForTeams"].includes(name);
}
