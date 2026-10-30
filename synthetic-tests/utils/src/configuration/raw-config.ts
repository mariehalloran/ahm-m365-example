// Lenient navigation of raw config JSON: anything that is not the expected shape is skipped and left for the config schema to report.

/** Checks whether an unknown value is a non-null plain object record (and not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Safely walks a sequence of property names through nested object records, returning undefined if any segment is missing. */
export function at(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const name of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[name];
  }
  return current;
}

/** Returns only the plain object records from an array value, or an empty array when the input is not an array. */
export function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}
