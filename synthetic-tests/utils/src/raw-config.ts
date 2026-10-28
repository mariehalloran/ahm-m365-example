// Lenient navigation of raw config JSON: anything that is not the expected shape is skipped and left for the config schema to report.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce((current, name) => isRecord(current) ? current[name] : undefined, value);
export const records = (value: unknown) => Array.isArray(value) ? value.filter(isRecord) : [];
