/**
 * Serialization helpers for Firestore values returned by the API.
 * Timestamps are emitted as ISO-8601 strings (or null when unset) so that
 * JSON responses are stable across SDK versions.
 */

interface ToMillisLike {
  toMillis(): number;
}

function isToMillisLike(value: unknown): value is ToMillisLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToMillisLike).toMillis === 'function'
  );
}

/** Converts a Firestore Timestamp / Date / epoch-ms value to milliseconds. */
export function timestampMs(value: unknown): number | null {
  if (isToMillisLike(value)) {
    return value.toMillis();
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

/** Converts a stored timestamp to an ISO-8601 string, or null if unset. */
export function toIso(value: unknown): string | null {
  const millis = timestampMs(value);
  return millis === null ? null : new Date(millis).toISOString();
}
