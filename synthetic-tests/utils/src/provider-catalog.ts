import { activityCatalog, type ActivityFunction } from "./catalog.js";
export { activityFunctionNames, activityFunctions } from "./catalog.js";
export type { ActivityFunction } from "./catalog.js";

export function isPercentageActivity(name: ActivityFunction): boolean {
  return activityCatalog[name].unit === "Percent";
}
